package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/wwwhana/light-zai/pkg/lightzai"
)

func main() {
	cfg := lightzai.DefaultConfigFromEnv()
	cli, err := lightzai.NewClient(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "설정 오류:", err)
		os.Exit(1)
	}

	ctx := context.Background()
	if len(os.Args) > 1 {
		q := strings.TrimSpace(strings.Join(os.Args[1:], " "))
		ans, err := cli.Chat(ctx, []lightzai.Message{
			{Role: "system", Content: cli.SystemPrompt()},
			{Role: "user", Content: q},
		})
		if err != nil {
			fmt.Fprintln(os.Stderr, "API 오류:", err)
			os.Exit(1)
		}
		fmt.Println(ans)
		return
	}

	if err := lightzai.RunREPL(ctx, cli); err != nil {
		fmt.Fprintln(os.Stderr, "REPL 오류:", err)
		os.Exit(1)
	}
}
