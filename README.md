# Light-zai (Go)

ARMv7 포함 저사양 Linux 장비에서 동작하는 경량 TTY 챗 CLI입니다.
현재 저장소 기준 실행 대상은 **Go 버전**입니다.

## 네임스페이스

Go 모듈 경로:

```txt
github.com/wwwhana/light-zai
```

## 빠른 시작

```bash
# 1) API 키
export ZAI_API_KEY="your-api-key"

# 2) REPL 실행
go run ./cmd/light-zai

# 3) 원샷 질의
go run ./cmd/light-zai "armv7에서 고루틴 스케줄러 특성 요약해줘"
```

## 메모리 기반 동적 기본값

`LZAI_MAX_TOKENS`, `LZAI_MAX_HISTORY`를 직접 지정하지 않으면 `/proc/meminfo`(`MemTotal`) 기준으로 자동 조정됩니다.

- `<= 128MB`: `max_tokens=1024`, `max_history=8`
- `<= 256MB`: `max_tokens=2048`, `max_history=12`
- 그 외 / 감지 실패: `max_tokens=4096`, `max_history=20`

> 환경변수를 지정하면 수동 설정값이 우선합니다.

## 소형 TTY 대응 (예: 320x320)

- 폭 기준 줄바꿈
- 페이지 출력 (`--More--`)
- `/clear`로 대화 기록 초기화

긴 응답도 한 화면에 묻히지 않도록 설계되어 있습니다.

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
| `~/.config/light-zai/config.json` | 선택 | JS 버전과 동일한 설정 파일. Go도 `apiKey/model/baseUrl/apiPrefix/maxTokens/temperature`를 기본값으로 읽음(환경변수가 우선). |

## 빌드

### ARMv7 단일 빌드

```bash
GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o dist/light-zai-go-linux-armv7 ./cmd/light-zai
```

### 멀티아키 로컬 빌드

```bash
./scripts/build-go.sh
```

## CI / 자동 릴리즈

- `go-build.yml`:
  - push/PR 시 `amd64`, `arm/v7`, `arm64` 빌드 아티팩트 생성
- `go-release.yml`:
  - `v*` 태그 푸시 시 GitHub Release 자동 생성/업데이트
  - 멀티아키 바이너리 첨부
  - `workflow_dispatch` 수동 실행 지원

릴리즈 예시:

```bash
git tag v1.0.0
git push origin v1.0.0
```


## 트러블슈팅

`error> Insufficient balance or no resource package. Please recharge.` 가 보이면:

- API 제공자 콘솔에서 크레딧/리소스 패키지를 충전
- `ZAI_API_KEY` 유효성 확인
- 필요 시 `LZAI_BASE_URL`, `LZAI_API_PREFIX` 값 확인

Go REPL에서는 위 에러를 감지하면 한국어 힌트를 함께 출력합니다.


## JS 설정 파일 호환

Node(JS) 버전에서 쓰던 `~/.config/light-zai/config.json`이 있으면 Go 버전도 기본값으로 재사용합니다.

- 우선순위: 환경변수 > config.json > 내장 기본값
- 그래서 JS에서는 잘 되는데 Go에서 모델/엔드포인트/키가 다르게 잡히던 문제를 줄일 수 있습니다.
