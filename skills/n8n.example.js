// n8n 웹훅 연동 JS 스킬 예제
// ~/.config/light-zai/skills/n8n.js 로 복사 후 URL 수정
//
// 사용법:
//   /n8n 오늘 날씨 알려줘       ← 직접 호출
//   AI가 도구로 자동 호출       ← tools 활성화 시
//
// ctx.http(method, url, body) — 내장 HTTP 헬퍼 (외부 의존성 없음)

module.exports = {
  // AI에게 보여줄 도구 설명
  description: 'n8n 워크플로우를 실행합니다',

  // AI function calling용 파라미터 (정의하면 도구 목록에 추가됨)
  parameters: {
    query: { type: 'string', description: '워크플로우에 전달할 입력' },
  },

  // AI에게 결과를 전달할 때 사용할 프롬프트 (선택)
  // {{result}} — 실행 결과, {{input}} — 사용자 입력
  // prompt: false 로 설정하면 AI에게 보내지 않고 결과만 출력
  prompt: '[n8n 결과]\n{{result}}\n\n위 결과를 사용자에게 요약해주세요.',

  // 실행 함수
  // /n8n <입력> 으로 호출 시: input = 문자열
  // AI 도구로 호출 시: input = { query: '...' }
  async execute(input, ctx) {
    const query = typeof input === 'string' ? input : input.query;

    // ★ 여기에 n8n 웹훅 URL을 넣으세요
    const WEBHOOK_URL = 'http://localhost:5678/webhook/your-webhook-id';

    const res = await ctx.http('POST', WEBHOOK_URL, { query });
    return res.data;
  }
};
