# Light-zai

**ARM7L에서도 돌아가는 가벼운 AI 코딩 챗봇**

외부 의존성 없이 Node.js 내장 모듈만으로 동작하는 올인원 CLI 챗봇입니다.
Raspberry Pi 등 ARM7L 저사양 기기에서도 원활하게 실행됩니다.

## 특징

- **제로 의존성** — `npm install` 필요 없음, Node.js만 있으면 실행
- **ARM7L 호환** — Raspberry Pi, Orange Pi 등 저사양 ARM 기기 지원
- **듀얼 모드** — AI 채팅 모드와 Bash 셸 모드를 `!` 하나로 전환
- **Tool Calling** — 파일 읽기/쓰기, 셸 명령 실행, 웹 검색, 이미지/비디오 생성
- **스킬 시스템** — 슬래시 명령으로 호출하는 커스텀 프롬프트 템플릿
- **프리셋** — 시스템 프롬프트를 역할별로 전환
- **MCP 서버 연동** — HTTP + stdio 트랜스포트로 외부 도구 확장
- **스트리밍 응답** — 실시간 토큰 출력
- **세션 저장/로드** — 대화 기록 영속화
- **자동 설정** — 첫 실행 시 `~/.config/light-zai/config.json` 자동 생성

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

# Tool Calling 활성화
LZAI_TOOLS=1 node index.js

# 디버그 모드
LZAI_DEBUG=1 node index.js

# 전체 기능 활성화
LZAI_DEBUG=1 LZAI_TOOLS=1 node index.js

# 원샷 모드 (질문 하나만)
node index.js "파이썬으로 피보나치 함수 만들어줘"

# 파이프 입력
echo "Hello" | node index.js
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
| `LZAI_MODEL` | `glm-5` | 사용할 모델 |
| `LZAI_BASE_URL` | `api.z.ai` | API 서버 호스트 |
| `LZAI_CHAT_PATH` | `/api/coding/paas/v4/chat/completions` | 채팅 API 경로 |
| `LZAI_API_PREFIX` | `/api/paas/v4` | API prefix 경로 |
| `LZAI_WORKSPACE` | 현재 디렉토리 | 파일/명령 작업 디렉토리 |
| `LZAI_TOOLS` | `0` | `1`로 설정 시 Tool Calling 활성화 |
| `LZAI_STREAM` | `1` | `0`으로 설정 시 스트리밍 비활성화 |
| `LZAI_THINK` | `0` | `1`로 설정 시 사고 모드 활성화 |
| `LZAI_WEB_SEARCH` | `0` | `1`로 설정 시 내장 웹 검색 활성화 |
| `LZAI_DEBUG` | `0` | `1`로 설정 시 디버그 로깅 |
| `LZAI_MAX_TOKENS` | `4096` | 최대 응답 토큰 수 |
| `LZAI_TEMPERATURE` | `0.7` | 응답 창의성 (0.0~1.0) |

## 설정 파일

첫 실행 시 `~/.config/light-zai/config.json`이 기본값으로 자동 생성됩니다.

```json
{
  "model": "glm-5",
  "baseUrl": "api.z.ai",
  "chatPath": "/api/coding/paas/v4/chat/completions",
  "apiPrefix": "/api/paas/v4",
  "stream": true,
  "think": false,
  "tools": false,
  "webSearch": false,
  "maxTokens": 4096,
  "temperature": 0.7
}
```

앱 내에서 `/config` 명령으로 확인/변경하고 `/config save`로 저장할 수 있습니다.

## 내장 명령어

### 대화

| 명령어 | 설명 |
|---|---|
| `/clear` | 대화 기록 초기화 |
| `/history` | 대화 기록 보기 |
| `/pop` | 마지막 대화 쌍 제거 |
| `/save [이름]` | 세션 저장 |
| `/load [이름]` | 세션 로드 |
| `/sessions` | 저장된 세션 목록 |

### 설정

| 명령어 | 설명 |
|---|---|
| `/model [이름]` | 모델 변경/목록 |
| `/stream` | 스트리밍 토글 |
| `/think` | 사고 모드 토글 |
| `/tools` | 도구 호출 토글 |
| `/websearch` | 웹 검색 토글 |
| `/json` | JSON 모드 토글 |
| `/config [키 값]` | 설정 보기/변경 |
| `/config save` | 설정 파일로 저장 |

### API / 검색

| 명령어 | 설명 |
|---|---|
| `/search <검색어>` | 웹 검색 (DuckDuckGo) |
| `/zsearch <검색어>` | 웹 검색 (search-prime) |
| `/read <URL>` | URL 읽기 |
| `/image <프롬프트>` | 이미지 생성 |
| `/video <프롬프트>` | 비디오 생성 |
| `/ocr <URL>` | OCR 레이아웃 파싱 |
| `/embed <텍스트>` | 텍스트 임베딩 |
| `/tokens` | 현재 대화 토큰 수 |
| `/upload <파일>` | 파일 업로드 |
| `/transcribe <파일>` | 음성 인식 (ASR) |

### 기타

| 명령어 | 설명 |
|---|---|
| `/doctor` | 시스템 진단 |
| `/status` | 현재 상태 |
| `/help` | 도움말 |
| `/exit` | 종료 |
| `!` | Bash 모드 전환 (exit로 복귀) |

## 스킬 시스템

슬래시 명령으로 호출하는 프롬프트 템플릿입니다. `/<스킬이름> [인자]`로 바로 실행됩니다.

```bash
# 기본 스킬 세트 생성
/skill init

# 사용 예
/review 이 함수 체크해줘
/refactor src/utils.js
/commit
/translate 이 문장을 영어로
/explain 이 코드가 뭘 하는 건지
```

### 기본 내장 스킬 (`/skill init`)

| 스킬 | 역할 |
|---|---|
| `/review` | 코드 리뷰 |
| `/refactor` | 리팩토링 |
| `/explain` | 코드 설명 |
| `/test` | 테스트 코드 작성 |
| `/commit` | 커밋 메시지 생성 |
| `/translate` | 번역 |
| `/fix` | 버그 수정 |
| `/doc` | 문서화 |

### 커스텀 스킬

`~/.config/light-zai/skills/` 에 `.md` 파일을 만들면 스킬로 등록됩니다.

```bash
# CLI로 생성
/skill new deploy

# 또는 직접 파일 생성
cat > ~/.config/light-zai/skills/deploy.md << 'EOF'
# 배포 가이드
{{workspace}} 프로젝트를 프로덕션에 배포하는 절차를 안내해줘.
{{input}}
EOF
```

**템플릿 변수:**

| 변수 | 설명 |
|---|---|
| `{{input}}` | 명령 인자 |
| `{{workspace}}` | 작업 디렉토리 |
| `{{model}}` | 현재 모델명 |
| `{{date}}` | 현재 날짜 |
| `{{time}}` | 현재 시간 |
| `{{cwd}}` | 프로세스 디렉토리 |

### 스킬 관리

| 명령어 | 설명 |
|---|---|
| `/skill` | 스킬 목록 |
| `/skill init` | 기본 스킬 세트 생성 |
| `/skill new <이름>` | 스킬 생성 |
| `/skill show <이름>` | 스킬 내용 보기 |
| `/skill edit <이름>` | 스킬 편집 |
| `/skill delete <이름>` | 스킬 삭제 |

## 프리셋

시스템 프롬프트를 역할별로 전환합니다.

```bash
# 프리셋 만들기
/preset save 번역가

# 프리셋 적용
/preset load 번역가

# 해제
/preset off
```

`~/.config/light-zai/presets/` 에 `.txt` 또는 `.md` 파일로 관리합니다.

| 명령어 | 설명 |
|---|---|
| `/preset` | 프리셋 목록 |
| `/preset load <이름>` | 프리셋 적용 |
| `/preset save <이름>` | 프리셋 저장 |
| `/preset show` | 활성 프리셋 보기 |
| `/preset off` | 프리셋 해제 |
| `/preset delete <이름>` | 프리셋 삭제 |

## MCP 서버 연동

[Model Context Protocol](https://modelcontextprotocol.io) 서버와 연동하여 AI가 사용할 수 있는 도구를 확장합니다.
HTTP와 stdio 두 가지 트랜스포트를 지원합니다.

### HTTP 서버

```bash
/mcp add myserver http://localhost:3000/mcp
```

### stdio 서버

```bash
/mcp stdio fs npx -y @modelcontextprotocol/server-filesystem /home
```

### 설정 파일 (`~/.config/light-zai/mcp.json`)

```json
{
  "servers": {
    "web": {
      "url": "http://localhost:3000/mcp"
    },
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home"]
    }
  }
}
```

등록된 서버는 시작 시 자동으로 연결되며, MCP 도구가 AI의 function calling 목록에 추가됩니다.

| 명령어 | 설명 |
|---|---|
| `/mcp` | 서버 목록 |
| `/mcp add <이름> <URL>` | HTTP 서버 등록+연결 |
| `/mcp stdio <이름> <cmd...>` | stdio 서버 등록+연결 |
| `/mcp remove <이름>` | 서버 제거 |
| `/mcp connect <이름>` | 서버 연결 |
| `/mcp disconnect <이름>` | 서버 연결 해제 |
| `/mcp tools` | 연결된 MCP 도구 목록 |

## Tool Calling

`LZAI_TOOLS=1` 또는 `/tools`로 활성화하면 AI가 다음 도구를 자동으로 사용합니다:

| 도구 | 설명 |
|---|---|
| `read_file` | 파일 내용 읽기 |
| `write_file` | 파일에 내용 쓰기 |
| `execute_command` | 셸 명령 실행 (30초 타임아웃) |
| `web_search` | DuckDuckGo 웹 검색 |
| `web_read` | URL 내용을 마크다운으로 읽기 |
| `generate_image` | 이미지 생성 |
| `run_with_approval` | 사용자 승인 후 명령 실행 |

MCP 서버가 연결되어 있으면 해당 도구도 자동으로 추가됩니다.

## 디렉토리 구조

```
~/.config/light-zai/
├── config.json       # 설정 파일 (자동 생성)
├── mcp.json          # MCP 서버 설정
├── sessions/         # 저장된 세션
├── presets/          # 프리셋 (.txt, .md)
└── skills/           # 스킬 (.md)
```

## 시스템 요구사항

- **Node.js** 14.0.0 이상
- **아키텍처**: ARM7L, x86_64, aarch64 등 Node.js가 지원하는 모든 플랫폼
- **메모리**: 최소 ~20MB (Node.js 런타임 포함)
- **네트워크**: API 서버 접속 필요
- **외부 의존성**: 없음

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
