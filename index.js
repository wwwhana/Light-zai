#!/usr/bin/env node
'use strict';

const https = require('https');
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
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
const PRESETS_DIR = path.join(CONFIG_DIR, 'presets');
const SKILLS_DIR = path.join(CONFIG_DIR, 'skills');
const MCP_CONFIG_FILE = path.join(CONFIG_DIR, 'mcp.json');
const USAGE_LOG_FILE = path.join(CONFIG_DIR, 'usage-log.json');
const QUOTA_FILE = path.join(CONFIG_DIR, 'quota.json');

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

const DEFAULT_CONFIG = {
  model: 'glm-5',
  baseUrl: 'api.z.ai',
  apiPrefix: '/api/paas/v4',
  stream: true,
  think: false,
  tools: false,
  webSearch: false,
  maxTokens: 4096,
  temperature: 0.7,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (_) { /* 무시 */ }
  // 초기 설정 파일 생성
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ===== 환경 변수 + 저장된 설정 병합 =====
const savedCfg = loadConfig();

const CFG = {
  apiKey:     process.env.ZAI_API_KEY       || savedCfg.apiKey     || '',
  baseUrl:    process.env.LZAI_BASE_URL    || savedCfg.baseUrl    || DEFAULT_CONFIG.baseUrl,
  apiPrefix:  process.env.LZAI_API_PREFIX  || savedCfg.apiPrefix  || DEFAULT_CONFIG.apiPrefix,
  model:      process.env.LZAI_MODEL       || savedCfg.model      || DEFAULT_CONFIG.model,
  debug:      process.env.LZAI_DEBUG === '1',
  workspace:  process.env.LZAI_WORKSPACE   || process.cwd(),
  tools:      process.env.LZAI_TOOLS  !== undefined ? process.env.LZAI_TOOLS  === '1' : (savedCfg.tools  ?? DEFAULT_CONFIG.tools),
  stream:     process.env.LZAI_STREAM !== undefined ? process.env.LZAI_STREAM !== '0' : (savedCfg.stream ?? DEFAULT_CONFIG.stream),
  think:      process.env.LZAI_THINK  !== undefined ? process.env.LZAI_THINK  === '1' : (savedCfg.think  ?? DEFAULT_CONFIG.think),
  webSearch:  process.env.LZAI_WEB_SEARCH !== undefined ? process.env.LZAI_WEB_SEARCH === '1' : (savedCfg.webSearch ?? DEFAULT_CONFIG.webSearch),
  maxTokens:  parseInt(process.env.LZAI_MAX_TOKENS   || savedCfg.maxTokens  || DEFAULT_CONFIG.maxTokens),
  temperature:parseFloat(process.env.LZAI_TEMPERATURE || savedCfg.temperature || DEFAULT_CONFIG.temperature),
  jsonMode:   false,
};

// ===== 전역 상태 =====
let bashMode = false;
const conversationHistory = [];
let lastUsage = null;
let _rl = null; // REPL readline 인스턴스 (승인 프롬프트용)
let mcpServers = {}; // { name: { url, tools: [...], sessionId } }
let activePreset = null; // { name, content }
let hudEnabled = true; // 사용량 HUD 표시 여부
const sessionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };

// ===== 유틸리티 =====
function debugLog(...args) { if (CFG.debug) console.log(`${c.dim}[DEBUG]${c.reset}`, ...args); }
function truncate(s, max) { return s.length > max ? s.slice(0, max) + '\n... [잘림]' : s; }
function formatBytes(b) {
  if (b < 1024) return b + 'B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + 'KB';
  return (b/1024/1024).toFixed(1) + 'MB';
}

// ===== TUI 유틸리티 =====

// ANSI 코드 제거 (문자열 길이 계산용)
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// 애니메이션 스피너
function createSpinner(text) {
  if (!IS_TTY) return {
    start() { process.stdout.write(text + '... '); return this; },
    stop() { },
    succeed(msg) { if (msg) console.log(msg); },
    fail(msg) { if (msg) console.log(msg); },
  };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0, timer = null;
  const t0 = Date.now();
  return {
    start() {
      timer = setInterval(() => {
        const sec = Math.floor((Date.now() - t0) / 1000);
        const el = sec > 0 ? ` ${c.dim}(${sec}초)${c.reset}` : '';
        process.stdout.write(`\r\x1b[K  ${c.cyan}${frames[i]}${c.reset} ${text}${el}`);
        i = (i + 1) % frames.length;
      }, 80);
      return this;
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } process.stdout.write('\r\x1b[K'); },
    succeed(msg) { this.stop(); if (msg) console.log(`  ${c.green}✓${c.reset} ${msg}`); },
    fail(msg) { this.stop(); if (msg) console.log(`  ${c.red}✗${c.reset} ${msg}`); },
  };
}

// 박스 그리기 (라운드 코너)
function drawBox(content, options) {
  options = options || {};
  const title = options.title;
  const color = options.color || c.dim;
  const pad = options.pad != null ? options.pad : 1;
  const lines = typeof content === 'string' ? content.split('\n') : content;
  const maxLen = Math.max(0, ...lines.map(function(l) { return stripAnsi(l).length; }), title ? stripAnsi(title).length + 4 : 0);
  const w = maxLen + pad * 2;

  let top;
  if (title) {
    const tLen = stripAnsi(title).length;
    top = color + '╭─' + c.reset + ' ' + title + ' ' + color + '─'.repeat(Math.max(0, w - tLen - 3)) + '╮' + c.reset;
  } else {
    top = color + '╭' + '─'.repeat(w) + '╮' + c.reset;
  }
  const bottom = color + '╰' + '─'.repeat(w) + '╯' + c.reset;

  const body = lines.map(function(line) {
    const vis = stripAnsi(line).length;
    return color + '│' + c.reset + ' '.repeat(pad) + line + ' '.repeat(Math.max(0, maxLen - vis + pad)) + color + '│' + c.reset;
  });
  return [top].concat(body, [bottom]).join('\n');
}

// 상태 표시 (ON/OFF)
function onoff(val) {
  return val ? c.green + '● ON' + c.reset : c.dim + '○ OFF' + c.reset;
}

// ===== 스크롤 시스템 (Shift+Up/Down) =====
const scrollState = {
  lines: [],       // 캡처된 출력 라인들
  active: false,   // 스크롤 모드 활성
  offset: 0,       // 현재 스크롤 위치 (하단 기준 오프셋)
  maxLines: 5000,  // 최대 보관 라인 수
};

let _origStdoutWrite = null;

// stdout 출력 캡처 시작
function initOutputCapture() {
  if (!IS_TTY || _origStdoutWrite) return;
  _origStdoutWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = function(chunk, encoding, callback) {
    // 스크롤 모드 중에는 캡처하지 않음 (렌더링 출력)
    if (!scrollState.active) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf-8');
      // \r로 시작하면 현재 줄 덮어쓰기 (스피너 등) - 마지막 줄 교체
      if (str.startsWith('\r') || str.startsWith('\x1b[K')) {
        // 스피너 업데이트는 무시 (불필요한 중간 프레임)
      } else {
        // 줄바꿈으로 분할하여 저장
        const parts = str.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i === 0 && scrollState.lines.length > 0) {
            // 첫 부분은 이전 줄에 이어붙이기
            scrollState.lines[scrollState.lines.length - 1] += parts[i];
          } else {
            scrollState.lines.push(parts[i]);
          }
        }
        // 최대 라인 수 제한
        if (scrollState.lines.length > scrollState.maxLines) {
          scrollState.lines = scrollState.lines.slice(-scrollState.maxLines);
        }
      }
    }
    return _origStdoutWrite(chunk, encoding, callback);
  };
}

// 스크롤 뷰 렌더링 (대체 화면 버퍼)
function renderScrollView() {
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const totalLines = scrollState.lines.length;
  const viewHeight = rows - 1; // 상태바 1줄 제외

  // 표시할 영역 계산
  const endIdx = Math.max(0, totalLines - scrollState.offset);
  const startIdx = Math.max(0, endIdx - viewHeight);

  // 화면 클리어 + 커서 홈
  let out = '\x1b[2J\x1b[H';

  // 출력 라인 표시
  const visibleLines = scrollState.lines.slice(startIdx, endIdx);
  for (let i = 0; i < viewHeight; i++) {
    if (i < visibleLines.length) {
      // 화면 폭 초과 시 잘라내기 (ANSI 고려)
      const line = visibleLines[i];
      out += line;
    }
    out += '\n';
  }

  // 상태바 (하단)
  const pct = totalLines > 0 ? Math.round(((endIdx) / totalLines) * 100) : 100;
  const pos = `${endIdx}/${totalLines} (${pct}%)`;
  const keys = '↑↓:1줄  PgUp/Dn:페이지  Home/End  ESC:닫기';
  const barText = ` 스크롤  ${pos}  │  ${keys} `;
  const padLen = Math.max(0, cols - stripAnsi(barText).length);
  out += `\x1b[7m${barText}${' '.repeat(padLen)}\x1b[0m`;

  _origStdoutWrite(out);
}

// 스크롤 모드 진입
function enterScrollMode() {
  if (!IS_TTY || scrollState.active) return;
  if (scrollState.lines.length === 0) return;

  scrollState.active = true;
  scrollState.offset = 0;

  // 대체 화면 버퍼 진입 + 커서 숨기기
  _origStdoutWrite('\x1b[?1049h\x1b[?25l');
  renderScrollView();
}

// 스크롤 모드 종료
function exitScrollMode() {
  if (!scrollState.active) return;
  scrollState.active = false;

  // 대체 화면 버퍼 종료 + 커서 표시
  _origStdoutWrite('\x1b[?1049l\x1b[?25h');

  // readline 프롬프트 다시 표시
  if (_rl) { _rl.prompt(true); }
}

// 스크롤 키 입력 처리
function handleScrollKey(key) {
  const rows = process.stdout.rows || 24;
  const viewHeight = rows - 1;
  const maxOffset = Math.max(0, scrollState.lines.length - viewHeight);

  switch (key) {
    case 'up':
      scrollState.offset = Math.min(maxOffset, scrollState.offset + 1);
      break;
    case 'down':
      scrollState.offset = Math.max(0, scrollState.offset - 1);
      break;
    case 'pageup':
      scrollState.offset = Math.min(maxOffset, scrollState.offset + viewHeight);
      break;
    case 'pagedown':
      scrollState.offset = Math.max(0, scrollState.offset - viewHeight);
      break;
    case 'home':
      scrollState.offset = maxOffset;
      break;
    case 'end':
      scrollState.offset = 0;
      break;
    case 'escape': case 'q':
      exitScrollMode();
      return;
  }
  renderScrollView();
}

// 키프레스 인터셉터 설치 (readline 전에 키 가로채기)
function installScrollKeyHandler() {
  if (!IS_TTY) return;

  // stdin의 keypress 이벤트를 직접 감시
  const origEmit = process.stdin.emit.bind(process.stdin);
  process.stdin.emit = function(event, key, meta) {
    // keypress 이벤트 인터셉트
    if (event === 'keypress') {
      const k = meta || key;
      if (k) {
        // 스크롤 모드 중 키 처리
        if (scrollState.active) {
          if (k.name === 'pageup') { handleScrollKey('pageup'); return false; }
          if (k.name === 'pagedown') { handleScrollKey('pagedown'); return false; }
          if (k.name === 'up' && k.ctrl) { handleScrollKey('pageup'); return false; }
          if (k.name === 'down' && k.ctrl) { handleScrollKey('pagedown'); return false; }
          if (k.name === 'up') { handleScrollKey('up'); return false; }
          if (k.name === 'down') { handleScrollKey('down'); return false; }
          if (k.name === 'home') { handleScrollKey('home'); return false; }
          if (k.name === 'end') { handleScrollKey('end'); return false; }
          if (k.name === 'escape' || (k.name === 'q' && !k.ctrl && !k.meta)) { handleScrollKey('escape'); return false; }
          // 스크롤 모드에서는 다른 키 입력 차단
          return false;
        }

        // Shift+Up: 스크롤 모드 진입
        if (k.name === 'up' && k.shift && !k.ctrl && !k.meta) {
          enterScrollMode();
          return false;
        }
        // Shift+Down 도 동일
        if (k.name === 'down' && k.shift && !k.ctrl && !k.meta) {
          enterScrollMode();
          return false;
        }
      }
    }
    return origEmit.apply(process.stdin, arguments);
  };
}

// 토큰 수 간결 표시 (1234 → 1.2K)
function fmtTokens(n) {
  if (!n && n !== 0) return '?';
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n / 1000) + 'K';
}

// ===== 쿼터 / 사용량 로그 시스템 =====
const QUOTA_WINDOWS = {
  '5h':   5 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  'weekly': 7 * 24 * 60 * 60 * 1000,
};

// 쿼터 기본값 (0 = 제한 없음)
const DEFAULT_QUOTA = { '5h': 0, 'daily': 0, 'weekly': 0 };

function loadQuota() {
  try {
    if (fs.existsSync(QUOTA_FILE)) return { ...DEFAULT_QUOTA, ...JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8')) };
  } catch (_) {}
  return { ...DEFAULT_QUOTA };
}

function saveQuota(q) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(q, null, 2), 'utf-8');
}

let quotaLimits = loadQuota();

// 사용량 로그: [{ ts, pt, ct, tt, model }]
function loadUsageLog() {
  try {
    if (fs.existsSync(USAGE_LOG_FILE)) return JSON.parse(fs.readFileSync(USAGE_LOG_FILE, 'utf-8'));
  } catch (_) {}
  return [];
}

function appendUsageLog(entry) {
  const log = loadUsageLog();
  log.push(entry);
  // 30일 이상 된 기록 정리
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const trimmed = log.filter(function(e) { return e.ts > cutoff; });
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(USAGE_LOG_FILE, JSON.stringify(trimmed), 'utf-8');
}

// 특정 윈도우 내 사용량 합산
function getWindowUsage(windowMs) {
  const log = loadUsageLog();
  const since = Date.now() - windowMs;
  let pt = 0, ct = 0, tt = 0, reqs = 0;
  for (const e of log) {
    if (e.ts >= since) {
      pt += e.pt || 0;
      ct += e.ct || 0;
      tt += e.tt || 0;
      reqs++;
    }
  }
  return { promptTokens: pt, completionTokens: ct, totalTokens: tt, requests: reqs };
}

// 쿼터 초과 확인 (0 = 제한 없음)
function checkQuota() {
  const warnings = [];
  for (const [key, ms] of Object.entries(QUOTA_WINDOWS)) {
    const limit = quotaLimits[key];
    if (!limit) continue;
    const usage = getWindowUsage(ms);
    const pct = Math.round((usage.totalTokens / limit) * 100);
    if (pct >= 100) {
      warnings.push({ key, pct, usage: usage.totalTokens, limit, level: 'over' });
    } else if (pct >= 80) {
      warnings.push({ key, pct, usage: usage.totalTokens, limit, level: 'warn' });
    }
  }
  return warnings;
}

// 쿼터 진행률 바 (10칸)
function quotaBar(used, limit) {
  if (!limit) return '';
  const pct = Math.min(1, used / limit);
  const filled = Math.round(pct * 10);
  const empty = 10 - filled;
  let color;
  if (pct >= 1) color = c.red;
  else if (pct >= 0.8) color = c.yellow;
  else color = c.green;
  return color + '█'.repeat(filled) + c.dim + '░'.repeat(empty) + c.reset + ' ' + Math.round(pct * 100) + '%';
}

// 윈도우 이름 한국어
function windowLabel(key) {
  if (key === '5h') return '5시간';
  if (key === 'daily') return '일간';
  if (key === 'weekly') return '주간';
  return key;
}

// 사용량 누적
function trackUsage(usage) {
  if (!usage) return;
  lastUsage = usage;
  sessionUsage.requests++;
  sessionUsage.promptTokens += usage.prompt_tokens || 0;
  sessionUsage.completionTokens += usage.completion_tokens || 0;
  sessionUsage.totalTokens += usage.total_tokens || 0;
  // 디스크 로그 기록
  appendUsageLog({
    ts: Date.now(),
    pt: usage.prompt_tokens || 0,
    ct: usage.completion_tokens || 0,
    tt: usage.total_tokens || 0,
    model: CFG.model,
  });
}

// 사용량 HUD 렌더링
function renderHud(elapsed) {
  if (!hudEnabled || !IS_TTY || !lastUsage) return;
  const u = lastUsage;
  const pt = fmtTokens(u.prompt_tokens);
  const ct = fmtTokens(u.completion_tokens);
  const tt = fmtTokens(u.total_tokens);
  const st = fmtTokens(sessionUsage.totalTokens);
  const elStr = elapsed ? (elapsed / 1000).toFixed(1) + '초' : '';

  const parts = [
    `${c.dim}입력${c.reset} ${pt}`,
    `${c.dim}출력${c.reset} ${ct}`,
    `${c.dim}=${c.reset} ${c.bold}${tt}${c.reset}`,
  ];
  const extra = [];
  if (elStr) extra.push(`${c.dim}${elStr}${c.reset}`);

  // 쿼터/구간 사용량 (항상 표시)
  const hasAnyLimit = Object.values(quotaLimits).some(function(v) { return v > 0; });
  if (hasAnyLimit) {
    // 한도 설정된 구간들: 진행률 바
    for (const [key, ms] of Object.entries(QUOTA_WINDOWS)) {
      const limit = quotaLimits[key];
      if (!limit) continue;
      const wu = getWindowUsage(ms);
      extra.push(`${c.dim}${windowLabel(key)}${c.reset} ${quotaBar(wu.totalTokens, limit)}`);
    }
  } else {
    // 한도 없으면 구간 사용량만 간결히 표시
    const w5h = getWindowUsage(QUOTA_WINDOWS['5h']);
    const wDay = getWindowUsage(QUOTA_WINDOWS['daily']);
    const wWeek = getWindowUsage(QUOTA_WINDOWS['weekly']);
    extra.push(`${c.dim}5h${c.reset} ${fmtTokens(w5h.totalTokens)}`);
    extra.push(`${c.dim}일${c.reset} ${fmtTokens(wDay.totalTokens)}`);
    extra.push(`${c.dim}주${c.reset} ${fmtTokens(wWeek.totalTokens)}`);
  }

  const line = `  ${c.dim}──${c.reset} ${parts.join(` ${c.dim}+${c.reset} `)}${extra.length ? ` ${c.dim}│${c.reset} ` + extra.join(` ${c.dim}│${c.reset} `) : ''} ${c.dim}──${c.reset}`;
  console.log(line);

  // 쿼터 경고
  const warnings = checkQuota();
  for (const w of warnings) {
    if (w.level === 'over') {
      console.log(`  ${c.bgRed}${c.bold} ⚠ ${windowLabel(w.key)} 쿼터 초과 ${c.reset} ${fmtTokens(w.usage)} / ${fmtTokens(w.limit)} (${w.pct}%)`);
    } else if (w.level === 'warn') {
      console.log(`  ${c.yellow}⚠ ${windowLabel(w.key)} 쿼터 ${w.pct}%${c.reset} ${c.dim}(${fmtTokens(w.usage)} / ${fmtTokens(w.limit)})${c.reset}`);
    }
  }
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
  if (CFG.tools) { tools.push(...FUNCTION_TOOLS); tools.push(...getMcpFunctionTools()); tools.push(...getScriptSkillTools()); }
  if (tools.length > 0) payload.tools = tools;
  if (options.tools) payload.tools = options.tools;
  if (options.stop) payload.stop = options.stop;

  const res = await apiPost(CFG.apiPrefix + '/chat/completions', payload);
  if (res.usage) trackUsage(res.usage);
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
  if (CFG.tools) { tools.push(...FUNCTION_TOOLS); tools.push(...getMcpFunctionTools()); tools.push(...getScriptSkillTools()); }
  if (tools.length > 0) payload.tools = tools;
  if (options.tools) payload.tools = options.tools;

  return apiPostStream(CFG.apiPrefix + '/chat/completions', payload, callbacks);
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
  const spin = createSpinner('처리중...').start();
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await zaiAsyncResult(taskId);
      if (result.task_status === 'SUCCESS') { spin.stop(); return result; }
      if (result.task_status === 'FAIL') throw new Error('비동기 작업 실패');
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error('폴링 타임아웃 (5분)');
  } catch (e) { spin.stop(); throw e; }
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

// ===== 시스템 프롬프트 빌더 =====
function buildSystemPrompt() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
  const timeStr = now.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', hour12: false });

  let prompt = `당신은 전문적인 범용 AI 어시스턴트입니다. 코딩, 글쓰기, 분석, 질의응답, 창작 등 모든 분야의 요청을 처리할 수 있습니다.

현재 날짜와 시간: ${dateStr} ${timeStr}
작업 디렉토리: ${CFG.workspace}
`;

  // 프리셋 적용
  if (activePreset) {
    prompt += `\n${activePreset.content}\n`;
  }

  if (CFG.tools) {
    prompt += `
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

파일을 읽을 때는 반드시 read_file 도구를 사용하세요. bash 명령어를 텍스트로 출력하지 마세요.
최신 정보가 필요하면 web_search를 적극 활용하세요.

중요 — 도구 사용 확인 규칙:
- execute_command, write_file 을 바로 쓰지 말고, 먼저 사용자에게 실행할 명령/파일을 설명하고 확인을 받으세요.
- 확인 없이 즉시 사용해도 되는 도구: read_file, web_search, web_read
- 사용자가 명시적으로 "실행해", "해줘", "ㄱㄱ" 등으로 지시하면 바로 실행하세요.
- 복잡하거나 위험한 작업은 run_with_approval을 사용하세요 (사용자에게 y/n 확인 프롬프트가 표시됩니다).
`;

    // MCP 도구 설명 추가
    const mcpTools = getMcpFunctionTools();
    if (mcpTools.length > 0) {
      prompt += `\nMCP 서버 도구:\n`;
      for (const t of mcpTools) {
        prompt += `- ${t.function.name}: ${t.function.description || '(설명 없음)'}\n`;
      }
    }

    // JS 스킬 도구 설명 추가
    const jsSkillTools = getScriptSkillTools();
    if (jsSkillTools.length > 0) {
      prompt += `\nJS 스킬 도구:\n`;
      for (const t of jsSkillTools) {
        prompt += `- ${t.function.name}: ${t.function.description || '(설명 없음)'}\n`;
      }
    }
  }

  if (CFG.webSearch) {
    prompt += `내장 웹 검색이 활성화되어 있습니다. (/websearch 로 토글)\n`;
  }

  prompt += '한국어로 답변하세요.';
  return prompt;
}

// ===== 프리셋 관리 =====
function listPresets() {
  ensureDir(PRESETS_DIR);
  return fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.txt') || f.endsWith('.md')).map(f => f.replace(/\.(txt|md)$/, ''));
}

function loadPresetFile(name) {
  const txtPath = path.join(PRESETS_DIR, `${name}.txt`);
  const mdPath = path.join(PRESETS_DIR, `${name}.md`);
  if (fs.existsSync(txtPath)) return fs.readFileSync(txtPath, 'utf-8');
  if (fs.existsSync(mdPath)) return fs.readFileSync(mdPath, 'utf-8');
  return null;
}

function savePresetFile(name, content) {
  ensureDir(PRESETS_DIR);
  fs.writeFileSync(path.join(PRESETS_DIR, `${name}.txt`), content, 'utf-8');
}

function applyPreset(name) {
  const content = loadPresetFile(name);
  if (!content) return false;
  activePreset = { name, content };
  // 시스템 프롬프트 재구성
  if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
    conversationHistory[0].content = buildSystemPrompt();
  }
  return true;
}

function clearPreset() {
  activePreset = null;
  if (conversationHistory.length > 0 && conversationHistory[0].role === 'system') {
    conversationHistory[0].content = buildSystemPrompt();
  }
}

// ===== 스킬 시스템 =====
// 스킬 = 슬래시 명령으로 호출하는 프롬프트 템플릿
// ~/.config/light-zai/skills/<name>.md 파일
// 내부에서 {{input}}, {{workspace}}, {{model}}, {{date}} 치환
function listSkills() {
  ensureDir(SKILLS_DIR);
  return fs.readdirSync(SKILLS_DIR).filter(f => /\.(md|txt|js|py)$/.test(f) && !f.includes('.example.')).map(f => f.replace(/\.(md|txt|js|py)$/, ''));
}

function loadSkill(name) {
  const mdPath = path.join(SKILLS_DIR, `${name}.md`);
  const txtPath = path.join(SKILLS_DIR, `${name}.txt`);
  if (fs.existsSync(mdPath)) return fs.readFileSync(mdPath, 'utf-8');
  if (fs.existsSync(txtPath)) return fs.readFileSync(txtPath, 'utf-8');
  return null;
}

// JS 스킬 로드
function loadJsSkill(name) {
  const jsPath = path.join(SKILLS_DIR, `${name}.js`);
  if (!fs.existsSync(jsPath)) return null;
  try {
    delete require.cache[require.resolve(jsPath)]; // 핫리로드
    return require(jsPath);
  } catch (e) {
    console.error(`${c.red}JS 스킬 로드 오류 (${name}): ${e.message}${c.reset}`);
    return null;
  }
}

// JS 스킬용 HTTP 헬퍼 (내장 모듈만 사용)
function skillHttp(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = mod.request(u, {
      method: method.toUpperCase(),
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data }); }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('타임아웃')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function saveSkill(name, content) {
  ensureDir(SKILLS_DIR);
  fs.writeFileSync(path.join(SKILLS_DIR, `${name}.md`), content, 'utf-8');
}

function expandSkillTemplate(template, input) {
  const now = new Date();
  return template
    .replace(/\{\{input\}\}/g, input || '')
    .replace(/\{\{workspace\}\}/g, CFG.workspace)
    .replace(/\{\{model\}\}/g, CFG.model)
    .replace(/\{\{date\}\}/g, now.toLocaleDateString('ko-KR'))
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', hour12: false }))
    .replace(/\{\{cwd\}\}/g, process.cwd());
}

// 스킬 실행 — 프롬프트를 주입하고 AI에게 전송
async function executeSkill(name, input) {
  // JS 스킬 우선 확인
  const jsMod = loadJsSkill(name);
  if (jsMod) return await executeJsSkill(name, jsMod, input);

  // Python 스킬 확인
  const pyMeta = loadPySkillMeta(name);
  if (pyMeta) return await executePySkill(name, pyMeta, input);

  const template = loadSkill(name);
  if (!template) return false;

  const prompt = expandSkillTemplate(template, input);
  console.log(`${c.magenta}[스킬]${c.reset} ${c.bold}${name}${c.reset}${input ? ` — ${c.dim}${input.slice(0, 60)}${c.reset}` : ''}\n`);

  // 프롬프트를 사용자 메시지로 전송
  try {
    const response = await sendMessage(prompt);
    if (response && !CFG.stream) {
      console.log(`${c.green}AI ▸${c.reset} ${response}\n`);
    } else if (response) {
      console.log('');
    }
  } catch (e) {
    console.error(`${c.red}스킬 실행 오류: ${e.message}${c.reset}\n`);
  }
  return true;
}

// JS 스킬 실행
async function executeJsSkill(name, mod, input) {
  console.log(`${c.magenta}[JS 스킬]${c.reset} ${c.bold}${name}${c.reset}${input ? ` — ${c.dim}${input.slice(0, 60)}${c.reset}` : ''}`);
  const ctx = { workspace: CFG.workspace, model: CFG.model, http: skillHttp, cwd: process.cwd() };
  const fn = typeof mod === 'function' ? mod : mod.execute;
  if (typeof fn !== 'function') {
    console.error(`${c.red}JS 스킬에 execute 함수가 없습니다${c.reset}\n`);
    return true;
  }
  try {
    const result = await fn(input, ctx);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (mod.prompt === false) {
      // prompt: false 면 결과만 출력, AI에게 보내지 않음
      console.log(text + '\n');
    } else {
      // AI에게 결과를 컨텍스트로 전송
      const aiPrompt = mod.prompt
        ? expandSkillTemplate(mod.prompt, input).replace(/\{\{result\}\}/g, text)
        : `[${name} 스킬 결과]\n${text}\n\n위 결과를 바탕으로 답변해주세요.`;
      const response = await sendMessage(aiPrompt);
      if (response && !CFG.stream) console.log(`${c.green}AI ▸${c.reset} ${response}\n`);
      else if (response) console.log('');
    }
  } catch (e) {
    console.error(`${c.red}JS 스킬 오류: ${e.message}${c.reset}\n`);
  }
  return true;
}

// Python 스킬 메타데이터 파싱 (파일 상단 # key: value 주석)
function loadPySkillMeta(name) {
  const pyPath = path.join(SKILLS_DIR, `${name}.py`);
  if (!fs.existsSync(pyPath)) return null;
  const src = fs.readFileSync(pyPath, 'utf-8');
  const meta = { path: pyPath };
  for (const line of src.split('\n')) {
    const m = line.match(/^#\s*(description|parameters|prompt):\s*(.+)/);
    if (m) {
      const [, key, val] = m;
      if (key === 'parameters') { try { meta.parameters = JSON.parse(val); } catch {} }
      else if (key === 'prompt' && val.trim() === 'false') meta.prompt = false;
      else meta[key] = val.trim();
    }
    if (!line.startsWith('#') && line.trim() !== '') break; // 주석 블록 끝
  }
  return meta;
}

// Python 스킬 실행 (spawn, stdin→JSON, stdout→결과)
function runPySkill(pyPath, input) {
  return new Promise((resolve, reject) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(py, [pyPath], {
      cwd: CFG.workspace,
      env: { ...process.env, WORKSPACE: CFG.workspace },
      timeout: 30000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('error', (e) => reject(new Error(`python 실행 실패: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `종료 코드: ${code}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve(stdout.trim()); }
      }
    });
    const payload = JSON.stringify(typeof input === 'string' ? { input } : input);
    child.stdin.write(payload);
    child.stdin.end();
  });
}

// Python 스킬 실행 + AI 전달
async function executePySkill(name, meta, input) {
  console.log(`${c.magenta}[PY 스킬]${c.reset} ${c.bold}${name}${c.reset}${input ? ` — ${c.dim}${(typeof input === 'string' ? input : JSON.stringify(input)).slice(0, 60)}${c.reset}` : ''}`);
  try {
    const result = await runPySkill(meta.path, input);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (meta.prompt === false) {
      console.log(text + '\n');
    } else {
      const aiPrompt = meta.prompt
        ? expandSkillTemplate(meta.prompt, typeof input === 'string' ? input : '').replace(/\{\{result\}\}/g, text)
        : `[${name} 스킬 결과]\n${text}\n\n위 결과를 바탕으로 답변해주세요.`;
      const response = await sendMessage(aiPrompt);
      if (response && !CFG.stream) console.log(`${c.green}AI ▸${c.reset} ${response}\n`);
      else if (response) console.log('');
    }
  } catch (e) {
    console.error(`${c.red}PY 스킬 오류: ${e.message}${c.reset}\n`);
  }
  return true;
}

// JS + Python 스킬을 AI function calling 도구로 변환
function getScriptSkillTools() {
  const tools = [];
  ensureDir(SKILLS_DIR);
  const files = fs.readdirSync(SKILLS_DIR).filter(f => (f.endsWith('.js') || f.endsWith('.py')) && !f.includes('.example.'));
  for (const f of files) {
    const ext = path.extname(f);
    const name = f.replace(/\.(js|py)$/, '');
    if (ext === '.js') {
      const mod = loadJsSkill(name);
      if (!mod || !mod.parameters) continue;
      tools.push({ type: 'function', function: {
        name: `skill__${name}`,
        description: mod.description || `${name} JS 스킬`,
        parameters: { type: 'object', properties: mod.parameters, required: Object.keys(mod.parameters) },
      }});
    } else {
      const meta = loadPySkillMeta(name);
      if (!meta || !meta.parameters) continue;
      tools.push({ type: 'function', function: {
        name: `skill__${name}`,
        description: meta.description || `${name} Python 스킬`,
        parameters: { type: 'object', properties: meta.parameters, required: Object.keys(meta.parameters) },
      }});
    }
  }
  return tools;
}

// ===== MCP 클라이언트 (HTTP + stdio) =====
function loadMcpConfig() {
  try {
    if (fs.existsSync(MCP_CONFIG_FILE)) return JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf-8'));
  } catch (_) {}
  return { servers: {} };
}

function saveMcpConfig(config) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 서버 설정에서 트랜스포트 타입 판별
function mcpTransportType(serverCfg) {
  if (serverCfg.command) return 'stdio';
  if (serverCfg.url) return 'http';
  return 'unknown';
}

// --- HTTP 트랜스포트 ---
function mcpHttpRequest(serverUrl, method, params = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: 30000,
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const contentType = res.headers['content-type'] || '';
          if (contentType.includes('text/event-stream')) {
            const lines = data.split('\n');
            for (const line of lines) {
              if (line.startsWith('data:')) {
                const payload = line.slice(5).trim();
                if (payload && payload !== '[DONE]') {
                  const parsed = JSON.parse(payload);
                  if (parsed.result !== undefined || parsed.error) { resolve(parsed); return; }
                }
              }
            }
            reject(new Error('SSE 응답에서 결과를 찾을 수 없음'));
          } else {
            resolve(JSON.parse(data));
          }
        } catch (e) {
          reject(new Error(`MCP 응답 파싱 실패: ${e.message}`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`MCP 연결 실패: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('MCP 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// --- stdio 트랜스포트 ---
function mcpSpawnProcess(command, args = [], env = {}) {
  const mergedEnv = { ...process.env, ...env };
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mergedEnv,
  });
  let buffer = '';
  const pending = new Map(); // id → { resolve, reject }
  let _nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    // JSON-RPC 메시지를 줄 단위로 파싱
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
        // 알림(notification)은 id가 없으므로 무시
      } catch (_) {
        debugLog('MCP stdio 파싱 실패:', line.slice(0, 100));
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    debugLog('MCP stderr:', chunk.toString().trim());
  });

  child.on('error', (err) => {
    // 모든 대기중 요청 reject
    for (const [id, { reject }] of pending) {
      reject(new Error(`MCP 프로세스 오류: ${err.message}`));
      pending.delete(id);
    }
  });

  child.on('close', (code) => {
    for (const [id, { reject }] of pending) {
      reject(new Error(`MCP 프로세스 종료 (code: ${code})`));
      pending.delete(id);
    }
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = _nextId++;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      pending.set(id, { resolve, reject });
      child.stdin.write(msg, (err) => {
        if (err) {
          pending.delete(id);
          reject(new Error(`MCP stdin 쓰기 실패: ${err.message}`));
        }
      });
      // 30초 타임아웃
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('MCP stdio 타임아웃'));
        }
      }, 30000);
    });
  }

  function notify(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    child.stdin.write(msg);
  }

  function kill() {
    child.kill();
  }

  return { send, notify, kill, process: child };
}

// --- 통합 연결 ---
async function mcpConnect(name, serverCfg) {
  const transport = mcpTransportType(serverCfg);
  debugLog(`MCP 연결: ${name} (${transport})`);

  if (transport === 'http') {
    const url = serverCfg.url;
    const headers = {};

    const initRes = await mcpHttpRequest(url, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: APP_NAME, version: VERSION },
    }, headers);

    if (initRes.error) throw new Error(`MCP 초기화 실패: ${initRes.error.message}`);

    const sessionId = initRes._meta?.sessionId || null;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    await mcpHttpRequest(url, 'notifications/initialized', {}, headers).catch(() => {});

    const toolsRes = await mcpHttpRequest(url, 'tools/list', {}, headers);
    const tools = toolsRes.result?.tools || [];

    mcpServers[name] = { transport: 'http', url, tools, sessionId, headers };
    debugLog(`MCP ${name}: ${tools.length}개 도구 발견`);
    return tools;

  } else if (transport === 'stdio') {
    const stdio = mcpSpawnProcess(serverCfg.command, serverCfg.args || [], serverCfg.env || {});

    const initRes = await stdio.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: APP_NAME, version: VERSION },
    });

    if (initRes.error) {
      stdio.kill();
      throw new Error(`MCP 초기화 실패: ${initRes.error.message}`);
    }

    stdio.notify('notifications/initialized');

    const toolsRes = await stdio.send('tools/list');
    const tools = toolsRes.result?.tools || [];

    mcpServers[name] = { transport: 'stdio', stdio, tools, command: serverCfg.command };
    debugLog(`MCP ${name}: ${tools.length}개 도구 발견`);
    return tools;

  } else {
    throw new Error(`알 수 없는 MCP 트랜스포트: command 또는 url을 지정하세요`);
  }
}

async function mcpDisconnect(name) {
  const server = mcpServers[name];
  if (!server) return;
  if (server.transport === 'stdio' && server.stdio) {
    server.stdio.kill();
  }
  delete mcpServers[name];
  debugLog(`MCP 연결 해제: ${name}`);
}

async function mcpCallTool(serverName, toolName, args) {
  const server = mcpServers[serverName];
  if (!server) throw new Error(`MCP 서버 없음: ${serverName}`);

  if (server.transport === 'http') {
    const res = await mcpHttpRequest(server.url, 'tools/call', {
      name: toolName,
      arguments: args,
    }, server.headers || {});
    if (res.error) throw new Error(`MCP 도구 오류: ${res.error.message}`);
    return res.result;

  } else if (server.transport === 'stdio') {
    const res = await server.stdio.send('tools/call', {
      name: toolName,
      arguments: args,
    });
    if (res.error) throw new Error(`MCP 도구 오류: ${res.error.message}`);
    return res.result;
  }
}

// MCP 도구를 OpenAI function calling 형식으로 변환
function getMcpFunctionTools() {
  const tools = [];
  for (const [serverName, server] of Object.entries(mcpServers)) {
    for (const tool of server.tools) {
      tools.push({
        type: 'function',
        function: {
          name: `mcp__${serverName}__${tool.name}`,
          description: tool.description || '',
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return tools;
}

// 시작 시 설정된 MCP 서버에 자동 연결
async function mcpAutoConnect() {
  const config = loadMcpConfig();
  const servers = config.servers || {};
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const tools = await mcpConnect(name, cfg);
      console.log(`  ${c.green}✓${c.reset} MCP ${c.bold}${name}${c.reset}: ${tools.length}개 도구 연결됨`);
    } catch (e) {
      console.log(`  ${c.red}✗${c.reset} MCP ${name}: 연결 실패 - ${e.message}`);
    }
  }
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
      const imgSpin = createSpinner('이미지 생성중...').start();
      const res = await zaiGenerateImage(prompt, { size });
      imgSpin.stop();
      const url = res.data?.[0]?.url;
      if (url) {
        console.log(`  ${c.green}✓${c.reset} 완료: ${c.cyan}${url}${c.reset}`);
        return { success: true, type: 'image', url };
      }
      return { success: false, error: '이미지 URL 없음' };
    }
    case 'video': case 'vid': {
      const vidSpin = createSpinner('비디오 생성 요청중...').start();
      const res = await zaiGenerateVideo(arg);
      const taskId = res.id;
      if (!taskId) { vidSpin.fail('작업 ID 없음'); return { success: false, error: '작업 ID 없음' }; }
      vidSpin.succeed(`작업 ID: ${c.cyan}${taskId}${c.reset}`);
      const result = await zaiPollResult(taskId);
      const videos = result.video_result || [];
      if (videos.length) {
        for (const v of videos) console.log(`  ${c.green}✓${c.reset} 완료: ${c.cyan}${v.url}${c.reset}`);
        return { success: true, type: 'video', videos: videos.map(v => v.url) };
      }
      return { success: false, error: '비디오 결과 없음' };
    }
    case 'ocr': {
      const ocrSpin = createSpinner('OCR 처리중...').start();
      const res = await zaiLayoutParsing(arg);
      ocrSpin.stop();
      return { success: true, type: 'ocr', output: res.md_results || '', regions: res.layout_details?.length || 0 };
    }
    case 'embed': {
      const res = await zaiEmbed(arg);
      const emb = res.data?.[0]?.embedding;
      return { success: true, type: 'embed', dimensions: emb?.length, preview: emb?.slice(0, 5) };
    }
    case 'upload': {
      const uplSpin = createSpinner('업로드중...').start();
      const res = await zaiUploadFile(arg);
      uplSpin.succeed(`완료: ID ${c.cyan}${res.id}${c.reset}`);
      return { success: true, type: 'upload', id: res.id, filename: res.filename };
    }
    case 'transcribe': case 'asr': {
      const asrSpin = createSpinner('음성 인식중...').start();
      const res = await zaiTranscribeAudio(arg);
      asrSpin.stop();
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
  console.log(`\n  ${c.magenta}◆${c.reset} ${c.bold}${toolName}${c.reset} ${c.dim}${JSON.stringify(args).slice(0,80)}${c.reset}`);
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
      console.log(`\n  ${c.yellow}⚠${c.reset} ${c.bold}실행 요청${c.reset} ${args.description}`);
      console.log(`    ${c.cyan}${args.command}${c.reset}`);
      const answer = await promptUser(`    실행할까요? (${c.green}y${c.reset}/${c.red}n${c.reset}) `);
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
    default: {
      // 스크립트 스킬 도구 처리 (skill__스킬명)
      const skillMatch = toolName.match(/^skill__(.+)$/);
      if (skillMatch) {
        const skillName = skillMatch[1];
        // JS 스킬 시도
        const mod = loadJsSkill(skillName);
        if (mod && (typeof mod === 'function' || typeof mod.execute === 'function')) {
          const ctx = { workspace: CFG.workspace, model: CFG.model, http: skillHttp, cwd: process.cwd() };
          const fn = typeof mod === 'function' ? mod : mod.execute;
          try {
            const res = await fn(args, ctx);
            result = { success: true, output: typeof res === 'string' ? res : JSON.stringify(res) };
          } catch (e) { result = { success: false, error: e.message }; }
          break;
        }
        // Python 스킬 시도
        const pyMeta = loadPySkillMeta(skillName);
        if (pyMeta) {
          try {
            const res = await runPySkill(pyMeta.path, args);
            result = { success: true, output: typeof res === 'string' ? res : JSON.stringify(res) };
          } catch (e) { result = { success: false, error: e.message }; }
          break;
        }
        result = { success: false, error: `스킬 없음: ${skillName}` };
        break;
      }
      // MCP 도구 처리 (mcp__서버명__도구명)
      const mcpMatch = toolName.match(/^mcp__([^_]+)__(.+)$/);
      if (mcpMatch) {
        const [, serverName, mcpToolName] = mcpMatch;
        try {
          const mcpResult = await mcpCallTool(serverName, mcpToolName, args);
          const content = mcpResult.content || [];
          const text = content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
          result = { success: !mcpResult.isError, output: text || JSON.stringify(mcpResult) };
        } catch (e) {
          result = { success: false, error: e.message };
        }
      } else {
        result = { success: false, error: `알 수 없는 도구: ${toolName}` };
      }
    }
  }
  console.log(`    ${result.success !== false ? c.green + '✓ 완료' : c.red + '✗ 실패'}${c.reset}`);
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
  const spin = createSpinner('응답 대기중...').start();
  let res = await zaiChat(conversationHistory);
  spin.stop();

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
  if (reasoning) console.log(`\n  ${c.dim}${c.italic}◇ ${reasoning}${c.reset}\n`);
  conversationHistory.push({ role: 'assistant', content });
  renderHud(Date.now() - startTime);
  debugLog(`응답 시간: ${((Date.now()-startTime)/1000).toFixed(2)}초`);
  return content;
}

async function sendMessageStream(startTime) {
  let isFirstToken = true;
  let isReasoning = false;

  const result = await zaiChatStream(conversationHistory, {
    onReasoning(token) {
      if (!isReasoning) { process.stdout.write(`\n  ${c.dim}${c.italic}◇ `); isReasoning = true; }
      process.stdout.write(token);
    },
    onToken(token) {
      if (isReasoning) { process.stdout.write(`${c.reset}\n\n`); isReasoning = false; }
      if (isFirstToken) { process.stdout.write(`${c.green}AI ▸${c.reset} `); isFirstToken = false; }
      process.stdout.write(token);
    },
    onSearchResult(results) { printSearchResults(results); },
    onUsage(u) { trackUsage(u); },
  });

  if (isReasoning) process.stdout.write(c.reset);
  if (!isFirstToken) process.stdout.write('\n');

  // 도구 호출 루프 (sendMessageSync와 동일하게 반복)
  let current = result;
  while (current.toolCalls && CFG.tools) {
    const assistantMsg = { role: 'assistant', content: current.content || null, tool_calls: current.toolCalls };
    conversationHistory.push(assistantMsg);

    for (const tc of current.toolCalls) {
      let toolArgs;
      try { toolArgs = JSON.parse(tc.function.arguments); } catch(_) { toolArgs = {}; }
      const toolResult = await executeTool(tc.function.name, toolArgs);
      conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
    }

    // 도구 실행 후 재호출 (스트리밍)
    isFirstToken = true;
    isReasoning = false;
    current = await zaiChatStream(conversationHistory, {
      onReasoning(token) {
        if (!isReasoning) { process.stdout.write(`\n  ${c.dim}${c.italic}◇ `); isReasoning = true; }
        process.stdout.write(token);
      },
      onToken(token) {
        if (isReasoning) { process.stdout.write(`${c.reset}\n\n`); isReasoning = false; }
        if (isFirstToken) { process.stdout.write(`${c.green}AI ▸${c.reset} `); isFirstToken = false; }
        process.stdout.write(token);
      },
      onSearchResult(results) { printSearchResults(results); },
      onUsage(u) { trackUsage(u); },
    });
    if (isReasoning) process.stdout.write(c.reset);
    if (!isFirstToken) process.stdout.write('\n');
  }

  conversationHistory.push({ role: 'assistant', content: current.content || '' });
  renderHud(Date.now() - startTime);
  debugLog(`응답 시간: ${((Date.now()-startTime)/1000).toFixed(2)}초`);
  return current.content;
}

function printSearchResults(results) {
  if (!results?.length) return;
  console.log(`\n  ${c.blue}◇ 웹 검색 참조${c.reset}`);
  for (const r of results.slice(0, 5)) {
    console.log(`    ${c.dim}▸${c.reset} ${r.title || ''} ${c.blue}${r.link || ''}${c.reset}`);
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
        console.log(`\n  ${c.bold}사용 가능한 모델${c.reset}\n`);
        for (const [name, desc] of Object.entries(MODELS)) {
          const current = name === CFG.model;
          const marker = current ? ` ${c.green}● 현재${c.reset}` : '';
          console.log(`  ${current ? c.green : c.cyan}${name.padEnd(24)}${c.reset} ${c.dim}${desc}${c.reset}${marker}`);
        }
        console.log(`\n  ${c.dim}사용법: /model <이름>${c.reset}\n`);
      } else {
        CFG.model = arg;
        console.log(`  ${c.green}✓${c.reset} 모델 변경: ${c.cyan}${arg}${c.reset}\n`);
      }
      break;

    case 'stream':
      CFG.stream = !CFG.stream;
      console.log(`  스트리밍  ${onoff(CFG.stream)}\n`);
      break;

    case 'think':
      CFG.think = !CFG.think;
      console.log(`  사고 모드 ${onoff(CFG.think)}\n`);
      break;

    case 'tools':
      CFG.tools = !CFG.tools;
      console.log(`  도구 호출 ${onoff(CFG.tools)}\n`);
      break;

    case 'websearch': case 'ws':
      CFG.webSearch = !CFG.webSearch;
      console.log(`  웹 검색   ${onoff(CFG.webSearch)}\n`);
      break;

    case 'json':
      CFG.jsonMode = !CFG.jsonMode;
      console.log(`  JSON 모드 ${onoff(CFG.jsonMode)}\n`);
      break;

    case 'hud':
      hudEnabled = !hudEnabled;
      console.log(`  사용량 HUD ${onoff(hudEnabled)}\n`);
      if (hudEnabled && lastUsage) renderHud();
      break;

    case 'usage': {
      const su = sessionUsage;
      console.log(`\n  ${c.bold}사용량${c.reset}`);
      console.log(`  ${c.dim}${'─'.repeat(42)}${c.reset}`);
      console.log(`  ${c.cyan}◆ 현재 세션${c.reset}`);
      console.log(`    요청 ${c.bold}${su.requests}${c.reset}회  |  입력 ${fmtTokens(su.promptTokens)}  출력 ${fmtTokens(su.completionTokens)}  합계 ${c.bold}${fmtTokens(su.totalTokens)}${c.reset}`);
      if (lastUsage) {
        console.log(`    ${c.dim}마지막: 입력 ${fmtTokens(lastUsage.prompt_tokens)} + 출력 ${fmtTokens(lastUsage.completion_tokens)} = ${fmtTokens(lastUsage.total_tokens)}${c.reset}`);
      }
      console.log('');
      console.log(`  ${c.cyan}◆ 구간별 사용량${c.reset}`);
      for (const [key, ms] of Object.entries(QUOTA_WINDOWS)) {
        const wu = getWindowUsage(ms);
        const limit = quotaLimits[key];
        const bar = limit ? '  ' + quotaBar(wu.totalTokens, limit) : '';
        console.log(`    ${windowLabel(key).padEnd(6)} ${c.bold}${fmtTokens(wu.totalTokens).padStart(6)}${c.reset} 토큰  ${c.dim}(${wu.requests}회)${c.reset}${bar}`);
      }
      console.log('');
      break;
    }

    case 'quota': {
      await cmdQuota(arg);
      break;
    }

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

    case 'preset': case 'p':
      await cmdPreset(arg);
      break;

    case 'mcp':
      await cmdMcp(arg);
      break;

    case 'skill':
      await cmdSkill(arg);
      break;

    default: {
      // 스킬로 시도
      const executed = await executeSkill(cmd, arg);
      if (!executed) {
        console.log(`${c.red}알 수 없는 명령어: /${cmd}${c.reset}`);
        const skills = listSkills();
        if (skills.length) console.log(`  ${c.dim}등록된 스킬: ${skills.join(', ')}${c.reset}`);
        console.log(`  /help 로 명령어 목록 확인\n`);
      }
    }
  }
}

// ===== 명령어 구현 =====
async function cmdSearchDDG(query) {
  const spin = createSpinner('DuckDuckGo 검색중...').start();
  try {
    const res = await duckDuckGoSearch(query);
    spin.stop();
    if (!res.results.length) { console.log(`  ${c.yellow}검색 결과 없음${c.reset}\n`); return; }
    console.log(`  ${c.bold}검색: "${query}"${c.reset} ${c.dim}(${res.count}건)${c.reset}\n`);
    for (const r of res.results.slice(0, 10)) {
      console.log(`  ${c.cyan}▸${c.reset} ${c.bold}${r.title}${c.reset}`);
      if (r.snippet) console.log(`    ${c.dim}${r.snippet.slice(0, 150)}${c.reset}`);
      if (r.url) console.log(`    ${c.blue}${r.url}${c.reset}`);
      console.log('');
    }
  } catch (e) { spin.fail(`검색 실패: ${e.message}`); }
}

async function cmdSearchZai(query) {
  const spin = createSpinner('검색중 (search-prime)...').start();
  try {
    const res = await zaiWebSearch(query);
    spin.stop();
    const results = res.search_result || [];
    if (!results.length) { console.log(`  ${c.yellow}검색 결과 없음${c.reset}\n`); return; }
    console.log(`  ${c.bold}검색: "${query}"${c.reset} ${c.dim}(${results.length}건)${c.reset}\n`);
    for (const r of results.slice(0, 10)) {
      console.log(`  ${c.cyan}▸${c.reset} ${c.bold}${r.title}${c.reset}`);
      if (r.content) console.log(`    ${c.dim}${r.content.slice(0, 150)}${c.reset}`);
      if (r.link) console.log(`    ${c.blue}${r.link}${c.reset}`);
      console.log('');
    }
  } catch (e) { spin.fail(`검색 실패: ${e.message}`); }
}

async function cmdRead(url) {
  const spin = createSpinner('읽는중...').start();
  try {
    const res = await zaiWebRead(url);
    spin.stop();
    const r = res.reader_result || res;
    if (r.title) console.log(`  ${c.bold}${r.title}${c.reset}\n`);
    console.log(truncate(r.content || '내용 없음', 5000));
    console.log('');
    // 대화 히스토리에 추가
    conversationHistory.push({ role: 'user', content: `[URL 읽기 결과: ${url}]\n${truncate(r.content || '', 10000)}` });
  } catch (e) { spin.fail(`읽기 실패: ${e.message}`); }
}

async function cmdImage(input) {
  let prompt = input, size = null;
  const sizeMatch = input.match(/--size\s+(\S+)/);
  if (sizeMatch) { size = sizeMatch[1]; prompt = input.replace(/--size\s+\S+/, '').trim(); }

  const spin = createSpinner('이미지 생성중...').start();
  try {
    const res = await zaiGenerateImage(prompt, { size });
    const url = res.data?.[0]?.url;
    if (url) {
      spin.succeed('이미지 생성 완료');
      console.log(`    ${c.cyan}${url}${c.reset}`);
      console.log(`    ${c.dim}(30일 후 만료)${c.reset}\n`);
    } else {
      spin.fail('이미지 URL을 받지 못했습니다');
    }
  } catch (e) { spin.fail(`이미지 생성 실패: ${e.message}`); }
}

async function cmdVideo(input) {
  let prompt = input, opts = {};
  if (input.match(/--audio/)) { opts.withAudio = true; prompt = prompt.replace(/--audio/, '').trim(); }
  if (input.match(/--duration\s+(\d+)/)) { opts.duration = parseInt(RegExp.$1); prompt = prompt.replace(/--duration\s+\d+/, '').trim(); }
  if (input.match(/--fps\s+(\d+)/)) { opts.fps = parseInt(RegExp.$1); prompt = prompt.replace(/--fps\s+\d+/, '').trim(); }

  const spin = createSpinner('비디오 생성 요청중...').start();
  try {
    const res = await zaiGenerateVideo(prompt, opts);
    const taskId = res.id;
    if (!taskId) { spin.fail('작업 ID를 받지 못했습니다'); return; }
    spin.succeed(`작업 ID: ${c.cyan}${taskId}${c.reset}`);
    const result = await zaiPollResult(taskId);
    const videos = result.video_result || [];
    if (videos.length) {
      console.log(`  ${c.green}✓${c.reset} 비디오 생성 완료`);
      for (const v of videos) {
        console.log(`    ${c.cyan}${v.url}${c.reset}`);
        if (v.cover_image_url) console.log(`    커버: ${c.dim}${v.cover_image_url}${c.reset}`);
      }
    } else {
      console.log(`  ${c.yellow}비디오 결과 없음${c.reset}`);
    }
    console.log('');
  } catch (e) { spin.fail(`비디오 생성 실패: ${e.message}`); }
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
  const spin = createSpinner('OCR 처리중...').start();
  try {
    const res = await zaiLayoutParsing(fileUrl);
    spin.succeed('OCR 완료');
    if (res.md_results) {
      console.log(`\n${c.bold}OCR 결과:${c.reset}\n`);
      console.log(truncate(res.md_results, 5000));
    }
    if (res.layout_details?.length) {
      console.log(`\n  ${c.dim}레이아웃: ${res.layout_details.length}개 영역 감지${c.reset}`);
    }
    if (res.usage) console.log(`  ${c.dim}토큰: ${res.usage.total_tokens}${c.reset}`);
    console.log('');
  } catch (e) { spin.fail(`OCR 실패: ${e.message}`); }
}

async function cmdEmbed(text) {
  const spin = createSpinner('임베딩 생성중...').start();
  try {
    const res = await zaiEmbed(text);
    spin.succeed('임베딩 완료');
    const data = res.data;
    if (data?.length) {
      const emb = data[0].embedding;
      console.log(`    차원: ${emb.length}`);
      console.log(`    처음 10개: [${emb.slice(0, 10).map(v => v.toFixed(6)).join(', ')}...]`);
      if (res.usage) console.log(`    토큰: ${res.usage.total_tokens}`);
    }
    console.log('');
  } catch (e) { spin.fail(`임베딩 실패: ${e.message}`); }
}

async function cmdTokens() {
  if (conversationHistory.length <= 1) { console.log(`  ${c.yellow}대화 기록이 비어있습니다${c.reset}\n`); return; }
  const spin = createSpinner('토큰 계산중...').start();
  try {
    const res = await zaiTokenize(conversationHistory);
    spin.succeed('토큰 계산 완료');
    const u = res.usage || {};
    if (u.prompt_tokens) console.log(`    프롬프트: ${u.prompt_tokens}`);
    if (u.image_tokens) console.log(`    이미지: ${u.image_tokens}`);
    if (u.video_tokens) console.log(`    비디오: ${u.video_tokens}`);
    console.log(`    합계: ${c.bold}${u.total_tokens || '?'}${c.reset}`);
    console.log('');
  } catch (e) { spin.fail(`토큰 계산 실패: ${e.message}`); }
}

async function cmdUpload(filePath) {
  const fullPath = path.resolve(CFG.workspace, filePath);
  if (!fs.existsSync(fullPath)) { console.log(`  ${c.red}✗${c.reset} 파일 없음: ${fullPath}\n`); return; }
  const stat = fs.statSync(fullPath);
  const spin = createSpinner(`업로드중... (${formatBytes(stat.size)})`).start();
  try {
    const res = await zaiUploadFile(filePath);
    spin.succeed('업로드 완료');
    console.log(`    ID: ${c.cyan}${res.id}${c.reset}`);
    console.log(`    파일: ${res.filename} (${formatBytes(res.bytes)})`);
    console.log('');
  } catch (e) { spin.fail(`업로드 실패: ${e.message}`); }
}

async function cmdTranscribe(filePath) {
  const fullPath = path.resolve(CFG.workspace, filePath);
  if (!fs.existsSync(fullPath)) { console.log(`  ${c.red}✗${c.reset} 파일 없음: ${fullPath}\n`); return; }
  const stat = fs.statSync(fullPath);
  const spin = createSpinner(`음성 인식중... (${formatBytes(stat.size)})`).start();
  try {
    const res = await zaiTranscribeAudio(filePath);
    spin.succeed('음성 인식 완료');
    console.log('');
    if (res.text) console.log(res.text);
    else if (res.choices?.[0]?.message?.content) console.log(res.choices[0].message.content);
    else console.log(JSON.stringify(res, null, 2));
    console.log('');
  } catch (e) { spin.fail(`음성 인식 실패: ${e.message}`); }
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
      baseUrl: CFG.baseUrl, apiPrefix: CFG.apiPrefix };
    if (CFG.apiKey) cfg.apiKey = CFG.apiKey;
    saveConfig(cfg);
    console.log(`${c.green}설정 저장 완료${c.reset}: ${CONFIG_FILE}\n`);
    return;
  }

  if (!val) { console.log(`${c.yellow}값이 필요합니다${c.reset}: /config ${key} <값>\n`); return; }

  const boolKeys = ['stream', 'think', 'tools', 'webSearch', 'jsonMode', 'debug'];
  const numKeys = ['maxTokens', 'temperature'];
  const strKeys = ['model', 'baseUrl', 'apiPrefix', 'apiKey', 'workspace'];

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

// ===== 쿼터 명령어 =====
async function cmdQuota(arg) {
  const parts = arg ? arg.split(/\s+/) : [];
  const sub = parts[0] || '';

  switch (sub) {
    case '':
    case 'show': {
      console.log(`\n  ${c.bold}쿼터 설정${c.reset}`);
      console.log(`  ${c.dim}${'─'.repeat(42)}${c.reset}`);
      for (const [key, ms] of Object.entries(QUOTA_WINDOWS)) {
        const limit = quotaLimits[key];
        const wu = getWindowUsage(ms);
        if (limit) {
          console.log(`  ${windowLabel(key).padEnd(6)} ${quotaBar(wu.totalTokens, limit)}  ${c.dim}(${fmtTokens(wu.totalTokens)} / ${fmtTokens(limit)})${c.reset}`);
        } else {
          console.log(`  ${windowLabel(key).padEnd(6)} ${c.dim}제한 없음${c.reset}  ${c.dim}(현재 ${fmtTokens(wu.totalTokens)})${c.reset}`);
        }
      }
      console.log(`\n  ${c.dim}설정: /quota set <5h|daily|weekly> <토큰수>${c.reset}`);
      console.log(`  ${c.dim}해제: /quota off <5h|daily|weekly>${c.reset}`);
      console.log(`  ${c.dim}초기화: /quota reset${c.reset}\n`);
      break;
    }
    case 'set': {
      const key = parts[1];
      const val = parts[2];
      if (!key || !val || !QUOTA_WINDOWS[key]) {
        console.log(`  ${c.yellow}사용법: /quota set <5h|daily|weekly> <토큰수>${c.reset}`);
        console.log(`  ${c.dim}예: /quota set 5h 100000  (5시간 10만 토큰)${c.reset}`);
        console.log(`  ${c.dim}    /quota set weekly 1000000  (주간 100만 토큰)${c.reset}\n`);
        break;
      }
      let num = parseInt(val);
      // K/M 단위 지원
      if (val.toLowerCase().endsWith('k')) num = parseInt(val) * 1000;
      else if (val.toLowerCase().endsWith('m')) num = parseInt(val) * 1000000;
      if (isNaN(num) || num <= 0) {
        console.log(`  ${c.red}✗${c.reset} 유효한 숫자를 입력하세요\n`);
        break;
      }
      quotaLimits[key] = num;
      saveQuota(quotaLimits);
      console.log(`  ${c.green}✓${c.reset} ${windowLabel(key)} 쿼터: ${c.bold}${fmtTokens(num)}${c.reset} 토큰\n`);
      break;
    }
    case 'off': case 'clear': {
      const key = parts[1];
      if (!key || !QUOTA_WINDOWS[key]) {
        console.log(`  ${c.yellow}사용법: /quota off <5h|daily|weekly>${c.reset}\n`);
        break;
      }
      quotaLimits[key] = 0;
      saveQuota(quotaLimits);
      console.log(`  ${c.green}✓${c.reset} ${windowLabel(key)} 쿼터 해제\n`);
      break;
    }
    case 'reset': {
      // 사용량 로그 초기화
      ensureDir(CONFIG_DIR);
      fs.writeFileSync(USAGE_LOG_FILE, '[]', 'utf-8');
      console.log(`  ${c.green}✓${c.reset} 사용량 로그 초기화\n`);
      break;
    }
    default:
      console.log(`  사용법: /quota [show|set|off|reset]\n`);
  }
}

async function cmdDoctor() {
  console.log(`\n  ${c.bold}시스템 진단${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(40)}${c.reset}\n`);

  // 시스템 정보
  console.log(`  ${c.cyan}◆ 시스템${c.reset}`);
  console.log(`    OS:       ${os.platform()} ${os.arch()} ${os.release()}`);
  console.log(`    Node.js:  ${process.version}`);
  console.log(`    메모리:   ${formatBytes(os.freemem())} / ${formatBytes(os.totalmem())}`);
  console.log(`    CPU:      ${os.cpus()[0]?.model || '?'} x${os.cpus().length}`);
  console.log('');

  // 설정 상태
  console.log(`  ${c.cyan}◆ 설정${c.reset}`);
  console.log(`    API 키:   ${CFG.apiKey ? c.green + '설정됨 (***' + CFG.apiKey.slice(-4) + ')' + c.reset : c.red + '미설정' + c.reset}`);
  console.log(`    서버:     ${CFG.baseUrl}`);
  console.log(`    모델:     ${CFG.model}`);
  console.log(`    설정파일: ${fs.existsSync(CONFIG_FILE) ? c.green + '있음' + c.reset : c.dim + '없음' + c.reset}`);
  console.log('');

  // API 연결 테스트
  if (CFG.apiKey) {
    console.log(`  ${c.cyan}◆ API 연결 테스트${c.reset}`);
    let spin;

    spin = createSpinner('토크나이저 테스트...').start();
    try {
      const start = Date.now();
      const res = await zaiTokenize([{ role: 'user', content: '안녕' }]);
      spin.succeed(`토크나이저: OK (${Date.now() - start}ms, ${res.usage?.total_tokens || '?'}토큰)`);
    } catch (e) {
      spin.fail(`토크나이저: 실패 - ${e.message}`);
    }

    spin = createSpinner('웹 검색 테스트...').start();
    try {
      const start = Date.now();
      const res = await zaiWebSearch('test');
      const count = res.search_result?.length || 0;
      spin.succeed(`웹 검색: OK (${Date.now() - start}ms, ${count}건)`);
    } catch (e) {
      spin.fail(`웹 검색: 실패 - ${e.message}`);
    }

    spin = createSpinner(`채팅 테스트 (${CFG.model})...`).start();
    try {
      const start = Date.now();
      const res = await apiPost(CFG.apiPrefix + '/chat/completions', {
        model: CFG.model, messages: [{ role: 'user', content: '1+1=' }], max_tokens: 5,
      });
      const answer = res.choices?.[0]?.message?.content || '';
      spin.succeed(`채팅 (${CFG.model}): OK (${Date.now() - start}ms) "${answer.trim().slice(0,30)}"`);
    } catch (e) {
      spin.fail(`채팅 (${CFG.model}): 실패 - ${e.message}`);
    }
  }
  console.log('');
}

// ===== 프리셋 명령어 =====
async function cmdPreset(arg) {
  const parts = arg ? arg.split(/\s+/) : [];
  const sub = parts[0] || '';
  const name = parts.slice(1).join(' ').trim();

  switch (sub) {
    case '':
    case 'list': {
      const presets = listPresets();
      if (!presets.length) {
        console.log(`${c.dim}저장된 프리셋이 없습니다${c.reset}`);
        console.log(`  ${c.dim}프리셋 디렉토리: ${PRESETS_DIR}${c.reset}`);
        console.log(`  ${c.dim}.txt 또는 .md 파일을 넣거나 /preset save <이름> 으로 생성${c.reset}\n`);
        return;
      }
      console.log(`\n${c.bold}프리셋 목록:${c.reset}\n`);
      for (const p of presets) {
        const marker = activePreset?.name === p ? ` ${c.green}<- 활성${c.reset}` : '';
        const content = loadPresetFile(p);
        const preview = content ? content.split('\n')[0].slice(0, 60) : '';
        console.log(`  ${c.cyan}${p.padEnd(20)}${c.reset} ${c.dim}${preview}${c.reset}${marker}`);
      }
      console.log(`\n  사용법: /preset load <이름> | /preset save <이름> | /preset off\n`);
      break;
    }
    case 'load': case 'use': {
      if (!name) { console.log(`${c.yellow}이름이 필요합니다${c.reset}: /preset load <이름>\n`); return; }
      if (applyPreset(name)) {
        console.log(`${c.green}프리셋 적용: ${name}${c.reset}\n`);
      } else {
        console.log(`${c.red}프리셋 없음: ${name}${c.reset}\n`);
        const presets = listPresets();
        if (presets.length) console.log(`  사용 가능: ${presets.join(', ')}\n`);
      }
      break;
    }
    case 'save': {
      if (!name) { console.log(`${c.yellow}이름이 필요합니다${c.reset}: /preset save <이름>\n`); return; }
      // 현재 대화에서 AI에게 프리셋 내용을 요청하거나, 직접 입력
      console.log(`${c.cyan}프리셋 내용을 입력하세요 (빈 줄로 종료):${c.reset}`);
      const lines = [];
      const collectLine = () => new Promise(resolve => {
        if (_rl) _rl.question('  ', answer => resolve(answer));
        else resolve(null);
      });
      while (true) {
        const line = await collectLine();
        if (line === null || line === '') break;
        lines.push(line);
      }
      if (lines.length === 0) { console.log(`${c.dim}취소됨${c.reset}\n`); return; }
      savePresetFile(name, lines.join('\n'));
      console.log(`${c.green}프리셋 저장: ${name}${c.reset}`);
      console.log(`  ${c.dim}${path.join(PRESETS_DIR, name + '.txt')}${c.reset}\n`);
      break;
    }
    case 'off': case 'clear': case 'none': {
      if (activePreset) {
        console.log(`${c.green}프리셋 해제: ${activePreset.name}${c.reset}\n`);
        clearPreset();
      } else {
        console.log(`${c.dim}활성 프리셋 없음${c.reset}\n`);
      }
      break;
    }
    case 'show': {
      if (!activePreset) { console.log(`${c.dim}활성 프리셋 없음${c.reset}\n`); return; }
      console.log(`\n${c.bold}프리셋: ${activePreset.name}${c.reset}\n`);
      console.log(activePreset.content);
      console.log('');
      break;
    }
    case 'delete': case 'rm': {
      if (!name) { console.log(`${c.yellow}이름이 필요합니다${c.reset}: /preset delete <이름>\n`); return; }
      const txtPath = path.join(PRESETS_DIR, `${name}.txt`);
      const mdPath = path.join(PRESETS_DIR, `${name}.md`);
      if (fs.existsSync(txtPath)) { fs.unlinkSync(txtPath); }
      else if (fs.existsSync(mdPath)) { fs.unlinkSync(mdPath); }
      else { console.log(`${c.red}프리셋 없음: ${name}${c.reset}\n`); return; }
      if (activePreset?.name === name) clearPreset();
      console.log(`${c.green}프리셋 삭제: ${name}${c.reset}\n`);
      break;
    }
    default:
      // 인자가 프리셋 이름이면 바로 로드
      if (applyPreset(sub)) {
        console.log(`${c.green}프리셋 적용: ${sub}${c.reset}\n`);
      } else {
        console.log(`  사용법: /preset [list|load|save|show|off|delete] [이름]\n`);
      }
  }
}

// ===== MCP 명령어 =====
async function cmdMcp(arg) {
  const parts = arg ? arg.split(/\s+/) : [];
  const sub = parts[0] || '';
  const name = parts[1] || '';
  const rest = parts.slice(2).join(' ').trim();

  switch (sub) {
    case '':
    case 'list': {
      const config = loadMcpConfig();
      const configServers = Object.keys(config.servers || {});

      if (!configServers.length) {
        console.log(`${c.dim}등록된 MCP 서버가 없습니다${c.reset}`);
        console.log(`  ${c.dim}HTTP:  /mcp add <이름> <URL>${c.reset}`);
        console.log(`  ${c.dim}stdio: /mcp stdio <이름> <명령> [인자...]${c.reset}\n`);
        return;
      }

      console.log(`\n${c.bold}MCP 서버:${c.reset}\n`);
      for (const sname of configServers) {
        const cfg = config.servers[sname];
        const connected = mcpServers[sname];
        const toolCount = connected ? connected.tools.length : 0;
        const status = connected ? `${c.green}연결됨${c.reset} (${toolCount}개 도구)` : `${c.dim}연결 안됨${c.reset}`;
        const transport = mcpTransportType(cfg);
        const target = transport === 'stdio' ? `${cfg.command} ${(cfg.args || []).join(' ')}` : cfg.url;
        console.log(`  ${c.cyan}${sname.padEnd(15)}${c.reset} [${transport}] ${status}`);
        console.log(`  ${c.dim}${' '.repeat(15)} ${target}${c.reset}`);
        if (connected) {
          for (const t of connected.tools) {
            console.log(`  ${' '.repeat(15)} ${c.magenta}${t.name}${c.reset} ${c.dim}${(t.description || '').slice(0, 50)}${c.reset}`);
          }
        }
      }
      console.log(`\n  /mcp add <이름> <URL>              HTTP 서버 등록`);
      console.log(`  /mcp stdio <이름> <명령> [인자...] [--env K=V ...]  stdio 서버 등록`);
      console.log(`  /mcp remove|connect|disconnect|tools\n`);
      break;
    }
    case 'add': {
      if (!name || !rest) { console.log(`${c.yellow}사용법: /mcp add <이름> <URL>${c.reset}\n`); return; }
      const config = loadMcpConfig();
      config.servers = config.servers || {};
      config.servers[name] = { url: rest };
      saveMcpConfig(config);
      console.log(`${c.green}MCP 서버 등록 완료: ${name}${c.reset} → ${rest}`);
      console.log(`  ${c.dim}연결하려면: /mcp connect ${name}${c.reset}\n`);
      break;
    }
    case 'stdio': {
      // /mcp stdio <이름> <명령> [인자...] [--env KEY=VALUE ...]
      if (!name || !rest) { console.log(`${c.yellow}사용법: /mcp stdio <이름> <명령> [인자...] [--env KEY=VAL ...]${c.reset}\n`); return; }
      const stdioParts = rest.split(/\s+/);
      const cmdParts = []; const envObj = {};
      let parsingEnv = false;
      for (const p of stdioParts) {
        if (p === '--env') { parsingEnv = true; continue; }
        if (parsingEnv && p.includes('=')) {
          const eq = p.indexOf('=');
          envObj[p.slice(0, eq)] = p.slice(eq + 1);
        } else { parsingEnv = false; cmdParts.push(p); }
      }
      const command = cmdParts[0];
      const cmdArgs = cmdParts.slice(1);
      const serverCfg = { command, args: cmdArgs };
      if (Object.keys(envObj).length > 0) serverCfg.env = envObj;
      const config = loadMcpConfig();
      config.servers = config.servers || {};
      config.servers[name] = serverCfg;
      saveMcpConfig(config);
      console.log(`${c.green}MCP 서버 등록 완료: ${name}${c.reset} → ${command} ${cmdArgs.join(' ')}`);
      console.log(`  ${c.dim}연결하려면: /mcp connect ${name}${c.reset}\n`);
      break;
    }
    case 'remove': case 'rm': case 'delete': {
      if (!name) { console.log(`${c.yellow}사용법: /mcp remove <이름>${c.reset}\n`); return; }
      const config = loadMcpConfig();
      if (config.servers?.[name]) {
        delete config.servers[name];
        saveMcpConfig(config);
      }
      await mcpDisconnect(name);
      console.log(`${c.green}MCP 서버 제거: ${name}${c.reset}\n`);
      break;
    }
    case 'connect': {
      if (!name) { console.log(`${c.yellow}사용법: /mcp connect <이름>${c.reset}\n`); return; }
      const config = loadMcpConfig();
      const serverCfg = config.servers?.[name];
      if (!serverCfg) { console.log(`${c.red}등록되지 않은 서버: ${name}${c.reset}\n`); return; }
      const spin = createSpinner(`MCP 연결중... (${name})`).start();
      try {
        const tools = await mcpConnect(name, serverCfg);
        spin.succeed(`MCP 연결: ${name} (${tools.length}개 도구)`);
        for (const t of tools) {
          console.log(`    ${c.magenta}▸${c.reset} ${t.name} ${c.dim}${(t.description || '').slice(0, 60)}${c.reset}`);
        }
      } catch (e) {
        spin.fail(`MCP 연결 실패: ${e.message}`);
      }
      console.log('');
      break;
    }
    case 'disconnect': {
      if (!name) { console.log(`${c.yellow}사용법: /mcp disconnect <이름>${c.reset}\n`); return; }
      await mcpDisconnect(name);
      console.log(`${c.green}MCP 연결 해제: ${name}${c.reset}\n`);
      break;
    }
    case 'tools': {
      const mcpTools = getMcpFunctionTools();
      if (!mcpTools.length) { console.log(`${c.dim}연결된 MCP 도구 없음${c.reset}\n`); return; }
      console.log(`\n${c.bold}MCP 도구 목록:${c.reset}\n`);
      for (const t of mcpTools) {
        console.log(`  ${c.magenta}${t.function.name}${c.reset}`);
        if (t.function.description) console.log(`    ${c.dim}${t.function.description.slice(0, 80)}${c.reset}`);
      }
      console.log('');
      break;
    }
    default:
      console.log(`  사용법: /mcp [list|add|stdio|remove|connect|disconnect|tools]\n`);
  }
}

// ===== 스킬 명령어 =====
async function cmdSkill(arg) {
  const parts = arg ? arg.split(/\s+/) : [];
  const sub = parts[0] || '';
  const name = parts[1] || '';

  switch (sub) {
    case '':
    case 'list': {
      const skills = listSkills();
      if (!skills.length) {
        console.log(`${c.dim}등록된 스킬이 없습니다${c.reset}`);
        console.log(`  ${c.dim}/skill init 으로 기본 스킬 생성${c.reset}`);
        console.log(`  ${c.dim}/skill new <이름> 으로 직접 생성${c.reset}`);
        console.log(`  ${c.dim}또는 ${SKILLS_DIR}/ 에 .md 파일 추가${c.reset}\n`);
        return;
      }
      console.log(`\n${c.bold}스킬 목록:${c.reset}  ${c.dim}(사용: /<스킬이름> [인자])${c.reset}\n`);
      for (const s of skills) {
        const content = loadSkill(s) || '';
        // 첫 줄이 # 제목이면 사용, 아니면 첫 줄 미리보기
        const firstLine = content.split('\n').find(l => l.trim()) || '';
        const desc = firstLine.startsWith('#') ? firstLine.replace(/^#+\s*/, '') : firstLine.slice(0, 60);
        console.log(`  ${c.cyan}/${s.padEnd(18)}${c.reset} ${c.dim}${desc}${c.reset}`);
      }
      console.log(`\n  /skill show <이름>    내용 보기`);
      console.log(`  /skill new <이름>     새 스킬 생성`);
      console.log(`  /skill delete <이름>  삭제\n`);
      break;
    }
    case 'show': case 'cat': {
      if (!name) { console.log(`${c.yellow}사용법: /skill show <이름>${c.reset}\n`); return; }
      const content = loadSkill(name);
      if (!content) { console.log(`${c.red}스킬 없음: ${name}${c.reset}\n`); return; }
      console.log(`\n${c.bold}스킬: ${name}${c.reset}`);
      console.log(`${c.dim}파일: ${path.join(SKILLS_DIR, name + '.md')}${c.reset}\n`);
      console.log(content);
      console.log('');
      break;
    }
    case 'new': case 'create': case 'add': {
      if (!name) { console.log(`${c.yellow}사용법: /skill new <이름>${c.reset}\n`); return; }
      if (loadSkill(name)) { console.log(`${c.yellow}이미 존재: ${name}${c.reset} (/skill show ${name} 으로 확인)\n`); return; }
      console.log(`${c.cyan}스킬 내용을 입력하세요 (빈 줄로 종료):${c.reset}`);
      console.log(`${c.dim}  사용 가능한 변수: {{input}} {{workspace}} {{model}} {{date}} {{time}} {{cwd}}${c.reset}`);
      const lines = [];
      const collectLine = () => new Promise(resolve => {
        if (_rl) _rl.question('  ', answer => resolve(answer));
        else resolve(null);
      });
      while (true) {
        const line = await collectLine();
        if (line === null || line === '') break;
        lines.push(line);
      }
      if (!lines.length) { console.log(`${c.dim}취소됨${c.reset}\n`); return; }
      saveSkill(name, lines.join('\n'));
      console.log(`${c.green}스킬 생성: /${name}${c.reset}`);
      console.log(`  ${c.dim}${path.join(SKILLS_DIR, name + '.md')}${c.reset}\n`);
      break;
    }
    case 'edit': {
      if (!name) { console.log(`${c.yellow}사용법: /skill edit <이름>${c.reset}\n`); return; }
      const existing = loadSkill(name);
      if (!existing) { console.log(`${c.red}스킬 없음: ${name}${c.reset}\n`); return; }
      console.log(`${c.cyan}현재 내용:${c.reset}\n${c.dim}${existing}${c.reset}\n`);
      console.log(`${c.cyan}새 내용을 입력하세요 (빈 줄로 종료):${c.reset}`);
      const lines = [];
      const collectLine = () => new Promise(resolve => {
        if (_rl) _rl.question('  ', answer => resolve(answer));
        else resolve(null);
      });
      while (true) {
        const line = await collectLine();
        if (line === null || line === '') break;
        lines.push(line);
      }
      if (!lines.length) { console.log(`${c.dim}취소됨${c.reset}\n`); return; }
      saveSkill(name, lines.join('\n'));
      console.log(`${c.green}스킬 수정됨: /${name}${c.reset}\n`);
      break;
    }
    case 'delete': case 'rm': {
      if (!name) { console.log(`${c.yellow}사용법: /skill delete <이름>${c.reset}\n`); return; }
      const mdPath = path.join(SKILLS_DIR, `${name}.md`);
      const txtPath = path.join(SKILLS_DIR, `${name}.txt`);
      if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
      else if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath);
      else { console.log(`${c.red}스킬 없음: ${name}${c.reset}\n`); return; }
      console.log(`${c.green}스킬 삭제: ${name}${c.reset}\n`);
      break;
    }
    case 'init': {
      // 기본 스킬 세트 생성
      const defaults = {
        'review': `# 코드 리뷰
다음 코드 또는 파일을 리뷰해주세요. 버그, 보안 취약점, 성능 문제, 가독성을 검토하세요.

{{input}}`,
        'refactor': `# 리팩토링
다음 코드를 리팩토링해주세요. 가독성, 유지보수성, 성능을 개선하되 동작은 변경하지 마세요.

{{input}}`,
        'explain': `# 코드 설명
다음 코드를 단계별로 상세히 설명해주세요. 초보자도 이해할 수 있게 설명하세요.

{{input}}`,
        'test': `# 테스트 작성
다음 코드에 대한 테스트 코드를 작성해주세요. 엣지 케이스도 포함하세요.

{{input}}`,
        'commit': `# 커밋 메시지 생성
현재 작업 디렉토리({{workspace}})의 git diff를 분석하고 적절한 커밋 메시지를 작성해주세요.
Conventional Commits 형식을 사용하세요.

{{input}}`,
        'translate': `# 번역
다음 텍스트를 번역해주세요. 원문의 뉘앙스와 맥락을 살려서 자연스럽게 번역하세요.

{{input}}`,
        'fix': `# 버그 수정
다음 코드의 버그를 찾아서 수정해주세요. 원인 분석과 수정된 코드를 모두 제공하세요.

{{input}}`,
        'doc': `# 문서화
다음 코드에 대한 문서(주석, docstring, README 등)를 작성해주세요.

{{input}}`,
      };
      ensureDir(SKILLS_DIR);
      let created = 0;
      for (const [sname, content] of Object.entries(defaults)) {
        if (!loadSkill(sname)) {
          saveSkill(sname, content);
          created++;
        }
      }
      console.log(`${c.green}기본 스킬 ${created}개 생성됨${c.reset}`);
      const skills = listSkills();
      for (const s of skills) {
        console.log(`  ${c.cyan}/${s}${c.reset}`);
      }
      console.log(`\n  ${c.dim}사용 예: /review 이 함수의 문제점을 찾아줘${c.reset}`);
      console.log(`  ${c.dim}수정: /skill edit <이름> 또는 직접 ${SKILLS_DIR}/ 편집${c.reset}\n`);
      break;
    }
    default:
      console.log(`  사용법: /skill [list|show|new|edit|delete|init]\n`);
  }
}

function printHelp() {
  console.log(`
  ${c.bold}Light-zai v${VERSION} 명령어${c.reset}
  ${c.dim}${'─'.repeat(40)}${c.reset}

  ${c.cyan}◆ 대화${c.reset}
    /clear          대화 기록 초기화
    /history        대화 기록 보기
    /pop            마지막 대화 쌍 제거
    /save [이름]    세션 저장
    /load [이름]    세션 로드
    /sessions       저장된 세션 목록

  ${c.cyan}◆ 설정${c.reset}
    /model [이름]   모델 변경/목록
    /stream         스트리밍 토글
    /think          사고 모드 토글
    /tools          도구 호출 토글
    /websearch      웹 검색 토글
    /json           JSON 모드 토글
    /hud            사용량 HUD 토글
    /usage          사용량 상세 (세션 + 구간별)
    /quota          쿼터 설정 (5h/daily/weekly)
    /config [키 값] 설정 보기/변경
    /config save    설정 파일로 저장

  ${c.cyan}◆ API / 검색${c.reset}
    /search <검색어>    웹 검색 (DuckDuckGo)
    /zsearch <검색어>   웹 검색 (search-prime)
    /read <URL>         URL 읽기 (웹 리더)
    /image <프롬프트>   이미지 생성 ${c.dim}[--size WxH]${c.reset}
    /video <프롬프트>   비디오 생성 ${c.dim}[--audio] [--duration N]${c.reset}
    /poll <작업ID>      비동기 작업 결과 조회
    /ocr <URL>          OCR 레이아웃 파싱
    /embed <텍스트>     텍스트 임베딩
    /tokens             현재 대화 토큰 수
    /upload <파일>      파일 업로드
    /transcribe <파일>  음성 인식 (ASR)

  ${c.cyan}◆ 프리셋${c.reset}
    /preset              프리셋 목록
    /preset load <이름>  프리셋 적용
    /preset save <이름>  프리셋 저장
    /preset show         활성 프리셋 보기
    /preset off          프리셋 해제

  ${c.cyan}◆ 스킬${c.reset}  ${c.dim}(/<스킬이름> [인자]로 호출)${c.reset}
    /skill          스킬 목록
    /skill init     기본 스킬 세트 생성
    /skill new      스킬 생성
    /skill show     스킬 내용 보기
    /skill edit     스킬 편집

  ${c.cyan}◆ MCP 서버${c.reset}
    /mcp                         서버 목록
    /mcp add <이름> <URL>        HTTP 서버 등록
    /mcp stdio <이름> <cmd...>   stdio 서버 등록
    /mcp connect|disconnect      서버 연결/해제
    /mcp tools                   연결된 MCP 도구

  ${c.cyan}◆ 기타${c.reset}
    /doctor   시스템 진단    /status   현재 상태
    /help     이 도움말      /exit     종료
    ${c.bold}!${c.reset}         Bash 모드 전환 ${c.dim}(exit로 복귀)${c.reset}

  ${c.cyan}◆ 단축키${c.reset}
    Shift+↑/↓   출력 기록 스크롤 모드
                ${c.dim}↑↓:1줄  PgUp/Dn:페이지  Home/End  ESC:닫기${c.reset}
`);
}

function printStatus() {
  const msgCount = conversationHistory.length - 1;
  const turns = Math.floor(msgCount / 2);
  const mode = bashMode ? `${c.yellow}Bash${c.reset}` : `${c.green}AI${c.reset}`;
  const mcpInfo = Object.keys(mcpServers).length > 0
    ? `${c.green}${Object.keys(mcpServers).join(', ')}${c.reset} (${getMcpFunctionTools().length}개 도구)`
    : `${c.dim}없음${c.reset}`;
  const tokenInfo = lastUsage
    ? `입력 ${lastUsage.prompt_tokens || '?'} + 출력 ${lastUsage.completion_tokens || '?'} = ${c.bold}${lastUsage.total_tokens || '?'}${c.reset}`
    : `${c.dim}없음${c.reset}`;
  const content = [
    `${c.dim}모드${c.reset}       ${mode}              ${c.dim}모델${c.reset} ${c.cyan}${CFG.model}${c.reset}`,
    `${c.dim}대화${c.reset}       ${turns}턴 (${conversationHistory.length}메시지)`,
    '',
    `${c.dim}스트리밍${c.reset}   ${onoff(CFG.stream)}     ${c.dim}사고${c.reset}   ${onoff(CFG.think)}`,
    `${c.dim}도구${c.reset}       ${onoff(CFG.tools)}     ${c.dim}검색${c.reset}   ${onoff(CFG.webSearch)}`,
    `${c.dim}JSON${c.reset}       ${onoff(CFG.jsonMode)}     ${c.dim}HUD${c.reset}    ${onoff(hudEnabled)}`,
    '',
    `${c.dim}프리셋${c.reset}     ${activePreset ? c.green + activePreset.name + c.reset : c.dim + 'OFF' + c.reset}`,
    `${c.dim}MCP${c.reset}        ${mcpInfo}`,
    `${c.dim}토큰${c.reset}       ${tokenInfo}`,
    `${c.dim}세션 합계${c.reset}  ${sessionUsage.requests}회 / ${c.bold}${fmtTokens(sessionUsage.totalTokens)}${c.reset} 토큰`,
    `${c.dim}디렉토리${c.reset}   ${CFG.workspace}`,
  ];
  console.log('\n' + drawBox(content, { title: `${c.bold}현재 상태${c.reset}`, color: c.cyan }) + '\n');
}

// ===== 스플래시 화면 =====
function showSplash() {
  if (!IS_TTY) return;
  const features = [
    CFG.stream ? `${c.green}●${c.reset} 스트리밍` : `${c.dim}○ 스트리밍${c.reset}`,
    CFG.think  ? `${c.green}●${c.reset} 사고` : `${c.dim}○ 사고${c.reset}`,
    CFG.tools  ? `${c.green}●${c.reset} 도구` : `${c.dim}○ 도구${c.reset}`,
    CFG.webSearch ? `${c.green}●${c.reset} 검색` : `${c.dim}○ 검색${c.reset}`,
  ].join('  ');
  const content = [
    '',
    `${c.bold}     Light-zai${c.reset} ${c.dim}v${VERSION}${c.reset}`,
    `     경량 올인원 AI 코딩 어시스턴트`,
    `     ${c.dim}ARM7L / x86_64 / aarch64 — 무의존성${c.reset}`,
    '',
    `  ${c.dim}모델${c.reset}  ${c.cyan}${CFG.model}${c.reset}`,
    `  ${c.dim}서버${c.reset}  ${CFG.baseUrl}`,
    `  ${features}`,
    '',
    `  ${c.dim}/help${c.reset} 명령어 확인  ${c.dim}!${c.reset} Bash 전환`,
    '',
  ];
  console.log('\n' + drawBox(content, { color: c.cyan }) + '\n');
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
    const oneSpin = createSpinner('응답 대기중...').start();
    const res = await zaiChat(conversationHistory);
    oneSpin.stop();
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
    if (arg === '--mcp') { result.mode = 'mcp'; result.value = args.slice(i+1).join(' '); return result; }
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
  if (cli.mode === 'mcp') { await cmdMcp(cli.value); return; }

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

  // 시스템 프롬프트 (buildSystemPrompt 사용)
  conversationHistory.push({ role: 'system', content: buildSystemPrompt() });

  // MCP 서버 자동 연결
  const mcpConfig = loadMcpConfig();
  if (Object.keys(mcpConfig.servers || {}).length > 0) {
    await mcpAutoConnect();
    // MCP 도구가 추가됐으면 시스템 프롬프트 갱신
    if (Object.keys(mcpServers).length > 0) {
      conversationHistory[0].content = buildSystemPrompt();
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  _rl = rl;

  // 스크롤 시스템 초기화 (출력 캡처 + 키 인터셉터)
  initOutputCapture();
  installScrollKeyHandler();

  function getPrompt() {
    if (bashMode) return `${c.yellow}bash${c.reset} ${c.dim}${path.basename(CFG.workspace)}${c.reset} ${c.yellow}▸${c.reset} `;
    const usage = hudEnabled && sessionUsage.totalTokens > 0 ? `${c.dim}[${fmtTokens(sessionUsage.totalTokens)}]${c.reset} ` : '';
    return `${usage}${c.cyan}사용자${c.reset} ${c.cyan}▸${c.reset} `;
  }

  function prompt() { rl.setPrompt(getPrompt()); rl.prompt(); }

  prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    // Bash 모드 토글
    if (input === '!') {
      bashMode = !bashMode;
      console.log(bashMode ? `\n  ${c.yellow}▸ Bash 모드${c.reset} ${c.dim}(exit 로 복귀)${c.reset}\n` : `\n  ${c.green}▸ AI 모드${c.reset}\n`);
      prompt(); return;
    }

    // Bash 모드
    if (bashMode) {
      if (input === 'exit') { bashMode = false; console.log(`\n  ${c.green}▸ AI 모드${c.reset}\n`); prompt(); return; }
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
        console.log(`${c.green}AI ▸${c.reset} ${response}\n`);
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
