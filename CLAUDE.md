# CLAUDE.md - AI Assistant Guide for Light-zai

## Project Overview

Light-zai is a **lightweight CLI chatbot** built in Node.js that interfaces with the **z.ai API** (GLM-5 model). Designed to run on **ARM7L devices** (Raspberry Pi, etc.) and other low-resource environments, it uses **zero external dependencies** — only Node.js built-in modules. It serves as an all-in-one coding assistant with dual-mode operation (AI chat + Bash shell), optional tool calling, and web search capabilities. The primary language for UI and prompts is **Korean**.

### Design Philosophy

- **Lightweight**: Zero npm dependencies, single file, minimal memory footprint (~20MB with Node.js runtime)
- **Portable**: Runs on ARM7L, x86_64, aarch64 — anywhere Node.js runs
- **Simple**: No build step, no transpilation, no module bundling. `node index.js` and go.

## Repository Structure

```
Light-zai/
├── index.js          # Single-file application — all logic lives here
├── package.json      # Project metadata and npm scripts
├── CLAUDE.md         # This file — AI assistant guide
└── README.md         # User-facing documentation (Korean)
```

This is a **zero-dependency** Node.js project. It uses only built-in modules (`https`, `readline`, `fs`, `path`, `child_process`, `util`).

## Architecture

The entire application is in `index.js` (~400 lines) and follows a sequential, single-file architecture:

| Section (line range) | Purpose |
|---|---|
| Configuration constants | `ZAI_API_KEY`, `MODEL`, `WORKSPACE`, `ENABLE_TOOLS`, etc. |
| Tool definitions (`TOOLS`) | OpenAI-compatible function-calling schema for 4 tools |
| Utility functions | `debugLog`, `executeBashCommand` |
| Tool implementations | `readFile`, `writeFile`, `webSearch`, `executeTool` |
| API layer | `callZaiAPI` — raw HTTPS request to z.ai |
| Message handling | `sendMessage` — orchestrates tool-calling loop |
| REPL / main | `main()` — readline-based interactive loop |

### Key Design Patterns

- **Single-file architecture**: No modules, no build step, no transpilation. Run directly with `node index.js`.
- **Environment-driven configuration**: All settings controlled via environment variables (see below).
- **OpenAI-compatible API**: The z.ai endpoint follows the OpenAI chat completions format (`messages`, `tools`, `tool_calls`).
- **Dual-mode REPL**: Toggle between AI chat mode and raw Bash mode with `!`.
- **Conversation history**: All messages (including bash command results) are appended to `conversationHistory[]` for multi-turn context.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ZAI_API_KEY` | *(required)* | API key for z.ai |
| `MODEL` | `glm-5` | Model identifier |
| `WORKSPACE` | `process.cwd()` | Working directory for file/command operations |
| `ENABLE_TOOLS` | `0` | Set to `1` to enable tool calling (read/write files, execute commands, web search) |
| `DEBUG` | `0` | Set to `1` for verbose logging |
| `MAX_TOKENS` | `1000` | Maximum response tokens |
| `TEMPERATURE` | `0.7` | Sampling temperature |

## How to Run

```bash
# Basic chat mode
export ZAI_API_KEY="your-key"
node index.js

# With tool calling enabled
ENABLE_TOOLS=1 node index.js

# Debug mode
DEBUG=1 ENABLE_TOOLS=1 node index.js

# Via npm scripts
npm start              # basic
npm run start:tools    # with tools
npm run start:debug    # debug mode
npm run start:full     # debug + tools
```

## Tool Calling System

When `ENABLE_TOOLS=1`, the AI can invoke 4 tools:

1. **`read_file`** — Read file contents (resolved relative to `WORKSPACE`)
2. **`write_file`** — Write content to a file (creates directories as needed)
3. **`execute_command`** — Run a shell command (30s timeout, 10MB buffer)
4. **`web_search`** — Search via DuckDuckGo Instant Answer API

The tool-calling flow follows OpenAI's function-calling protocol:
1. Send messages + tool definitions to API
2. If response contains `tool_calls`, execute each tool locally
3. Append tool results to conversation history
4. Call API again for final response

## CLI Commands (In-App)

| Command | Action |
|---|---|
| `/clear` | Reset conversation history |
| `/exit` or `/quit` | Exit the chatbot |
| `/help` | Show help |
| `/status` | Show current state (mode, message count, model, etc.) |
| `!` | Toggle Bash mode (type `exit` to return to AI mode) |

## Development Guidelines

### When modifying this codebase:

1. **Keep it single-file**. The simplicity of one file is intentional — do not split into modules unless there is a strong reason.
2. **No external dependencies**. The project deliberately uses only Node.js built-in modules. Do not add npm dependencies.
3. **Maintain Korean UI strings**. All user-facing console output is in Korean. Keep this consistent.
4. **Environment variables for config**. Never hardcode API keys or configuration. Always use `process.env`.
5. **OpenAI-compatible format**. The API payload structure must stay compatible with OpenAI's chat completions format since z.ai follows that standard.
6. **Preserve the dual-mode REPL**. The `!` bash toggle and `/command` system are core UX features.
7. **Conversation history integrity**. All interactions (AI responses, bash outputs, tool results) must be recorded in `conversationHistory` for multi-turn context.
8. **Command execution safety**. `executeBashCommand` has a 30s timeout and 10MB buffer limit. Respect these boundaries.

### Code style

- Plain ES5/CommonJS (`require`, no `import`)
- `const`/`let` (no `var`)
- `async/await` for async operations
- Korean comments throughout
- Section headers with `// ===== 섹션명 =====` pattern

### Testing

There is no automated test suite. To verify changes:
1. Run `node index.js` with a valid `ZAI_API_KEY`
2. Test AI chat mode with a simple question
3. Test bash mode toggle with `!`
4. Test tool calling with `ENABLE_TOOLS=1`
5. Test slash commands (`/help`, `/status`, `/clear`)
6. Test error handling by running without `ZAI_API_KEY`

### Security Considerations

- **API key**: Only passed via environment variable, never logged (unless `DEBUG=1`)
- **Command execution**: `executeBashCommand` runs arbitrary shell commands — this is by design for a local dev tool but should never be exposed to untrusted input
- **File operations**: Resolve paths relative to `WORKSPACE` — be aware of path traversal
- **Web search**: Uses DuckDuckGo's free API with no authentication required
- **Output truncation**: Bash output is capped at 10,000 characters when added to conversation history to avoid token overflow
