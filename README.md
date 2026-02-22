# Light-zai (Go)

ARMv7 포함 저사양 Linux 장비에서 돌아가도록 만든 경량 TTY 챗 CLI입니다.
이 저장소는 Node 버전에서 Go 버전으로 전환되었고, 현재 기본 실행 대상은 Go CLI입니다.

## 네임스페이스

Go 모듈 경로는 `github.com/wwwhana/light-zai` 입니다.

## 빠른 시작

```bash
# 1) API 키
export ZAI_API_KEY="your-api-key"

# 2) 실행 (REPL)
go run ./cmd/light-zai

# 3) 원샷 질의
go run ./cmd/light-zai "armv7에서 고루틴 스케줄러 특성 요약해줘"
```

## 메모리 기반 동적 설정

`LZAI_MAX_TOKENS` / `LZAI_MAX_HISTORY`를 직접 지정하지 않으면 `/proc/meminfo` 기준으로 자동 조절됩니다.

- `<= 128MB`: `max_tokens=1024`, `max_history=8`
- `<= 256MB`: `max_tokens=2048`, `max_history=12`
- 그 외/감지 실패: `max_tokens=4096`, `max_history=20`

필요하면 환경변수로 수동 고정할 수 있습니다.

## 소형 TTY 대응 (예: 320x320)

- 고정 폭 줄바꿈
- 페이지 출력 (`--More--`)
- `/clear`로 기록 초기화

긴 답변이 나와도 한 화면에서 유실되지 않도록 설계했습니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ZAI_API_KEY` | *(필수)* | API 키 |
| `LZAI_API_KEY` | 빈값 | `ZAI_API_KEY` 대체 키 |
| `LZAI_MODEL` | `glm-5` | 모델명 |
| `LZAI_BASE_URL` | `api.z.ai` | API 호스트 |
| `LZAI_API_PREFIX` | `/api/paas/v4` | API prefix |
| `LZAI_MAX_TOKENS` | 동적 | 응답 최대 토큰 |
| `LZAI_MAX_HISTORY` | 동적 | 대화 이력 길이 |
| `LZAI_TEMPERATURE` | `0.7` | 샘플링 온도 |
| `LZAI_TIMEOUT_SEC` | `45` | HTTP 타임아웃(초) |
| `LZAI_SCREEN_WIDTH` | `40` | TTY 줄바꿈 폭 |
| `LZAI_SCREEN_HEIGHT` | `20` | 페이지 높이 |

## ARMv7 빌드

```bash
GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o dist/light-zai-go-linux-armv7 ./cmd/light-zai
```

또는 멀티아키 빌드 스크립트:

```bash
./scripts/build-go.sh
```

## CI

GitHub Actions (`.github/workflows/go-build.yml`)에서 push/PR마다 `amd64`, `arm/v7`, `arm64` 빌드를 수행합니다.
