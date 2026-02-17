#!/bin/bash
# Z.AI (open.bigmodel.cn) 사용량 API 탐색 스크립트
# 사용법: ZAI_API_KEY="your-key" bash test_usage_api.sh

KEY="${ZAI_API_KEY:-$1}"
if [ -z "$KEY" ]; then
  echo "사용법: ZAI_API_KEY=키 bash test_usage_api.sh"
  echo "  또는: bash test_usage_api.sh 키"
  exit 1
fi

HOST="open.bigmodel.cn"
echo "=== Z.AI ($HOST) 사용량 API 탐색 ==="
echo "키: ${KEY:0:8}...${KEY: -4}"
echo ""

# 탐색할 엔드포인트 목록
ENDPOINTS=(
  # ChatGPT 패턴 변형 (backend-api/wham/usage)
  "/backend-api/wham/usage"
  "/api/wham/usage"

  # 일반 사용량/잔액 패턴
  "/api/paas/v4/usage"
  "/api/paas/v4/balance"
  "/api/paas/v4/account"
  "/api/paas/v4/quota"
  "/api/paas/v4/billing/usage"
  "/api/paas/v4/dashboard/billing/usage"
  "/api/paas/v4/dashboard/billing/subscription"
  "/api/paas/v4/dashboard/billing/credit_grants"

  # 사용자 관련
  "/api/user/usage"
  "/api/user/balance"
  "/api/user/info"
  "/api/user/account"
  "/api/user/finance"
  "/api/user/quota"

  # 파이낸스 관련
  "/api/finance/balance"
  "/api/finance/usage"
  "/finance-center/api/balance"

  # 루트 레벨
  "/api/usage"
  "/api/balance"
  "/api/account"
  "/api/billing"
  "/api/quota"

  # v4 외
  "/api/paas/usage"
  "/api/paas/account"
  "/api/paas/balance"
)

for ep in "${ENDPOINTS[@]}"; do
  echo -n "  $ep ... "
  RESP=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $KEY" \
    -H "Accept: application/json" \
    "https://$HOST$ep" 2>/dev/null)

  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    echo -e "\033[32m$HTTP_CODE ✓\033[0m"
    echo "    $BODY" | head -c 500
    echo ""
  elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    echo -e "\033[33m$HTTP_CODE (인증 필요/거부)\033[0m"
  elif [ "$HTTP_CODE" = "404" ]; then
    echo -e "\033[90m$HTTP_CODE\033[0m"
  else
    echo -e "\033[31m$HTTP_CODE\033[0m"
    # 4xx/5xx지만 404가 아닌 경우 응답 본문 표시
    if [ -n "$BODY" ] && [ "$HTTP_CODE" != "000" ]; then
      echo "    ${BODY:0:200}"
    fi
  fi
done

echo ""
echo "=== ChatGPT (chatgpt.com) 참고 ==="
echo "curl -s -H 'Authorization: Bearer \$OPENAI_KEY' https://chatgpt.com/backend-api/wham/usage"
echo ""
echo "=== OpenAI (api.openai.com) 공식 ==="
START=$(date -d '7 days ago' +%s 2>/dev/null || date -v-7d +%s 2>/dev/null || echo "1707000000")
echo "curl -s -H 'Authorization: Bearer \$OPENAI_KEY' 'https://api.openai.com/v1/organization/usage/completions?start_time=$START&bucket_width=1d'"
echo ""
echo "=== Anthropic (api.anthropic.com) 공식 ==="
echo "curl -s -H 'anthropic-version: 2023-06-01' -H 'x-api-key: \$ANTHROPIC_ADMIN_KEY' 'https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2026-02-10T00:00:00Z")&ending_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2026-02-17T23:59:59Z")&bucket_width=1d'"
