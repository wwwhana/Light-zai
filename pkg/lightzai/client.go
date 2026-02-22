package lightzai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	APIKey       string
	Model        string
	BaseURL      string
	APIPrefix    string
	MaxTokens    int
	Temperature  float64
	Timeout      time.Duration
	MaxHistory   int
	ScreenWidth  int
	ScreenHeight int
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Client struct {
	cfg        Config
	httpClient *http.Client
}

type savedConfig struct {
	APIKey      string  `json:"apiKey"`
	Model       string  `json:"model"`
	BaseURL     string  `json:"baseUrl"`
	APIPrefix   string  `json:"apiPrefix"`
	MaxTokens   int     `json:"maxTokens"`
	Temperature float64 `json:"temperature"`
}

func loadSavedConfig() savedConfig {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return savedConfig{}
	}
	p := filepath.Join(home, ".config", "light-zai", "config.json")
	b, err := os.ReadFile(p)
	if err != nil {
		return savedConfig{}
	}
	var cfg savedConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		return savedConfig{}
	}
	return cfg
}

func envInt(name string, def int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func envFloat(name string, def float64) float64 {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return n
}

func detectTotalMemoryMB() int {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0
		}
		kib, err := strconv.Atoi(fields[1])
		if err != nil {
			return 0
		}
		if kib <= 0 {
			return 0
		}
		return kib / 1024
	}
	return 0
}

func dynamicTokenLimit(totalMemMB int) int {
	switch {
	case totalMemMB > 0 && totalMemMB <= 128:
		return 1024
	case totalMemMB > 0 && totalMemMB <= 256:
		return 2048
	default:
		return 4096
	}
}

func dynamicMaxHistory(totalMemMB int) int {
	switch {
	case totalMemMB > 0 && totalMemMB <= 128:
		return 8
	case totalMemMB > 0 && totalMemMB <= 256:
		return 12
	default:
		return 20
	}
}

func DefaultConfigFromEnv() Config {
	saved := loadSavedConfig()
	apiKey := os.Getenv("ZAI_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("LZAI_API_KEY")
	}
	if apiKey == "" {
		apiKey = saved.APIKey
	}
	model := os.Getenv("LZAI_MODEL")
	if model == "" {
		model = saved.Model
	}
	if model == "" {
		model = "glm-5"
	}
	base := os.Getenv("LZAI_BASE_URL")
	if base == "" {
		base = saved.BaseURL
	}
	if base == "" {
		base = "api.z.ai"
	}
	prefix := os.Getenv("LZAI_API_PREFIX")
	if prefix == "" {
		prefix = saved.APIPrefix
	}
	if prefix == "" {
		prefix = "/api/paas/v4"
	}

	totalMemMB := detectTotalMemoryMB()
	defaultTokens := dynamicTokenLimit(totalMemMB)
	if saved.MaxTokens > 0 {
		defaultTokens = saved.MaxTokens
	}
	maxTokens := envInt("LZAI_MAX_TOKENS", defaultTokens)
	if maxTokens <= 0 {
		maxTokens = dynamicTokenLimit(totalMemMB)
	}
	defaultTemp := 0.7
	if saved.Temperature > 0 {
		defaultTemp = saved.Temperature
	}
	temp := envFloat("LZAI_TEMPERATURE", defaultTemp)
	if temp < 0 {
		temp = 0
	}
	if temp > 1 {
		temp = 1
	}
	timeoutSec := envInt("LZAI_TIMEOUT_SEC", 45)
	if timeoutSec <= 0 {
		timeoutSec = 45
	}
	maxHistory := envInt("LZAI_MAX_HISTORY", dynamicMaxHistory(totalMemMB))
	if maxHistory < 4 {
		maxHistory = 4
	}
	screenW := envInt("LZAI_SCREEN_WIDTH", 40)
	if screenW < 20 {
		screenW = 20
	}
	screenH := envInt("LZAI_SCREEN_HEIGHT", 20)
	if screenH < 8 {
		screenH = 8
	}
	return Config{
		APIKey:       apiKey,
		Model:        model,
		BaseURL:      base,
		APIPrefix:    prefix,
		MaxTokens:    maxTokens,
		Temperature:  temp,
		Timeout:      time.Duration(timeoutSec) * time.Second,
		MaxHistory:   maxHistory,
		ScreenWidth:  screenW,
		ScreenHeight: screenH,
	}
}

func NewClient(cfg Config) (*Client, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("ZAI_API_KEY (or LZAI_API_KEY) is required")
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 45 * time.Second
	}
	if cfg.MaxHistory < 4 {
		cfg.MaxHistory = 4
	}
	if cfg.ScreenWidth < 20 {
		cfg.ScreenWidth = 20
	}
	if cfg.ScreenHeight < 8 {
		cfg.ScreenHeight = 8
	}
	return &Client{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: cfg.Timeout},
	}, nil
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
	Temperature float64   `json:"temperature,omitempty"`
	Stream      bool      `json:"stream"`
}

type chatResponse struct {
	Choices []struct {
		Message Message `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (c *Client) Chat(ctx context.Context, messages []Message) (string, error) {
	url := fmt.Sprintf("https://%s%s/chat/completions", c.cfg.BaseURL, c.cfg.APIPrefix)
	payload := chatRequest{
		Model:       c.cfg.Model,
		Messages:    messages,
		MaxTokens:   c.cfg.MaxTokens,
		Temperature: c.cfg.Temperature,
		Stream:      false,
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var out chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Error != nil {
		return "", errors.New(out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return "", errors.New("empty response")
	}
	return out.Choices[0].Message.Content, nil
}

func wrapText(s string, width int) []string {
	if width < 1 {
		return []string{s}
	}
	var out []string
	for _, rawLine := range strings.Split(s, "\n") {
		line := rawLine
		for len(line) > width {
			out = append(out, line[:width])
			line = line[width:]
		}
		out = append(out, line)
	}
	if len(out) == 0 {
		return []string{""}
	}
	return out
}

func pagePrint(text string, width, height int, in *bufio.Scanner) {
	lines := wrapText(text, width)
	pageSize := height - 2
	if pageSize < 3 {
		pageSize = 3
	}
	for i := 0; i < len(lines); i++ {
		fmt.Println(lines[i])
		if (i+1)%pageSize == 0 && i+1 < len(lines) {
			fmt.Print("--More-- (Enter 계속, q 중단): ")
			if !in.Scan() {
				fmt.Println()
				return
			}
			ans := strings.TrimSpace(strings.ToLower(in.Text()))
			if ans == "q" || ans == "quit" {
				break
			}
		}
	}
}

func trimHistory(history []Message, max int) []Message {
	if len(history) <= max {
		return history
	}
	sys := history[0]
	tail := history[len(history)-(max-1):]
	return append([]Message{sys}, tail...)
}

func RunREPL(ctx context.Context, c *Client) error {
	fmt.Println("Light-zai Go (ARMv7/저메모리) — 종료: /exit, 초기화: /clear")
	s := bufio.NewScanner(os.Stdin)
	s.Buffer(make([]byte, 0, 4096), 1024*1024)
	history := []Message{{Role: "system", Content: "당신은 간결하고 정확한 코딩 도우미입니다."}}
	for {
		fmt.Print("you> ")
		if !s.Scan() {
			break
		}
		text := strings.TrimSpace(s.Text())
		if text == "" {
			continue
		}
		if text == "/exit" || text == "/quit" {
			return nil
		}
		if text == "/clear" {
			history = history[:1]
			fmt.Println("대화 기록을 초기화했습니다.")
			continue
		}
		history = append(history, Message{Role: "user", Content: text})
		history = trimHistory(history, c.cfg.MaxHistory)

		ans, err := c.Chat(ctx, history)
		if err != nil {
			errMsg := err.Error()
			lower := strings.ToLower(errMsg)
			if strings.Contains(lower, "insufficient balance") || strings.Contains(lower, "no resource package") {
				fmt.Println("error> 크레딧/리소스 패키지가 부족합니다.")
				fmt.Println("hint> ZAI 콘솔에서 잔액/패키지를 충전한 뒤 다시 시도하세요.")
				fmt.Println("hint> 키/엔드포인트 점검: ZAI_API_KEY, LZAI_BASE_URL, LZAI_API_PREFIX")
			} else {
				fmt.Println("error>", errMsg)
			}
			continue
		}
		fmt.Println("ai>")
		pagePrint(ans, c.cfg.ScreenWidth, c.cfg.ScreenHeight, s)
		history = append(history, Message{Role: "assistant", Content: ans})
		history = trimHistory(history, c.cfg.MaxHistory)
	}
	return s.Err()
}
