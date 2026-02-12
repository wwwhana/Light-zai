#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const os = require('os');

const execPromise = util.promisify(exec);

// ===== 버전 =====
const VERSION = '4.0.0';
const APP_NAME = 'Light-zai';

// ===== 설정 경로 =====
const CONFIG_DIR = path.join(os.homedir(), '.config', 'light-zai');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');

// ===== ANSI 색상 =====
const IS_TTY = process.stdout.isTTY;
const c = IS_TTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgBlue: '\x1b[44m',
} : { reset:'',bold:'',dim:'',italic:'',red:'',green:'',yellow:'',blue:'',magenta:'',cyan:'',white:'',bgRed:'',bgGreen:'',bgBlue:'' };

// ===== 사용 가능한 모델 =====
const MODELS = {
  'glm-5':              '최신 플래그십, 에이전트 특화',
  'glm-4.7':            '오픈소스 1위, 코딩 최강',
  'glm-4.7-flash':      '경량 고성능',
  'glm-4.6':            '200K 컨텍스트, 추론 강화',
  'glm-4.5':            '355B MoE, 하이브리드 추론',
  'glm-4.5-air':        '106B 경량 MoE',
  'glm-4-32b-0414-128k':'32B 파라미터',
  'glm-4.6v':           '비전-언어 (32K)',
  'glm-4.5v':           '비전-언어 (16K)',
  'glm-image':          '이미지 생성 (9B+7B)',
  'cogView-4-250304':   '이미지 생성 (오픈소스)',
  'cogvideox-3':        '비디오 생성 (4K/60fps)',
  'glm-asr-2512':       '음성 인식 (다국어)',
  'glm-ocr':            'OCR 레이아웃 파싱 (0.9B)',
  'embedding-3':        '텍스트 임베딩',
};

// ===== 설정 관리 =====
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (_) { /* 무시 */ }
  return {};
}

function saveConfig(cfg) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ===== 환경 변수 + 저장된 설정 병합 =====
const savedCfg = loadConfig();

const CFG = {
  apiKey:     process.env.ZAI_API_KEY     || savedCfg.apiKey     || '',
  baseUrl:    process.env.ZAI_BASE_URL    || savedCfg.baseUrl    || 'api.z.ai',
  chatPath:   process.env.ZAI_CHAT_PATH   || savedCfg.chatPath   || '/api/coding/paas/v4/chat/completions',
  apiPrefix:  process.env.ZAI_API_PREFIX  || savedCfg.apiPrefix  || '/api/paas/v4',
  model:      process.env.MODEL           || savedCfg.model      || 'glm-5',
  debug:      process.env.DEBUG === '1',
  workspace:  process.env.WORKSPACE       || process.cwd(),
  tools:      process.env.ENABLE_TOOLS  !== undefined ? process.env.ENABLE_TOOLS  === '1' : (savedCfg.tools  ?? false),
  stream:     process.env.ENABLE_STREAM !== undefined ? process.env.ENABLE_STREAM !== '0' : (savedCfg.stream ?? true),
  think:      process.env.ENABLE_THINK  !== undefined ? process.env.ENABLE_THINK  === '1' : (savedCfg.think  ?? false),
  webSearch:  process.env.ENABLE_WEB_SEARCH !== undefined ? process.env.ENABLE_WEB_SEARCH === '1' : (savedCfg.webSearch ?? false),
  maxTokens:  parseInt(process.env.MAX_TOKENS   || savedCfg.maxTokens  || '4096'),
  temperature:parseFloat(process.env.TEMPERATURE || savedCfg.temperature || '0.7'),
  jsonMode:   false,
};

// ===== 전역 상태 =====
let bashMode = false;
const conversationHistory = [];
let lastUsage = null;
let _rl = null; // REPL readline 인스턴스 (승인 프롬프트용)

// ===== 유틸리티 =====
function debugLog(...args) { if (CFG.debug) console.log(`${c.dim}[DEBUG]${c.reset}`, ...args); }
function truncate(s, max) { return s.length > max ? s.slice(0, max) + '\n... [잘림]' : s; }
function formatBytes(b) {
  if (b < 1024) return b + 'B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + 'KB';
  return (b/1024/1024).toFixed(1) + 'MB';
}

function getMimeType(ext) {
  const map = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
    '.pdf':'application/pdf','.txt':'text/plain','.json':'application/json',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.mp4':'video/mp4',
    '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  return map[ext] || 'application/octet-stream';
}

// ===== HTTP 클라이언트 =====
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const proto = options.protocol === 'http:' ? http : https;
    const req = proto.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        debugLog(`HTTP ${res.statusCode} ${options.path}`);
        if (data) debugLog('응답:', truncate(data, 500));
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`API 오류 (${res.statusCode}): ${json.error?.message || data}`));
          } else {
            resolve(json);
          }
        } catch (_) {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        }
      });
    });
    req.on('error', (e) => reject(new Error(`네트워크 오류: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('요청 타임아웃')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpStream(options, body, callbacks) {
  return new Promise((resolve, reject) => {
    const { onToken, onReasoning, onToolCall, onSearchResult, onDone, onUsage } = callbacks;
    const proto = options.protocol === 'http:' ? http : https;
    const req = proto.request(options, (res) => {
      if (res.statusCode >= 400) {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { const j = JSON.parse(data); reject(new Error(`API 오류 (${res.statusCode}): ${j.error?.message || data}`)); }
          catch(_) { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); }
        });
        return;
      }

      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';
      const toolCalls = {};
      let finishReason = null;
      let usage = null;
      let webSearchResults = null;

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload);
            if (parsed.web_search) webSearchResults = parsed.web_search;
            if (parsed.usage) usage = parsed.usage;

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              if (onReasoning) onReasoning(delta.reasoning_content);
            }
            if (delta.content) {
              fullContent += delta.content;
              if (onToken) onToken(delta.content);
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (tc.id) {
                  toolCalls[idx] = { id: tc.id, type: tc.type || 'function', function: { name: '', arguments: '' } };
                }
                if (tc.function?.name && toolCalls[idx]) toolCalls[idx].function.name = tc.function.name;
                if (tc.function?.arguments && toolCalls[idx]) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch (_) { /* 파싱 실패 무시 */ }
        }
      });

      res.on('end', () => {
        if (webSearchResults && onSearchResult) onSearchResult(webSearchResults);
        if (usage && onUsage) onUsage(usage);
        const tcArray = Object.values(toolCalls);
        if (onDone) onDone({ content: fullContent, reasoning: fullReasoning, toolCalls: tcArray.length > 0 ? tcArray : null, finishReason, usage });
        resolve({ content: fullContent, reasoning: fullReasoning, toolCalls: tcArray.length > 0 ? tcArray : null, finishReason, usage, webSearch: webSearchResults });
      });
    });
    req.on('error', (e) => reject(new Error(`네트워크 오류: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('스트리밍 타임아웃')); });
    if (body) req.write(body);
    req.end();
  });
}

// ===== Multipart 빌더 =====
function buildMultipart(fields, files) {
  const boundary = '----LightZai' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const chunks = [];
  for (const [key, val] of Object.entries(fields || {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const file of (files || [])) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

// ===== API 요청 헬퍼 =====
function apiOpts(method, apiPath, extraHeaders) {
  return {
    hostname: CFG.baseUrl, port: 443, protocol: 'https:',
    path: apiPath, method,
    headers: {
      'Authorization': `Bearer ${CFG.apiKey}`,
      'Accept-Language': 'ko-KR,ko',
      ...extraHeaders,
    },
    timeout: 120000,
  };
}

function apiPost(apiPath, body, extraHeaders) {
  const jsonBody = typeof body === 'string' ? body : JSON.stringify(body);
  const opts = apiOpts('POST', apiPath, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonBody), ...extraHeaders });
  debugLog('POST', apiPath, JSON.stringify(body).slice(0, 300));
  return httpRequest(opts, jsonBody);
}

function apiGet(apiPath) {
  const opts = apiOpts('GET', apiPath);
  debugLog('GET', apiPath);
  return httpRequest(opts);
}

function apiPostMultipart(apiPath, fields, files) {
  const { contentType, body } = buildMultipart(fields, files);
  const opts = apiOpts('POST', apiPath, { 'Content-Type': contentType, 'Content-Length': body.length });
  return httpRequest(opts, body);
}

function apiPostStream(apiPath, body, callbacks) {
  const jsonBody = JSON.stringify(body);
  const opts = apiOpts('POST', apiPath, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonBody) });
  return httpStream(opts, jsonBody, callbacks);
}

// ===== API: 챗 완성 =====
async function zaiChat(messages, options = {}) {
  const payload = {
    model: options.model || CFG.model,
    messages,
    max_tokens: options.maxTokens || CFG.maxTokens,
    temperature: options.temperature ?? CFG.temperature,
  };
  if (CFG.think) payload.thinking = { type: 'enabled' };
  if (CFG.jsonMode) payload.response_format = { type: 'json_object' };

  // 도구 구성
  const tools = [];
  if (CFG.webSearch) tools.push({ type: 'web_search', web_search: { enable: true, search_engine: 'search-prime', search_result: true } });
  if (CFG.tools) tools.push(...FUNCTION_TOOLS);
  if (tools.length > 0) payload.tools = tools;
  if (options.tools) payload.tools = options.tools;
  if (options.stop) payload.stop = options.stop;

  const res = await apiPost(CFG.chatPath, payload);
  if (res.usage) lastUsage = res.usage;
  return res;
}

async function zaiChatStream(messages, callbacks, options = {}) {
  const payload = {
    model: options.model || CFG.model,
    messages,
    max_tokens: options.maxTokens || CFG.maxTokens,
    temperature: options.temperature ?? CFG.temperature,
    stream: true,
  };
  if (CFG.think) payload.thinking = { type: 'enabled' };
  if (CFG.jsonMode) payload.response_format = { type: 'json_object' };

  const tools = [];
  if (CFG.webSearch) tools.push({ type: 'web_search', web_search: { enable: true, search_engine: 'search-prime', search_result: true } });
  if (CFG.tools) tools.push(...FUNCTION_TOOLS);
  if (tools.length > 0) payload.tools = tools;
  if (options.tools) payload.tools = options.tools;

  return apiPostStream(CFG.chatPath, payload, callbacks);
}

// ===== API: 웹 검색 =====
async function zaiWebSearch(query, options = {}) {
  const body = {
    search_engine: 'search-prime',
    search_query: query,
    count: options.count || 10,
  };
  if (options.domain) body.search_domain_filter = options.domain;
  if (options.recency) body.search_recency_filter = options.recency;
  return apiPost(`${CFG.apiPrefix}/web_search`, body);
}

// ===== API: 웹 리더 =====
async function zaiWebRead(url, options = {}) {
  const body = {
    url,
    return_format: options.format || 'markdown',
    no_cache: options.noCache || false,
    retain_images: options.images ?? true,
    with_links_summary: options.links || false,
    timeout: options.timeout || 20,
  };
  return apiPost(`${CFG.apiPrefix}/reader`, body);
}

// ===== API: 이미지 생성 =====
async function zaiGenerateImage(prompt, options = {}) {
  const body = {
    model: options.model || 'cogView-4-250304',
    prompt,
  };
  if (options.size) body.size = options.size;
  if (options.quality) body.quality = options.quality;
  return apiPost(`${CFG.apiPrefix}/images/generations`, body);
}

// ===== API: 비디오 생성 (비동기) =====
async function zaiGenerateVideo(prompt, options = {}) {
  const body = {
    model: options.model || 'cogvideox-3',
    prompt,
  };
  if (options.imageUrl) body.image_url = options.imageUrl;
  if (options.size) body.size = options.size;
  if (options.quality) body.quality = options.quality;
  if (options.fps) body.fps = options.fps;
  if (options.duration) body.duration = options.duration;
  if (options.withAudio) body.with_audio = true;
  return apiPost(`${CFG.apiPrefix}/videos/generations`, body);
}

// ===== API: 비동기 결과 조회 =====
async function zaiAsyncResult(taskId) {
  return apiGet(`${CFG.apiPrefix}/async-result/${taskId}`);
}

// ===== API: 비동기 폴링 =====
async function zaiPollResult(taskId, intervalMs, timeoutMs) {
  intervalMs = intervalMs || 5000;
  timeoutMs = timeoutMs || 300000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await zaiAsyncResult(taskId);
    if (result.task_status === 'SUCCESS') return result;
    if (result.task_status === 'FAIL') throw new Error('비동기 작업 실패');
    process.stdout.write(`${c.dim}  처리중... (${Math.floor((Date.now()-start)/1000)}초)${c.reset}\r`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('폴링 타임아웃 (5분)');
}

// ===== API: 음성 인식 =====
async function zaiTranscribeAudio(filePath, options = {}) {
  const fullPath = path.resolve(CFG.workspace, filePath);
  const fileData = fs.readFileSync(fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const fields = { model: 'glm-asr-2512' };
  if (options.stream) fields.stream = 'true';
  if (options.context) fields.context = options.context;
  if (options.hotwords) fields.hotwords = JSON.stringify(options.hotwords);
  const files = [{ field: 'file', name: path.basename(fullPath), type: getMimeType(ext), data: fileData }];
  return apiPostMultipart(`${CFG.apiPrefix}/audio/transcriptions`, fields, files);
}

// ===== API: OCR 레이아웃 파싱 =====
async function zaiLayoutParsing(fileUrl) {
  return apiPost(`${CFG.apiPrefix}/layout_parsing`, { model: 'glm-ocr', file: fileUrl });
}

// ===== API: 임베딩 =====
async function zaiEmbed(input, options = {}) {
  const body = { model: options.model || 'embedding-3', input };
  if (options.dimensions) body.dimensions = options.dimensions;
  return apiPost(`${CFG.apiPrefix}/embeddings`, body);
}

// ===== API: 토크나이저 =====
async function zaiTokenize(messages) {
  return apiPost(`${CFG.apiPrefix}/tokenizer`, { model: CFG.model, messages });
}

// ===== API: 파일 업로드 =====
async function zaiUploadFile(filePath, purpose) {
  const fullPath = path.resolve(CFG.workspace, filePath);
  const fileData = fs.readFileSync(fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const fields = { purpose: purpose || 'agent' };
  const files = [{ field: 'file', name: path.basename(fullPath), type: getMimeType(ext), data: fileData }];
  return apiPostMultipart(`${CFG.apiPrefix}/files`, fields, files);
}

// ===== DuckDuckGo 검색 (한국어/국제 검색용) =====
function duckDuckGoSearch(query) {
  return new Promise((resolve) => {
    const postData = `q=${encodeURIComponent(query)}&b=&kl=kr-kr`;
    const options = {
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (compatible; Light-zai/4.0)',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const results = [];
        const blocks = data.split(/class="result\s/);
        for (let i = 1; i < blocks.length && results.length < 10; i++) {
          const block = blocks[i];
          // URL 추출
          const urlMatch = block.match(/class="result__a"[^>]*href="([^"]*)"/);
          if (!urlMatch) continue;
          let url = urlMatch[1];
          const uddgMatch = url.match(/uddg=([^&]*)/);
          if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
          // 제목 추출
          const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
          const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
          // 스니펫 추출
          const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
          const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';
          if (title || snippet) results.push({ title, snippet, url });
        }

        // HTML 결과가 없으면 Instant Answer API 폴백
        if (results.length === 0) {
          const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
          https.get(apiUrl, (apiRes) => {
            let apiData = '';
            apiRes.on('data', (c) => { apiData += c; });
            apiRes.on('end', () => {
              try {
                const j = JSON.parse(apiData);
                if (j.AbstractText) results.push({ title: j.Heading || query, snippet: j.AbstractText, url: j.AbstractURL || '' });
                (j.RelatedTopics || []).slice(0, 5).forEach(t => {
                  if (t.Text && t.FirstURL) results.push({ title: t.Text.split(' - ')[0], snippet: t.Text, url: t.FirstURL });
                });
              } catch (_) { /* 무시 */ }
              resolve({ success: true, query, results, count: results.length });
            });
          }).on('error', () => resolve({ success: true, query, results: [], count: 0 }));
          return;
        }
        resolve({ success: true, query, results, count: results.length });
      });
    });

    req.on('error', () => resolve({ success: true, query, results: [], count: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ success: true, query, results: [], count: 0 }); });
    req.write(postData);
    req.end();
  });
}

// ===== 사용자 승인 프롬프트 =====
function promptUser(question) {
  return new Promise((resolve) => {
    if (_rl) {
      _rl.question(question, (answer) => resolve(answer.trim().toLowerCase()));
    } else {
      // REPL 외부 (원샷 모드 등) — 자동 거부
      resolve('n');
    }
  });
}

// ===== 명령 디스패처 (슬래시 명령 + bash) =====
async function dispatchCommand(cmdStr) {
  if (!cmdStr.startsWith('/')) {
    // Bash 명령
    const res = await executeBashCommand(cmdStr);
    return {
      success: res.success,
      type: 'bash',
      output: truncate((res.stdout || '') + (res.stderr || ''), 10000),
      code: res.code,
    };
  }

  const parts = cmdStr.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case 'search': case 's': {
      const res = await duckDuckGoSearch(arg);
      const formatted = res.results.slice(0, 5).map(r => `${r.title}\n${r.snippet}\n${r.url}`).join('\n\n');
      return { success: true, type: 'search', query: arg, count: res.count, output: formatted || '검색 결과 없음' };
    }
    case 'zsearch': case 'zs': {
      const res = await zaiWebSearch(arg);
      const results = res.search_result || [];
      const formatted = results.slice(0, 5).map(r => `${r.title}\n${r.content || ''}\n${r.link || ''}`).join('\n\n');
      return { success: true, type: 'zsearch', query: arg, count: results.length, output: formatted || '검색 결과 없음' };
    }
    case 'read': case 'r': {
      const res = await zaiWebRead(arg);
      const r = res.reader_result || res;
      // 대화 히스토리에도 추가
      conversationHistory.push({ role: 'user', content: `[URL 읽기 결과: ${arg}]\n${truncate(r.content || '', 10000)}` });
      return { success: true, type: 'read', title: r.title, output: truncate(r.content || '', 10000) };
    }
    case 'image': case 'img': {
      let prompt = arg, size = null;
      const sizeMatch = arg.match(/--size\s+(\S+)/);
      if (sizeMatch) { size = sizeMatch[1]; prompt = arg.replace(/--size\s+\S+/, '').trim(); }
      process.stdout.write(`${c.dim}  이미지 생성중...${c.reset}`);
      const res = await zaiGenerateImage(prompt, { size });
      process.stdout.write('\r\x1b[K');
      const url = res.data?.[0]?.url;
      if (url) {
        console.log(`  ${c.green}완료${c.reset}: ${c.cyan}${url}${c.reset}`);
        return { success: true, type: 'image', url };
      }
      return { success: false, error: '이미지 URL 없음' };
    }
    case 'video': case 'vid': {
      process.stdout.write(`${c.dim}  비디오 생성 요청중...${c.reset}`);
      const res = await zaiGenerateVideo(arg);
      process.stdout.write('\r\x1b[K');
      const taskId = res.id;
      if (!taskId) return { success: false, error: '작업 ID 없음' };
      console.log(`  작업 ID: ${c.cyan}${taskId}${c.reset}`);
      const result = await zaiPollResult(taskId);
      process.stdout.write('\r\x1b[K');
      const videos = result.video_result || [];
      if (videos.length) {
        for (const v of videos) console.log(`  ${c.green}완료${c.reset}: ${c.cyan}${v.url}${c.reset}`);
        return { success: true, type: 'video', videos: videos.map(v => v.url) };
      }
      return { success: false, error: '비디오 결과 없음' };
    }
    case 'ocr': {
      process.stdout.write(`${c.dim}  OCR 처리중...${c.reset}`);
      const res = await zaiLayoutParsing(arg);
      process.stdout.write('\r\x1b[K');
      return { success: true, type: 'ocr', output: res.md_results || '', regions: res.layout_details?.length || 0 };
    }
    case 'embed': {
      const res = await zaiEmbed(arg);
      const emb = res.data?.[0]?.embedding;
      return { success: true, type: 'embed', dimensions: emb?.length, preview: emb?.slice(0, 5) };
    }
    case 'upload': {
      process.stdout.write(`${c.dim}  업로드중...${c.reset}`);
      const res = await zaiUploadFile(arg);
      process.stdout.write('\r\x1b[K');
      console.log(`  ${c.green}완료${c.reset}: ID ${c.cyan}${res.id}${c.reset}`);
      return { success: true, type: 'upload', id: res.id, filename: res.filename };
    }
    case 'transcribe': case 'asr': {
      process.stdout.write(`${c.dim}  음성 인식중...${c.reset}`);
      const res = await zaiTranscribeAudio(arg);
      process.stdout.write('\r\x1b[K');
      const text = res.text || res.choices?.[0]?.message?.content || JSON.stringify(res);
      return { success: true, type: 'transcribe', output: text };
    }
    default:
      return { success: false, error: `지원하지 않는 명령: /${cmd}` };
  }
}

// ===== Bash 실행 =====
async function executeBashCommand(command) {
  try {
    const { stdout, stderr } = await execPromise(command, { cwd: CFG.workspace, timeout: 30000, maxBuffer: 1024*1024*10 });
    return { success: true, stdout, stderr };
  } catch (error) {
    return { success: false, error: error.message, stdout: error.stdout || '', stderr: error.stderr || '', code: error.code };
  }
}

// ===== 도구 정의 =====
const FUNCTION_TOOLS = [
  { type: 'function', function: {
    name: 'read_file', description: '파일의 내용을 읽습니다',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '읽을 파일의 경로' } }, required: ['path'] },
  }},
  { type: 'function', function: {
    name: 'write_file', description: '파일에 내용을 씁니다',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '쓸 파일의 경로' }, content: { type: 'string', description: '파일에 쓸 내용' } }, required: ['path', 'content'] },
  }},
  { type: 'function', function: {
    name: 'execute_command', description: '셸 명령을 실행합니다',
    parameters: { type: 'object', properties: { command: { type: 'string', description: '실행할 명령' } }, required: ['command'] },
  }},
  { type: 'function', function: {
    name: 'web_search', description: '인터넷에서 최신 정보를 검색합니다. 실시간 데이터나 최신 정보가 필요할 때 사용하세요.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '검색할 키워드 (간결하게, 1-6단어 권장)' } }, required: ['query'] },
  }},
  { type: 'function', function: {
    name: 'web_read', description: 'URL의 내용을 읽고 마크다운으로 반환합니다',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '읽을 URL' } }, required: ['url'] },
  }},
  { type: 'function', function: {
    name: 'generate_image', description: '텍스트 설명으로 이미지를 생성합니다',
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: '이미지 설명' }, size: { type: 'string', description: '크기 (예: 1024x1024)', enum: ['1024x1024','768x1344','864x1152','1344x768','1152x864'] } }, required: ['prompt'] },
  }},
  { type: 'function', function: {
    name: 'run_with_approval',
    description: '사용자의 승인을 받아 슬래시 명령이나 bash 명령을 실행합니다. 이미지/비디오 생성, OCR, 음성인식, 파일 업로드, 복잡한 bash 작업 등에 사용하세요. 사용 가능한 명령: /image, /video, /ocr, /embed, /upload, /transcribe, /search, /read, 또는 bash 명령.',
    parameters: { type: 'object', properties: {
      description: { type: 'string', description: '실행할 작업 설명 (사용자에게 한국어로 보여줌)' },
      command: { type: 'string', description: '실행할 명령 (예: "/image 고양이 그림", "/ocr https://url", "ffmpeg -i a.mp4 b.mp3")' },
    }, required: ['description', 'command'] },
  }},
];

// ===== 도구 실행 =====
async function executeTool(toolName, args) {
  console.log(`${c.magenta}[도구]${c.reset} ${toolName} ${c.dim}${JSON.stringify(args).slice(0,80)}${c.reset}`);
  let result;
  switch (toolName) {
    case 'read_file': {
      try {
        const fullPath = path.resolve(CFG.workspace, args.path);
        const content = fs.readFileSync(fullPath, 'utf-8');
        result = { success: true, content, lines: content.split('\n').length };
      } catch (e) { result = { success: false, error: e.message }; }
      break;
    }
    case 'write_file': {
      try {
        const fullPath = path.resolve(CFG.workspace, args.path);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, args.content, 'utf-8');
        result = { success: true, path: fullPath, bytes: Buffer.byteLength(args.content) };
      } catch (e) { result = { success: false, error: e.message }; }
      break;
    }
    case 'execute_command':
      result = await executeBashCommand(args.command);
      break;
    case 'web_search': {
      try {
        const sr = await duckDuckGoSearch(args.query);
        const formatted = sr.results.slice(0, 5).map(r => `${r.title}\n${r.snippet}\n${r.url}`).join('\n\n');
        result = { success: true, query: args.query, count: sr.count, results: formatted || '검색 결과 없음' };
      } catch (e) { result = { success: false, error: e.message }; }
      break;
    }
    case 'web_read': {
      try {
        const res = await zaiWebRead(args.url);
        const r = res.reader_result || res;
        result = { success: true, title: r.title, content: truncate(r.content || '', 10000) };
      } catch (e) { result = { success: false, error: e.message }; }
      break;
    }
    case 'generate_image': {
      try {
        const res = await zaiGenerateImage(args.prompt, { size: args.size });
        const url = res.data?.[0]?.url;
        result = url ? { success: true, url } : { success: false, error: '이미지 URL 없음' };
      } catch (e) { result = { success: false, error: e.message }; }
      break;
    }
    case 'run_with_approval': {
      console.log(`\n${c.yellow}[AI 실행 요청]${c.reset} ${args.description}`);
      console.log(`  ${c.cyan}${args.command}${c.reset}`);
      const answer = await promptUser(`  실행할까요? (${c.green}y${c.reset}/${c.red}n${c.reset}) `);
      if (answer === 'y' || answer === 'yes' || answer === 'ㅛ') {
        try {
          result = await dispatchCommand(args.command);
        } catch (e) {
          result = { success: false, error: e.message };
        }
      } else {
        console.log(`  ${c.dim}거부됨${c.reset}`);
        result = { success: false, denied: true, message: '사용자가 실행을 거부했습니다' };
      }
      break;
    }
    default:
      result = { success: false, error: `알 수 없는 도구: ${toolName}` };
  }
  console.log(`  ${result.success ? c.green + '성공' : c.red + '실패'}${c.reset}`);
  return result;
}

// ===== 메시지 전송 =====
async function sendMessage(userMessage) {
  conversationHistory.push({ role: 'user', content: userMessage });
  const startTime = Date.now();

  try {
    if (CFG.stream && IS_TTY) {
      return await sendMessageStream(startTime);
    } else {
      return await sendMessageSync(startTime);
    }
  } catch (error) {
    console.error(`\n${c.red}오류:${c.reset} ${error.message}`);
    conversationHistory.pop();
    printErrorHint(error);
    return null;
  }
}

async function sendMessageSync(startTime) {
  process.stdout.write(`${c.dim}[처리중...]${c.reset}`);
  let res = await zaiChat(conversationHistory);
  process.stdout.write('\r\x1b[K');

  // 웹 검색 결과 표시
  if (res.web_search?.length) printSearchResults(res.web_search);

  let msg = res.choices?.[0]?.message;
  if (!msg) throw new Error('응답 없음');

  // 도구 호출 루프
  while (CFG.tools && msg.tool_calls) {
    conversationHistory.push(msg);
    for (const tc of msg.tool_calls) {
      let toolArgs;
      try { toolArgs = JSON.parse(tc.function.arguments); } catch(_) { toolArgs = {}; }
      const toolResult = await executeTool(tc.function.name, toolArgs);
      conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
    }
    res = await zaiChat(conversationHistory);
    if (res.web_search?.length) printSearchResults(res.web_search);
    msg = res.choices?.[0]?.message;
    if (!msg) break;
  }

  const content = msg?.content || '';
  const reasoning = msg?.reasoning_content || '';
  if (reasoning) console.log(`${c.dim}[생각] ${reasoning}${c.reset}\n`);
  conversationHistory.push({ role: 'assistant', content });
  debugLog(`응답 시간: ${((Date.now()-startTime)/1000).toFixed(2)}초`);
  return content;
}

async function sendMessageStream(startTime) {
  let isFirstToken = true;
  let isReasoning = false;

  const result = await zaiChatStream(conversationHistory, {
    onReasoning(token) {
      if (!isReasoning) { process.stdout.write(`${c.dim}[생각] `); isReasoning = true; }
      process.stdout.write(token);
    },
    onToken(token) {
      if (isReasoning) { process.stdout.write(`${c.reset}\n\n`); isReasoning = false; }
      if (isFirstToken) { process.stdout.write(`${c.green}AI>${c.reset} `); isFirstToken = false; }
      process.stdout.write(token);
    },
    onSearchResult(results) { printSearchResults(results); },
    onUsage(u) { lastUsage = u; },
  });

  if (isReasoning) process.stdout.write(c.reset);
  if (!isFirstToken) process.stdout.write('\n');

  // 도구 호출 처리
  if (result.toolCalls && CFG.tools) {
    const assistantMsg = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls };
    conversationHistory.push(assistantMsg);

    for (const tc of result.toolCalls) {
      let toolArgs;
      try { toolArgs = JSON.parse(tc.function.arguments); } catch(_) { toolArgs = {}; }
      const toolResult = await executeTool(tc.function.name, toolArgs);
      conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
    }

    // 도구 실행 후 재호출 (스트리밍)
    isFirstToken = true;
    isReasoning = false;
    const result2 = await zaiChatStream(conversationHistory, {
      onReasoning(token) {
        if (!isReasoning) { process.stdout.write(`${c.dim}[생각] `); isReasoning = true; }
        process.stdout.write(token);
      },
      onToken(token) {
        if (isReasoning) { process.stdout.write(`${c.reset}\n\n`); isReasoning = false; }
        if (isFirstToken) { process.stdout.write(`${c.green}AI>${c.reset} `); isFirstToken = false; }
        process.stdout.write(token);
      },
      onSearchResult(results) { printSearchResults(results); },
      onUsage(u) { lastUsage = u; },
    });
    if (isReasoning) process.stdout.write(c.reset);
    if (!isFirstToken) process.stdout.write('\n');

    conversationHistory.push({ role: 'assistant', content: result2.content || '' });
    debugLog(`응답 시간: ${((Date.now()-startTime)/1000).toFixed(2)}초`);
    return result2.content;
  }

  conversationHistory.push({ role: 'assistant', content: result.content || '' });
  debugLog(`응답 시간: ${((Date.now()-startTime)/1000).toFixed(2)}초`);
  return result.content;
}

function printSearchResults(results) {
  if (!results?.length) return;
  console.log(`${c.blue}[웹 검색 참조]${c.reset}`);
  for (const r of results.slice(0, 5)) {
    console.log(`  ${c.dim}${r.title || ''}${c.reset} ${c.blue}${r.link || ''}${c.reset}`);
  }
  console.log('');
}

function printErrorHint(error) {
  const msg = error.message;
  if (msg.includes('타임아웃')) console.error(`  ${c.yellow}힌트: /clear 로 대화 초기화${c.reset}`);
  else if (msg.includes('401') || msg.includes('403')) console.error(`  ${c.yellow}힌트: export ZAI_API_KEY="your-key"${c.reset}`);
  else if (msg.includes('429')) console.error(`  ${c.yellow}힌트: 요청 한도 초과, 잠시 후 재시도${c.reset}`);
  else if (msg.includes('500') || msg.includes('502') || msg.includes('503')) console.error(`  ${c.yellow}힌트: API 서비스 상태 확인${c.reset}`);
}

// ===== 슬래시 명령어 =====
async function handleSlashCommand(input, rl) {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case 'exit': case 'quit': case 'q':
      console.log(`\n${c.dim}종료합니다.${c.reset}`);
      process.exit(0);

    case 'clear': case 'reset':
      conversationHistory.length = 1;
      lastUsage = null;
      console.log(`${c.green}대화 기록 초기화${c.reset}\n`);
      break;

    case 'help': case 'h':
      printHelp();
      break;

    case 'status': case 'info':
      printStatus();
      break;

    case 'model': case 'm':
      if (!arg) {
        console.log(`\n${c.bold}사용 가능한 모델:${c.reset}`);
        for (const [name, desc] of Object.entries(MODELS)) {
          const marker = name === CFG.model ? ` ${c.green}<- 현재${c.reset}` : '';
          console.log(`  ${c.cyan}${name.padEnd(24)}${c.reset} ${desc}${marker}`);
        }
        console.log(`\n  사용법: /model <이름>\n`);
      } else {
        CFG.model = arg;
        console.log(`${c.green}모델 변경: ${arg}${c.reset}\n`);
      }
      break;

    case 'stream':
      CFG.stream = !CFG.stream;
      console.log(`스트리밍: ${CFG.stream ? c.green + 'ON' : c.red + 'OFF'}${c.reset}\n`);
      break;

    case 'think':
      CFG.think = !CFG.think;
      console.log(`사고 모드: ${CFG.think ? c.green + 'ON' : c.red + 'OFF'}${c.reset}\n`);
      break;

    case 'tools':
      CFG.tools = !CFG.tools;
      console.log(`도구 호출: ${CFG.tools ? c.green + 'ON' : c.red + 'OFF'}${c.reset}\n`);
      break;

    case 'websearch': case 'ws':
      CFG.webSearch = !CFG.webSearch;
      console.log(`웹 검색: ${CFG.webSearch ? c.green + 'ON' : c.red + 'OFF'}${c.reset}\n`);
      break;

    case 'json':
      CFG.jsonMode = !CFG.jsonMode;
      console.log(`JSON 모드: ${CFG.jsonMode ? c.green + 'ON' : c.red + 'OFF'}${c.reset}\n`);
      break;

    case 'search': case 's':
      if (!arg) { console.log(`  사용법: /search <검색어>\n`); break; }
      await cmdSearchDDG(arg);
      break;

    case 'zsearch': case 'zs':
      if (!arg) { console.log(`  사용법: /zsearch <검색어>  (search-prime)\n`); break; }
      await cmdSearchZai(arg);
      break;

    case 'read': case 'r':
      if (!arg) { console.log(`  사용법: /read <URL>\n`); break; }
      await cmdRead(arg);
      break;

    case 'image': case 'img':
      if (!arg) { console.log(`  사용법: /image <프롬프트> [--size 1024x1024]\n`); break; }
      await cmdImage(arg);
      break;

    case 'video': case 'vid':
      if (!arg) { console.log(`  사용법: /video <프롬프트>\n`); break; }
      await cmdVideo(arg);
      break;

    case 'poll':
      if (!arg) { console.log(`  사용법: /poll <task_id>\n`); break; }
      await cmdPoll(arg);
      break;

    case 'ocr':
      if (!arg) { console.log(`  사용법: /ocr <이미지/PDF URL>\n`); break; }
      await cmdOcr(arg);
      break;

    case 'embed':
      if (!arg) { console.log(`  사용법: /embed <텍스트>\n`); break; }
      await cmdEmbed(arg);
      break;

    case 'tokens': case 'tok':
      await cmdTokens();
      break;

    case 'upload':
      if (!arg) { console.log(`  사용법: /upload <파일경로>\n`); break; }
      await cmdUpload(arg);
      break;

    case 'transcribe': case 'asr':
      if (!arg) { console.log(`  사용법: /transcribe <오디오파일>\n`); break; }
      await cmdTranscribe(arg);
      break;

    case 'save':
      cmdSave(arg || `session-${Date.now()}`);
      break;

    case 'load':
      if (!arg) { cmdListSessions(); break; }
      cmdLoad(arg);
      break;

    case 'sessions':
      cmdListSessions();
      break;

    case 'config': case 'cfg':
      if (!arg) { printConfig(); }
      else { cmdSetConfig(arg); }
      break;

    case 'history':
      cmdHistory();
      break;

    case 'pop':
      cmdPop();
      break;

    case 'doctor': case 'diag':
      await cmdDoctor();
      break;

    default:
      console.log(`${c.red}알 수 없는 명령어: /${cmd}${c.reset}`);
      console.log(`  /help 로 명령어 목록 확인\n`);
  }
}

// ===== 명령어 구현 =====
async function cmdSearchDDG(query) {
  try {
    process.stdout.write(`${c.dim}DuckDuckGo 검색중...${c.reset}`);
    const res = await duckDuckGoSearch(query);
    process.stdout.write('\r\x1b[K');
    if (!res.results.length) { console.log(`${c.yellow}검색 결과 없음${c.reset}\n`); return; }
    console.log(`${c.bold}검색 결과: "${query}"${c.reset} (${res.count}건)\n`);
    for (const r of res.results.slice(0, 10)) {
      console.log(`  ${c.cyan}${r.title}${c.reset}`);
      if (r.snippet) console.log(`  ${c.dim}${r.snippet.slice(0, 150)}${c.reset}`);
      if (r.url) console.log(`  ${c.blue}${r.url}${c.reset}`);
      console.log('');
    }
  } catch (e) { console.error(`${c.red}검색 실패: ${e.message}${c.reset}\n`); }
}

async function cmdSearchZai(query) {
  try {
    process.stdout.write(`${c.dim}검색중 (search-prime)...${c.reset}`);
    const res = await zaiWebSearch(query);
    process.stdout.write('\r\x1b[K');
    const results = res.search_result || [];
    if (!results.length) { console.log(`${c.yellow}검색 결과 없음${c.reset}\n`); return; }
    console.log(`${c.bold}검색: "${query}"${c.reset} (${results.length}건)\n`);
    for (const r of results.slice(0, 10)) {
      console.log(`  ${c.cyan}${r.title}${c.reset}`);
      if (r.content) console.log(`  ${c.dim}${r.content.slice(0, 150)}${c.reset}`);
      if (r.link) console.log(`  ${c.blue}${r.link}${c.reset}`);
      console.log('');
    }
  } catch (e) { console.error(`${c.red}검색 실패: ${e.message}${c.reset}\n`); }
}

async function cmdRead(url) {
  try {
    process.stdout.write(`${c.dim}읽는중...${c.reset}`);
    const res = await zaiWebRead(url);
    process.stdout.write('\r\x1b[K');
    const r = res.reader_result || res;
    if (r.title) console.log(`${c.bold}${r.title}${c.reset}\n`);
    console.log(truncate(r.content || '내용 없음', 5000));
    console.log('');
    // 대화 히스토리에 추가
    conversationHistory.push({ role: 'user', content: `[URL 읽기 결과: ${url}]\n${truncate(r.content || '', 10000)}` });
  } catch (e) { console.error(`${c.red}읽기 실패: ${e.message}${c.reset}\n`); }
}

async function cmdImage(input) {
  let prompt = input, size = null;
  const sizeMatch = input.match(/--size\s+(\S+)/);
  if (sizeMatch) { size = sizeMatch[1]; prompt = input.replace(/--size\s+\S+/, '').trim(); }

  try {
    process.stdout.write(`${c.dim}이미지 생성중...${c.reset}`);
    const res = await zaiGenerateImage(prompt, { size });
    process.stdout.write('\r\x1b[K');
    const url = res.data?.[0]?.url;
    if (url) {
      console.log(`${c.green}이미지 생성 완료${c.reset}`);
      console.log(`  ${c.cyan}${url}${c.reset}`);
      console.log(`  ${c.dim}(30일 후 만료)${c.reset}\n`);
    } else {
      console.log(`${c.yellow}이미지 URL을 받지 못했습니다${c.reset}\n`);
    }
  } catch (e) { console.error(`${c.red}이미지 생성 실패: ${e.message}${c.reset}\n`); }
}

async function cmdVideo(input) {
  let prompt = input, opts = {};
  if (input.match(/--audio/)) { opts.withAudio = true; prompt = prompt.replace(/--audio/, '').trim(); }
  if (input.match(/--duration\s+(\d+)/)) { opts.duration = parseInt(RegExp.$1); prompt = prompt.replace(/--duration\s+\d+/, '').trim(); }
  if (input.match(/--fps\s+(\d+)/)) { opts.fps = parseInt(RegExp.$1); prompt = prompt.replace(/--fps\s+\d+/, '').trim(); }

  try {
    console.log(`${c.dim}비디오 생성 요청중...${c.reset}`);
    const res = await zaiGenerateVideo(prompt, opts);
    const taskId = res.id;
    if (!taskId) { console.log(`${c.yellow}작업 ID를 받지 못했습니다${c.reset}\n`); return; }
    console.log(`  작업 ID: ${c.cyan}${taskId}${c.reset}`);
    console.log(`${c.dim}폴링중... (최대 5분)${c.reset}`);
    const result = await zaiPollResult(taskId);
    process.stdout.write('\r\x1b[K');
    const videos = result.video_result || [];
    if (videos.length) {
      console.log(`${c.green}비디오 생성 완료${c.reset}`);
      for (const v of videos) {
        console.log(`  ${c.cyan}${v.url}${c.reset}`);
        if (v.cover_image_url) console.log(`  커버: ${c.dim}${v.cover_image_url}${c.reset}`);
      }
    } else {
      console.log(`${c.yellow}비디오 결과 없음${c.reset}`);
    }
    console.log('');
  } catch (e) { console.error(`\n${c.red}비디오 생성 실패: ${e.message}${c.reset}\n`); }
}

async function cmdPoll(taskId) {
  try {
    const res = await zaiAsyncResult(taskId);
    console.log(`  상태: ${c.bold}${res.task_status}${c.reset}`);
    if (res.video_result) {
      for (const v of res.video_result) console.log(`  URL: ${c.cyan}${v.url}${c.reset}`);
    }
    console.log('');
  } catch (e) { console.error(`${c.red}조회 실패: ${e.message}${c.reset}\n`); }
}

async function cmdOcr(fileUrl) {
  try {
    process.stdout.write(`${c.dim}OCR 처리중...${c.reset}`);
    const res = await zaiLayoutParsing(fileUrl);
    process.stdout.write('\r\x1b[K');
    if (res.md_results) {
      console.log(`${c.bold}OCR 결과:${c.reset}\n`);
      console.log(truncate(res.md_results, 5000));
    }
    if (res.layout_details?.length) {
      console.log(`\n${c.dim}레이아웃: ${res.layout_details.length}개 영역 감지${c.reset}`);
    }
    if (res.usage) console.log(`${c.dim}토큰: ${res.usage.total_tokens}${c.reset}`);
    console.log('');
  } catch (e) { console.error(`${c.red}OCR 실패: ${e.message}${c.reset}\n`); }
}

async function cmdEmbed(text) {
  try {
    process.stdout.write(`${c.dim}임베딩 생성중...${c.reset}`);
    const res = await zaiEmbed(text);
    process.stdout.write('\r\x1b[K');
    const data = res.data;
    if (data?.length) {
      const emb = data[0].embedding;
      console.log(`${c.bold}임베딩 결과${c.reset}`);
      console.log(`  차원: ${emb.length}`);
      console.log(`  처음 10개: [${emb.slice(0, 10).map(v => v.toFixed(6)).join(', ')}...]`);
      if (res.usage) console.log(`  토큰: ${res.usage.total_tokens}`);
    }
    console.log('');
  } catch (e) { console.error(`${c.red}임베딩 실패: ${e.message}${c.reset}\n`); }
}

async function cmdTokens() {
  if (conversationHistory.length <= 1) { console.log(`${c.yellow}대화 기록이 비어있습니다${c.reset}\n`); return; }
  try {
    process.stdout.write(`${c.dim}토큰 계산중...${c.reset}`);
    const res = await zaiTokenize(conversationHistory);
    process.stdout.write('\r\x1b[K');
    const u = res.usage || {};
    console.log(`${c.bold}토큰 사용량${c.reset}`);
    if (u.prompt_tokens) console.log(`  프롬프트: ${u.prompt_tokens}`);
    if (u.image_tokens) console.log(`  이미지: ${u.image_tokens}`);
    if (u.video_tokens) console.log(`  비디오: ${u.video_tokens}`);
    console.log(`  합계: ${u.total_tokens || '?'}`);
    console.log('');
  } catch (e) { console.error(`${c.red}토큰 계산 실패: ${e.message}${c.reset}\n`); }
}

async function cmdUpload(filePath) {
  const fullPath = path.resolve(CFG.workspace, filePath);
  if (!fs.existsSync(fullPath)) { console.log(`${c.red}파일 없음: ${fullPath}${c.reset}\n`); return; }
  try {
    const stat = fs.statSync(fullPath);
    console.log(`${c.dim}업로드중... (${formatBytes(stat.size)})${c.reset}`);
    const res = await zaiUploadFile(filePath);
    console.log(`${c.green}업로드 완료${c.reset}`);
    console.log(`  ID: ${c.cyan}${res.id}${c.reset}`);
    console.log(`  파일: ${res.filename} (${formatBytes(res.bytes)})`);
    console.log('');
  } catch (e) { console.error(`${c.red}업로드 실패: ${e.message}${c.reset}\n`); }
}

async function cmdTranscribe(filePath) {
  const fullPath = path.resolve(CFG.workspace, filePath);
  if (!fs.existsSync(fullPath)) { console.log(`${c.red}파일 없음: ${fullPath}${c.reset}\n`); return; }
  try {
    const stat = fs.statSync(fullPath);
    console.log(`${c.dim}음성 인식중... (${formatBytes(stat.size)})${c.reset}`);
    const res = await zaiTranscribeAudio(filePath);
    console.log(`${c.bold}음성 인식 결과:${c.reset}\n`);
    if (res.text) console.log(res.text);
    else if (res.choices?.[0]?.message?.content) console.log(res.choices[0].message.content);
    else console.log(JSON.stringify(res, null, 2));
    console.log('');
  } catch (e) { console.error(`${c.red}음성 인식 실패: ${e.message}${c.reset}\n`); }
}

function cmdSave(name) {
  ensureDir(SESSIONS_DIR);
  const file = path.join(SESSIONS_DIR, `${name}.json`);
  const data = { name, model: CFG.model, date: new Date().toISOString(), messages: conversationHistory };
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`${c.green}세션 저장: ${name}${c.reset}`);
  console.log(`  ${c.dim}${file}${c.reset}\n`);
}

function cmdLoad(name) {
  const file = path.join(SESSIONS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    // 부분 일치 시도
    const matches = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.includes(name)) : [];
    if (matches.length === 1) return cmdLoad(matches[0].replace('.json', ''));
    if (matches.length > 1) {
      console.log(`${c.yellow}여러 세션 발견:${c.reset}`);
      matches.forEach(m => console.log(`  ${m.replace('.json', '')}`));
      console.log('');
      return;
    }
    console.log(`${c.red}세션 없음: ${name}${c.reset}\n`);
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    conversationHistory.length = 0;
    conversationHistory.push(...data.messages);
    console.log(`${c.green}세션 로드: ${data.name}${c.reset}`);
    console.log(`  모델: ${data.model}, 메시지: ${data.messages.length}, 날짜: ${data.date}`);
    console.log('');
  } catch (e) { console.error(`${c.red}로드 실패: ${e.message}${c.reset}\n`); }
}

function cmdListSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) { console.log(`${c.dim}저장된 세션 없음${c.reset}\n`); return; }
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log(`${c.dim}저장된 세션 없음${c.reset}\n`); return; }
  console.log(`${c.bold}저장된 세션:${c.reset}\n`);
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
      const name = f.replace('.json', '');
      console.log(`  ${c.cyan}${name.padEnd(30)}${c.reset} ${c.dim}${data.model || '?'} | ${data.messages?.length || 0}msg | ${data.date || '?'}${c.reset}`);
    } catch (_) {
      console.log(`  ${f.replace('.json', '')}`);
    }
  }
  console.log(`\n  사용법: /load <이름>\n`);
}

function printConfig() {
  console.log(`\n${c.bold}현재 설정:${c.reset}`);
  console.log(`  ${c.cyan}model${c.reset}       = ${CFG.model}`);
  console.log(`  ${c.cyan}stream${c.reset}      = ${CFG.stream}`);
  console.log(`  ${c.cyan}think${c.reset}       = ${CFG.think}`);
  console.log(`  ${c.cyan}tools${c.reset}       = ${CFG.tools}`);
  console.log(`  ${c.cyan}webSearch${c.reset}   = ${CFG.webSearch}`);
  console.log(`  ${c.cyan}jsonMode${c.reset}    = ${CFG.jsonMode}`);
  console.log(`  ${c.cyan}maxTokens${c.reset}   = ${CFG.maxTokens}`);
  console.log(`  ${c.cyan}temperature${c.reset} = ${CFG.temperature}`);
  console.log(`  ${c.cyan}baseUrl${c.reset}     = ${CFG.baseUrl}`);
  console.log(`  ${c.cyan}chatPath${c.reset}    = ${CFG.chatPath}`);
  console.log(`  ${c.cyan}apiPrefix${c.reset}   = ${CFG.apiPrefix}`);
  console.log(`  ${c.cyan}workspace${c.reset}   = ${CFG.workspace}`);
  console.log(`  ${c.cyan}apiKey${c.reset}      = ${CFG.apiKey ? '***' + CFG.apiKey.slice(-4) : '(없음)'}`);
  console.log(`\n  ${c.dim}사용법: /config <키> <값>  (예: /config model glm-4.7)${c.reset}`);
  console.log(`  ${c.dim}/config save 로 현재 설정 저장${c.reset}\n`);
}

function cmdSetConfig(arg) {
  const parts = arg.split(/\s+/);
  const key = parts[0];
  const val = parts.slice(1).join(' ');

  if (key === 'save') {
    const cfg = { model: CFG.model, stream: CFG.stream, think: CFG.think, tools: CFG.tools,
      webSearch: CFG.webSearch, maxTokens: CFG.maxTokens, temperature: CFG.temperature,
      baseUrl: CFG.baseUrl, chatPath: CFG.chatPath, apiPrefix: CFG.apiPrefix };
    if (CFG.apiKey) cfg.apiKey = CFG.apiKey;
    saveConfig(cfg);
    console.log(`${c.green}설정 저장 완료${c.reset}: ${CONFIG_FILE}\n`);
    return;
  }

  if (!val) { console.log(`${c.yellow}값이 필요합니다${c.reset}: /config ${key} <값>\n`); return; }

  const boolKeys = ['stream', 'think', 'tools', 'webSearch', 'jsonMode', 'debug'];
  const numKeys = ['maxTokens', 'temperature'];
  const strKeys = ['model', 'baseUrl', 'chatPath', 'apiPrefix', 'apiKey', 'workspace'];

  if (boolKeys.includes(key)) {
    CFG[key] = val === 'true' || val === '1' || val === 'on';
    console.log(`${c.green}${key} = ${CFG[key]}${c.reset}\n`);
  } else if (numKeys.includes(key)) {
    CFG[key] = key === 'temperature' ? parseFloat(val) : parseInt(val);
    console.log(`${c.green}${key} = ${CFG[key]}${c.reset}\n`);
  } else if (strKeys.includes(key)) {
    CFG[key] = val;
    console.log(`${c.green}${key} = ${val}${c.reset}\n`);
  } else {
    console.log(`${c.red}알 수 없는 설정: ${key}${c.reset}\n`);
  }
}

function cmdHistory() {
  console.log(`\n${c.bold}대화 기록 (${conversationHistory.length}개 메시지):${c.reset}\n`);
  for (let i = 0; i < conversationHistory.length; i++) {
    const m = conversationHistory[i];
    const role = m.role;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const prefix = role === 'system' ? c.dim + '[시스템]' : role === 'user' ? c.cyan + '[사용자]' : role === 'assistant' ? c.green + '[AI]' : c.magenta + `[${role}]`;
    console.log(`  ${prefix}${c.reset} ${truncate(content || '(빈 내용)', 100).split('\n')[0]}`);
  }
  console.log('');
}

function cmdPop() {
  if (conversationHistory.length <= 1) { console.log(`${c.yellow}제거할 메시지가 없습니다${c.reset}\n`); return; }
  // 마지막 user+assistant 쌍 제거
  let removed = 0;
  while (conversationHistory.length > 1 && removed < 2) {
    const last = conversationHistory[conversationHistory.length - 1];
    if (last.role === 'system') break;
    conversationHistory.pop();
    removed++;
  }
  console.log(`${c.green}마지막 대화 쌍 제거 (${removed}개)${c.reset}\n`);
}

async function cmdDoctor() {
  console.log(`\n${c.bold}=== 진단 ===${c.reset}\n`);

  // 시스템 정보
  console.log(`${c.cyan}시스템${c.reset}`);
  console.log(`  OS: ${os.platform()} ${os.arch()} ${os.release()}`);
  console.log(`  Node.js: ${process.version}`);
  console.log(`  메모리: ${formatBytes(os.freemem())} / ${formatBytes(os.totalmem())}`);
  console.log(`  CPU: ${os.cpus()[0]?.model || '?'} x${os.cpus().length}`);
  console.log('');

  // 설정 상태
  console.log(`${c.cyan}설정${c.reset}`);
  console.log(`  API 키: ${CFG.apiKey ? c.green + '설정됨 (***' + CFG.apiKey.slice(-4) + ')' + c.reset : c.red + '미설정' + c.reset}`);
  console.log(`  서버: ${CFG.baseUrl}`);
  console.log(`  모델: ${CFG.model}`);
  console.log(`  설정파일: ${fs.existsSync(CONFIG_FILE) ? c.green + '있음' + c.reset : c.dim + '없음' + c.reset}`);
  console.log('');

  // API 연결 테스트
  if (CFG.apiKey) {
    console.log(`${c.cyan}API 연결 테스트${c.reset}`);
    try {
      const start = Date.now();
      const res = await zaiTokenize([{ role: 'user', content: '안녕' }]);
      const ms = Date.now() - start;
      console.log(`  토크나이저: ${c.green}OK${c.reset} (${ms}ms, ${res.usage?.total_tokens || '?'}토큰)`);
    } catch (e) {
      console.log(`  토크나이저: ${c.red}실패${c.reset} - ${e.message}`);
    }

    try {
      const start = Date.now();
      const res = await zaiWebSearch('test');
      const ms = Date.now() - start;
      const count = res.search_result?.length || 0;
      console.log(`  웹 검색: ${c.green}OK${c.reset} (${ms}ms, ${count}건)`);
    } catch (e) {
      console.log(`  웹 검색: ${c.red}실패${c.reset} - ${e.message}`);
    }

    try {
      const start = Date.now();
      const res = await apiPost(CFG.chatPath, {
        model: CFG.model, messages: [{ role: 'user', content: '1+1=' }], max_tokens: 5,
      });
      const ms = Date.now() - start;
      const answer = res.choices?.[0]?.message?.content || '';
      console.log(`  채팅 (${CFG.model}): ${c.green}OK${c.reset} (${ms}ms) "${answer.trim().slice(0,30)}"`);
    } catch (e) {
      console.log(`  채팅 (${CFG.model}): ${c.red}실패${c.reset} - ${e.message}`);
    }
  }
  console.log('');
}

function printHelp() {
  console.log(`
${c.bold}=== Light-zai v${VERSION} 명령어 ===${c.reset}

${c.cyan}대화${c.reset}
  /clear          대화 기록 초기화
  /history        대화 기록 보기
  /pop            마지막 대화 쌍 제거
  /save [이름]    세션 저장
  /load [이름]    세션 로드
  /sessions       저장된 세션 목록

${c.cyan}설정${c.reset}
  /model [이름]   모델 변경/목록
  /stream         스트리밍 토글
  /think          사고 모드 토글
  /tools          도구 호출 토글
  /websearch      웹 검색 토글
  /json           JSON 모드 토글
  /config [키 값] 설정 보기/변경
  /config save    설정 파일로 저장

${c.cyan}API / 검색${c.reset}
  /search <검색어>    웹 검색 (DuckDuckGo)
  /zsearch <검색어>   웹 검색 (search-prime)
  /read <URL>         URL 읽기 (웹 리더)
  /image <프롬프트>   이미지 생성 [--size WxH]
  /video <프롬프트>   비디오 생성 [--audio] [--duration N] [--fps N]
  /poll <작업ID>      비동기 작업 결과 조회
  /ocr <URL>          OCR 레이아웃 파싱
  /embed <텍스트>     텍스트 임베딩
  /tokens             현재 대화 토큰 수
  /upload <파일>      파일 업로드
  /transcribe <파일>  음성 인식 (ASR)

${c.cyan}기타${c.reset}
  /doctor         시스템 진단
  /status         현재 상태
  /help           이 도움말
  /exit           종료
  ${c.bold}!${c.reset}              Bash 모드 전환 (exit로 복귀)
`);
}

function printStatus() {
  const msgCount = conversationHistory.length - 1;
  const turns = Math.floor(msgCount / 2);
  console.log(`
${c.bold}현재 상태${c.reset}
  모드:     ${bashMode ? c.yellow + 'Bash' : c.green + 'AI'}${c.reset}
  모델:     ${c.cyan}${CFG.model}${c.reset}
  대화:     ${turns}턴 (${conversationHistory.length}메시지)
  스트리밍: ${CFG.stream ? c.green + 'ON' : c.dim + 'OFF'}${c.reset}
  사고:     ${CFG.think ? c.green + 'ON' : c.dim + 'OFF'}${c.reset}
  도구:     ${CFG.tools ? c.green + 'ON' : c.dim + 'OFF'}${c.reset}
  웹검색:   ${CFG.webSearch ? c.green + 'ON' : c.dim + 'OFF'}${c.reset}
  JSON:     ${CFG.jsonMode ? c.green + 'ON' : c.dim + 'OFF'}${c.reset}
  디렉토리: ${CFG.workspace}${lastUsage ? `\n  마지막 토큰: 입력 ${lastUsage.prompt_tokens || '?'} + 출력 ${lastUsage.completion_tokens || '?'} = 합계 ${lastUsage.total_tokens || '?'}` : ''}
`);
}

// ===== 스플래시 화면 =====
function showSplash() {
  if (!IS_TTY) return;
  console.log(`
${c.cyan}  ╔═════════════════════════════════════════════╗
  ║${c.reset}${c.bold}          Light-zai v${VERSION}                ${c.reset}${c.cyan}║
  ║${c.reset}     경량 올인원 AI 코딩 어시스턴트          ${c.cyan}║
  ║${c.reset}${c.dim}   ARM7L / x86_64 / aarch64 — 무의존성       ${c.reset}${c.cyan}║
  ╚═════════════════════════════════════════════╝${c.reset}
  ${c.dim}모델: ${CFG.model} | 서버: ${CFG.baseUrl}${c.reset}
  ${c.dim}스트리밍: ${CFG.stream ? 'ON' : 'OFF'} | 사고: ${CFG.think ? 'ON' : 'OFF'} | 도구: ${CFG.tools ? 'ON' : 'OFF'} | 웹검색: ${CFG.webSearch ? 'ON' : 'OFF'}${c.reset}
  ${c.dim}/help 로 명령어 확인 | ! 로 Bash 전환${c.reset}
`);
}

// ===== 원샷 모드 =====
async function runOneShot(question) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
  conversationHistory.push({ role: 'system', content: `당신은 전문적인 코딩 어시스턴트입니다.\n현재 날짜: ${dateStr}\n간결하고 정확하게 답변하세요. 한국어로 답변하세요.` });

  if (CFG.stream && IS_TTY) {
    conversationHistory.push({ role: 'user', content: question });
    let started = false;
    await zaiChatStream(conversationHistory, {
      onToken(token) { if (!started) { started = true; } process.stdout.write(token); },
      onReasoning(token) { process.stdout.write(`${c.dim}${token}${c.reset}`); },
    });
    if (started) process.stdout.write('\n');
  } else {
    conversationHistory.push({ role: 'user', content: question });
    process.stdout.write(`${c.dim}[처리중...]${c.reset}`);
    const res = await zaiChat(conversationHistory);
    process.stdout.write('\r\x1b[K');
    const content = res.choices?.[0]?.message?.content;
    if (content) console.log(content);
  }
}

// ===== CLI 인자 파싱 =====
function parseCLIArgs() {
  const args = process.argv.slice(2);
  const result = { mode: 'repl', question: null, flag: null, value: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--version' || arg === '-v') { result.mode = 'version'; return result; }
    if (arg === '--help' || arg === '-h') { result.mode = 'help'; return result; }
    if (arg === '--doctor') { result.mode = 'doctor'; return result; }
    if (arg === '--image') { result.mode = 'image'; result.value = args.slice(i+1).join(' '); return result; }
    if (arg === '--search') { result.mode = 'search'; result.value = args.slice(i+1).join(' '); return result; }
    if (arg === '--read') { result.mode = 'read'; result.value = args[i+1]; return result; }
    if (arg === '--ocr') { result.mode = 'ocr'; result.value = args[i+1]; return result; }
    if (arg === '--embed') { result.mode = 'embed'; result.value = args.slice(i+1).join(' '); return result; }
    if (!arg.startsWith('-')) {
      result.mode = 'oneshot';
      result.question = args.slice(i).join(' ');
      return result;
    }
  }
  return result;
}

// ===== REPL 메인 =====
async function main() {
  const cli = parseCLIArgs();

  // 원샷 모드 처리
  if (cli.mode === 'version') { console.log(`${APP_NAME} v${VERSION}`); return; }
  if (cli.mode === 'help') { printHelp(); return; }
  if (cli.mode === 'doctor') { await cmdDoctor(); return; }

  // API 키 확인
  if (!CFG.apiKey) {
    console.error(`${c.red}오류: ZAI_API_KEY 환경 변수가 설정되지 않았습니다.${c.reset}`);
    console.error(`사용법: export ZAI_API_KEY="your-api-key"`);
    console.error(`  또는: /config apiKey <키> 로 설정 후 /config save`);
    process.exit(1);
  }

  if (cli.mode === 'oneshot') { await runOneShot(cli.question); return; }
  if (cli.mode === 'image') { await cmdImage(cli.value); return; }
  if (cli.mode === 'search') { await cmdSearchDDG(cli.value); return; }
  if (cli.mode === 'read') { await cmdRead(cli.value); return; }
  if (cli.mode === 'ocr') { await cmdOcr(cli.value); return; }
  if (cli.mode === 'embed') { await cmdEmbed(cli.value); return; }

  // 파이프 입력 처리
  if (!IS_TTY) {
    let input = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) input += chunk;
    if (input.trim()) await runOneShot(input.trim());
    return;
  }

  // ===== REPL 모드 =====
  showSplash();

  // 시스템 프롬프트
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
  const timeStr = now.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', hour12: false });

  let systemPrompt = `당신은 전문적인 코딩 어시스턴트입니다.

현재 날짜와 시간: ${dateStr} ${timeStr}
작업 디렉토리: ${CFG.workspace}
`;

  if (CFG.tools) {
    systemPrompt += `
사용 가능한 도구:
- read_file: 파일 읽기 (워크스페이스 기준 상대/절대 경로)
- write_file: 파일 쓰기 (디렉토리 자동 생성)
- execute_command: 셸 명령 실행 (30초 타임아웃)
- web_search: 인터넷 검색 (DuckDuckGo, 최신 정보/실시간 데이터)
- web_read: URL 내용을 마크다운으로 읽기
- generate_image: 텍스트로 이미지 생성
- run_with_approval: 사용자 승인 후 명령 실행 (아래 참고)

run_with_approval로 실행 가능한 명령:
  /image <프롬프트> — 이미지 생성
  /video <프롬프트> — 비디오 생성
  /ocr <이미지URL> — OCR 텍스트 추출
  /embed <텍스트> — 텍스트 임베딩
  /upload <파일경로> — 파일 업로드
  /transcribe <오디오파일> — 음성 인식
  /search <검색어> — 웹 검색
  /read <URL> — URL 읽기
  bash 명령도 가능 (예: ffmpeg, curl 등)

사용자에게 부담이 되는 복잡한 명령은 run_with_approval로 대신 입력해주세요.
최신 정보가 필요하면 web_search를 적극 활용하세요.
`;
  }

  if (CFG.webSearch) {
    systemPrompt += `내장 웹 검색이 활성화되어 있습니다. (/websearch 로 토글)\n`;
  }

  systemPrompt += '한국어로 답변하세요.';

  conversationHistory.push({ role: 'system', content: systemPrompt });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  _rl = rl;

  function getPrompt() {
    if (bashMode) return `${c.yellow}bash${c.reset}:${path.basename(CFG.workspace)}$ `;
    return `${c.cyan}사용자${c.reset}> `;
  }

  function prompt() { rl.setPrompt(getPrompt()); rl.prompt(); }

  prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    // Bash 모드 토글
    if (input === '!') {
      bashMode = !bashMode;
      console.log(bashMode ? `\n${c.yellow}Bash 모드${c.reset} (exit 로 복귀)\n` : `\n${c.green}AI 모드${c.reset}\n`);
      prompt(); return;
    }

    // Bash 모드
    if (bashMode) {
      if (input === 'exit') { bashMode = false; console.log(`\n${c.green}AI 모드${c.reset}\n`); prompt(); return; }
      console.log('');
      const result = await executeBashCommand(input);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (!result.success && result.code) console.error(`[exit code: ${result.code}]`);
      console.log('');

      const MAX_OUTPUT = 10000;
      let stdout = truncate(result.stdout || '', MAX_OUTPUT);
      let stderr = truncate(result.stderr || '', MAX_OUTPUT);
      conversationHistory.push({
        role: 'user',
        content: `[Bash 명령 실행]\n명령: ${input}\n출력:\n${stdout}${stderr}${!result.success ? `\n[실패: exit code ${result.code}]` : ''}`,
      });
      prompt(); return;
    }

    // 슬래시 명령어
    if (input.startsWith('/')) {
      await handleSlashCommand(input, rl);
      prompt(); return;
    }

    // AI 메시지
    try {
      const response = await sendMessage(input);
      if (response && !CFG.stream) {
        console.log(`${c.green}AI>${c.reset} ${response}\n`);
      } else if (response) {
        console.log(''); // 스트리밍 후 줄바꿈
      }
    } catch (error) {
      console.error(`\n${c.red}오류: ${error.message}${c.reset}\n`);
    }
    prompt();
  });

  rl.on('close', () => { console.log(`\n${c.dim}종료합니다.${c.reset}`); process.exit(0); });
  process.on('SIGINT', () => { console.log(`\n\n${c.dim}종료합니다.${c.reset}`); process.exit(0); });
}

main().catch((error) => {
  console.error(`${c.red}치명적 오류:${c.reset}`, error.message);
  if (CFG.debug) console.error(error.stack);
  process.exit(1);
});
