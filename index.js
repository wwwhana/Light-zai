#!/usr/bin/env node

const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

// ===== 설정 =====
const ZAI_API_KEY = process.env.ZAI_API_KEY || '';
const ZAI_API_URL = 'api.z.ai';
const ZAI_API_PATH = '/api/coding/paas/v4/chat/completions';
const MODEL = process.env.MODEL || 'glm-5';
const DEBUG = process.env.DEBUG === '1';
const WORKSPACE = process.env.WORKSPACE || process.cwd();
const ENABLE_TOOLS = process.env.ENABLE_TOOLS === '1';

// ===== 상태 =====
let bashMode = false;
const conversationHistory = [];

// ===== 도구 정의 (ENABLE_TOOLS=1일 때만) =====
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '파일의 내용을 읽습니다',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '읽을 파일의 경로' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '파일에 내용을 씁니다',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '쓸 파일의 경로' },
          content: { type: 'string', description: '파일에 쓸 내용' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: '셸 명령을 실행합니다',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '실행할 명령' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '인터넷에서 정보를 검색합니다. 최신 정보나 실시간 데이터가 필요할 때 사용하세요.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '검색할 키워드 (간결하게, 1-6단어 권장)',
          },
        },
        required: ['query'],
      },
    },
  },
];

// ===== 유틸리티 함수 =====
function debugLog(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

// ===== Bash 명령 실행 =====
async function executeBashCommand(command) {
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd: WORKSPACE,
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      code: error.code,
    };
  }
}

// ===== 도구 실행 함수 =====
async function readFile(filePath) {
  try {
    const fullPath = path.resolve(WORKSPACE, filePath);
    const content = fs.readFileSync(fullPath, 'utf-8');
    return { success: true, content, lines: content.split('\n').length };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function writeFile(filePath, content) {
  try {
    const fullPath = path.resolve(WORKSPACE, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return { success: true, path: fullPath, bytes: Buffer.byteLength(content) };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function webSearch(query) {
  return new Promise((resolve, reject) => {
    // DuckDuckGo Instant Answer API 사용 (무료, 제한 없음)
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);

          // 결과 파싱
          let summary = result.AbstractText || '';
          let relatedTopics = result.RelatedTopics || [];
          let results = [];

          // Abstract가 있으면 추가
          if (summary) {
            results.push({
              title: result.Heading || query,
              snippet: summary,
              url: result.AbstractURL || '',
            });
          }

          // RelatedTopics에서 추가 결과 추출
          relatedTopics.slice(0, 5).forEach(topic => {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.Text.split(' - ')[0] || topic.Text,
                snippet: topic.Text,
                url: topic.FirstURL,
              });
            }
          });

          if (results.length > 0) {
            resolve({
              success: true,
              query: query,
              results: results,
              count: results.length,
            });
          } else {
            // 결과가 없으면 간단한 안내
            resolve({
              success: true,
              query: query,
              results: [{
                title: '검색 결과 없음',
                snippet: `"${query}"에 대한 즉시 검색 결과를 찾을 수 없습니다. 더 구체적인 키워드를 사용해보세요.`,
                url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
              }],
              count: 0,
            });
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      resolve({
        success: false,
        error: `검색 실패: ${error.message}`,
        fallback: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      });
    });
  });
}

async function executeTool(toolName, args) {
  console.log(`\n[도구 실행] ${toolName}`);
  console.log(`[인자] ${JSON.stringify(args)}`);

  let result;
  switch (toolName) {
    case 'read_file':
      result = await readFile(args.path);
      break;
    case 'write_file':
      result = await writeFile(args.path, args.content);
      break;
    case 'execute_command':
      result = await executeBashCommand(args.command);
      break;
    case 'web_search':
      result = await webSearch(args.query);
      break;
    default:
      result = { success: false, error: `알 수 없는 도구: ${toolName}` };
  }

  console.log(`[결과] ${result.success ? '성공' : '실패'}\n`);
  return result;
}

// ===== API 호출 =====
function callZaiAPI(messages, tools = null) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: MODEL,
      messages: messages,
      max_tokens: parseInt(process.env.MAX_TOKENS || '1000'),
      temperature: parseFloat(process.env.TEMPERATURE || '0.7'),
    };

    if (tools && ENABLE_TOOLS) payload.tools = tools;

    const body = JSON.stringify(payload);
    debugLog('Request payload:', payload);

    const options = {
      hostname: ZAI_API_URL,
      path: ZAI_API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ZAI_API_KEY}`,
        'Accept-Language': 'ko-KR,ko',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      debugLog('Response status:', res.statusCode);

      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        debugLog('Raw response:', data);
        try {
          const response = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`API 오류 (${res.statusCode}): ${response.error?.message || data}`));
            return;
          }
          if (response.choices && response.choices[0]) {
            // Tool Calling 지원
            const message = response.choices[0].message;
            if (ENABLE_TOOLS && message.tool_calls) {
              resolve(message); // 전체 메시지 반환
            } else {
              resolve(message.content); // 텍스트만 반환
            }
          } else if (response.error) {
            reject(new Error(response.error.message || 'API 오류 발생'));
          } else {
            reject(new Error('알 수 없는 응답 형식'));
          }
        } catch (error) {
          reject(new Error(`응답 파싱 실패: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => reject(new Error(`API 요청 실패: ${error.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('API 요청 타임아웃 (60초)'));
    });

    req.write(body);
    req.end();
  });
}

// ===== 메시지 전송 (Tool Calling 지원) =====
async function sendMessage(userMessage) {
  conversationHistory.push({ role: 'user', content: userMessage });
  debugLog('Conversation history length:', conversationHistory.length);

  console.log('\n[처리중...]\n');

  try {
    const startTime = Date.now();
    let response = await callZaiAPI(
      conversationHistory,
      ENABLE_TOOLS ? TOOLS : null
    );

    // Tool Calling 처리
    if (ENABLE_TOOLS && typeof response === 'object' && response.tool_calls) {
      conversationHistory.push(response);

      // 도구 실행
      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);
        const toolResult = await executeTool(toolName, toolArgs);

        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }

      // 도구 실행 후 다시 API 호출
      response = await callZaiAPI(conversationHistory, ENABLE_TOOLS ? TOOLS : null);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    debugLog(`Response received in ${duration}s`);

    // 최종 응답 저장
    const content = typeof response === 'string' ? response : response.content;
    conversationHistory.push({ role: 'assistant', content });

    return content;
  } catch (error) {
    console.error('\n❌ 오류 발생:', error.message);
    conversationHistory.pop();

    // 오류 타입별 안내
    if (error.message.includes('타임아웃')) {
      console.error('\n💡 해결: 네트워크 확인 또는 /clear로 대화 기록 초기화');
    } else if (error.message.includes('401') || error.message.includes('403')) {
      console.error('\n💡 API 키 확인: export ZAI_API_KEY="your-key"');
    } else if (error.message.includes('429')) {
      console.error('\n💡 요청 한도 초과. 잠시 후 다시 시도');
    } else if (error.message.includes('500') || error.message.includes('502') || error.message.includes('503')) {
      console.error('\n💡 서버 오류. z.ai 서비스 상태 확인');
    }

    return null;
  }
}

// ===== 프롬프트 =====
function getPrompt() {
  if (bashMode) {
    const cwd = process.cwd();
    return `bash:${cwd}$ `;
  }
  return '사용자> ';
}

// ===== 메인 =====
async function main() {
  if (!ZAI_API_KEY) {
    console.error('❌ 오류: ZAI_API_KEY 환경 변수가 설정되지 않았습니다.');
    console.error('사용법: export ZAI_API_KEY="your-api-key"');
    process.exit(1);
  }

  console.log('=================================');
  console.log('   z.ai 올인원 챗봇 v3.0');
  console.log('   (ARM7L + GLM-5)');
  console.log('=================================');
  console.log('모델:', MODEL);
  console.log('작업 디렉토리:', WORKSPACE);
  console.log('Bash 모드: ! 입력으로 전환');
  if (ENABLE_TOOLS) console.log('Tool Calling: 활성화 (파일/명령/웹검색) ✅');
  if (DEBUG) console.log('디버그 모드: ON');
  console.log('');
  console.log('명령어:');
  console.log('  /clear   - 대화 기록 초기화');
  console.log('  /exit    - 종료');
  console.log('  /help    - 도움말');
  console.log('  /status  - 현재 상태');
  console.log('  !        - Bash 모드 전환');
  console.log('=================================\n');

  // 현재 날짜 및 시간 가져오기
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  });
  const timeStr = now.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  // 시스템 프롬프트
  const systemPrompt = ENABLE_TOOLS
    ? `당신은 전문적인 코딩 어시스턴트입니다.

현재 날짜와 시간: ${dateStr} ${timeStr}

사용 가능한 도구:
- read_file: 파일 읽기
- write_file: 파일 쓰기
- execute_command: 셸 명령 실행
- web_search: 인터넷 검색 (최신 정보, 실시간 데이터)

작업 디렉토리: ${WORKSPACE}

최신 정보나 실시간 데이터가 필요하면 web_search를 사용하세요.
파일을 읽고 쓰고 명령을 실행할 수 있습니다.
한국어로 답변하세요.`
    : `당신은 전문적인 코딩 어시스턴트입니다.

현재 날짜와 시간: ${dateStr} ${timeStr}

프로그래밍 질문에 명확하고 실용적인 답변을 제공합니다.
한국어로 답변하세요.`;

  conversationHistory.push({ role: 'system', content: systemPrompt });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function updatePrompt() {
    rl.setPrompt(getPrompt());
    rl.prompt();
  }

  updatePrompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      updatePrompt();
      return;
    }

    // Bash 모드 토글
    if (input === '!') {
      bashMode = !bashMode;
      console.log(bashMode ? '\n🐚 Bash 모드 활성화\n' : '\n🤖 AI 모드로 전환\n');
      updatePrompt();
      return;
    }

    // Bash 모드 처리
    if (bashMode) {
      if (input === 'exit') {
        bashMode = false;
        console.log('\n🤖 AI 모드로 전환\n');
        updatePrompt();
        return;
      }

      console.log('');
      const result = await executeBashCommand(input);

      // 출력
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (!result.success && result.code) console.error(`[exit code: ${result.code}]`);
      console.log('');

      // 대화 히스토리에 추가 (AI가 볼 수 있도록)
      // 출력이 너무 길면 잘라냄 (10000자 제한)
      const MAX_OUTPUT = 10000;
      let stdout = result.stdout || '';
      let stderr = result.stderr || '';

      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.substring(0, MAX_OUTPUT) + '\n... [출력 생략됨]';
      }
      if (stderr.length > MAX_OUTPUT) {
        stderr = stderr.substring(0, MAX_OUTPUT) + '\n... [출력 생략됨]';
      }

      const commandSummary = `[Bash 명령 실행]\n명령: ${input}\n출력:\n${stdout}${stderr}${!result.success ? `\n[실패: exit code ${result.code}]` : ''}`;
      conversationHistory.push({
        role: 'user',
        content: commandSummary,
      });

      updatePrompt();
      return;
    }

    // AI 모드 명령어
    if (input.startsWith('/')) {
      const cmd = input.toLowerCase();

      if (cmd === '/exit' || cmd === '/quit') {
        console.log('\n챗봇을 종료합니다.');
        process.exit(0);
      } else if (cmd === '/clear') {
        conversationHistory.length = 1;
        console.log('\n✅ 대화 기록 초기화\n');
      } else if (cmd === '/help') {
        console.log('\n명령어:');
        console.log('  /clear   - 대화 기록 초기화');
        console.log('  /exit    - 종료');
        console.log('  /help    - 도움말');
        console.log('  /status  - 현재 상태');
        console.log('  !        - Bash 모드 전환');
        console.log('\n환경 변수:');
        console.log('  DEBUG=1          - 디버그 모드');
        console.log('  ENABLE_TOOLS=1   - Tool Calling 활성화');
        console.log('  MAX_TOKENS=1000  - 최대 토큰');
        console.log('  TEMPERATURE=0.7  - 창의성');
        console.log('  WORKSPACE=/path  - 작업 디렉토리\n');
      } else if (cmd === '/status') {
        console.log('\n현재 상태:');
        console.log('  모드:', bashMode ? 'Bash 🐚' : 'AI 🤖');
        console.log('  대화 턴:', (conversationHistory.length - 1) / 2);
        console.log('  메시지 수:', conversationHistory.length);
        console.log('  예상 토큰:', Math.floor(JSON.stringify(conversationHistory).length / 4));
        console.log('  모델:', MODEL);
        console.log('  작업 디렉토리:', WORKSPACE);
        console.log('  Tool Calling:', ENABLE_TOOLS ? '활성화 ✅' : '비활성화');
        console.log('');
      } else {
        console.log(`\n❌ 알 수 없는 명령어: ${input}\n`);
      }
      updatePrompt();
      return;
    }

    // AI 메시지 처리
    try {
      const response = await sendMessage(input);
      if (response) {
        console.log(`AI> ${response}\n`);
      }
    } catch (error) {
      console.error(`\n❌ 예외: ${error.message}\n`);
    }

    updatePrompt();
  });

  rl.on('close', () => {
    console.log('\n챗봇을 종료합니다.');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\n\n챗봇을 종료합니다.');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('❌ 치명적 오류:', error);
  process.exit(1);
});
