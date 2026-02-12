# Light-zai

**ARM7L에서도 돌아가는 가벼운 AI 코딩 챗봇**

외부 의존성 없이 Node.js 내장 모듈만으로 동작하는 올인원 CLI 챗봇입니다.
Raspberry Pi 등 ARM7L 저사양 기기에서도 원활하게 실행됩니다.

## 특징

- **제로 의존성** — `npm install` 필요 없음, Node.js만 있으면 실행
- **ARM7L 호환** — Raspberry Pi, Orange Pi 등 저사양 ARM 기기 지원
- **듀얼 모드** — AI 채팅 모드와 Bash 셸 모드를 `!` 하나로 전환
- **Tool Calling** — 파일 읽기/쓰기, 셸 명령 실행, 웹 검색 지원
- **OpenAI 호환 API** — 다양한 AI 모델 연동 가능
- **대화 컨텍스트 유지** — 멀티턴 대화, Bash 결과도 AI가 기억

## 빠른 시작

```bash
# 1. API 키 설정
export ZAI_API_KEY="your-api-key"

# 2. 바로 실행
node index.js
```

외부 패키지가 없으므로 `npm install` 없이 바로 실행할 수 있습니다.

## 실행 옵션

```bash
# 기본 채팅 모드
node index.js

# Tool Calling 활성화 (파일/명령/웹검색)
ENABLE_TOOLS=1 node index.js

# 디버그 모드
DEBUG=1 node index.js

# 전체 기능 활성화
DEBUG=1 ENABLE_TOOLS=1 node index.js
```

### npm 스크립트

```bash
npm start              # 기본 모드
npm run start:tools    # Tool Calling 활성화
npm run start:debug    # 디버그 모드
npm run start:full     # 디버그 + Tool Calling
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ZAI_API_KEY` | *(필수)* | API 키 |
| `MODEL` | *(기본 모델)* | 사용할 모델 |
| `WORKSPACE` | 현재 디렉토리 | 파일/명령 작업 디렉토리 |
| `ENABLE_TOOLS` | `0` | `1`로 설정 시 Tool Calling 활성화 |
| `DEBUG` | `0` | `1`로 설정 시 디버그 로깅 |
| `MAX_TOKENS` | `1000` | 최대 응답 토큰 수 |
| `TEMPERATURE` | `0.7` | 응답 창의성 (0.0~1.0) |

## 사용법

### AI 채팅 모드

```
사용자> 파이썬으로 피보나치 함수 만들어줘

[처리중...]

AI> def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)
```

### Bash 모드

`!`를 입력하면 Bash 모드로 전환됩니다. Bash에서 실행한 결과는 AI 대화 컨텍스트에 자동으로 추가됩니다.

```
사용자> !

🐚 Bash 모드 활성화

bash:/home/user$ ls -la
total 16
drwxr-xr-x 2 user user 4096 ...
...

bash:/home/user$ exit

🤖 AI 모드로 전환
```

### 내장 명령어

| 명령어 | 설명 |
|---|---|
| `/clear` | 대화 기록 초기화 |
| `/exit` | 종료 |
| `/help` | 도움말 |
| `/status` | 현재 상태 확인 |
| `!` | Bash 모드 전환 |

## Tool Calling

`ENABLE_TOOLS=1`로 실행하면 AI가 다음 도구를 자동으로 사용할 수 있습니다:

| 도구 | 설명 |
|---|---|
| `read_file` | 파일 내용 읽기 |
| `write_file` | 파일에 내용 쓰기 |
| `execute_command` | 셸 명령 실행 (30초 타임아웃) |
| `web_search` | DuckDuckGo 웹 검색 |

## 시스템 요구사항

- **Node.js** 14.0.0 이상
- **아키텍처**: ARM7L, x86_64, aarch64 등 Node.js가 지원하는 모든 플랫폼
- **메모리**: 최소 ~20MB (Node.js 런타임 포함)
- **네트워크**: API 서버 접속 필요
- **외부 의존성**: 없음

### ARM7L 기기 (Raspberry Pi 등)

```bash
# Raspberry Pi에서 Node.js 설치 (예시)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 바로 실행
export ZAI_API_KEY="your-key"
node index.js
```

## 프로젝트 구조

```
Light-zai/
├── index.js          # 메인 애플리케이션 (단일 파일)
├── package.json      # 프로젝트 메타데이터
├── CLAUDE.md         # AI 어시스턴트 가이드
└── README.md         # 이 파일
```

의도적으로 **단일 파일 구조**를 유지합니다. 외부 의존성 없이 `index.js` 하나로 모든 기능이 동작합니다.

## 라이선스

MIT
