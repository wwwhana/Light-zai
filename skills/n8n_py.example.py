# description: n8n 워크플로우를 실행합니다 (Python)
# parameters: {"query": {"type": "string", "description": "워크플로우에 전달할 입력"}}
# prompt: [n8n 결과]\n{{result}}\n\n위 결과를 사용자에게 요약해주세요.
#
# n8n 웹훅 연동 Python 스킬 예제
# ~/.config/light-zai/skills/n8n.py 로 복사 후 URL 수정
#
# 사용법:
#   /n8n 오늘 날씨           ← 직접 호출
#   AI가 skill__n8n 도구 호출 ← tools 활성화 시
#
# stdin: JSON {"input": "사용자 입력"} 또는 {"query": "..."}
# stdout: 결과 (JSON 또는 텍스트)
#
# 환경변수: WORKSPACE (작업 디렉토리)

import sys
import json
from urllib.request import Request, urlopen
from urllib.error import URLError

# ★ 여기에 n8n 웹훅 URL을 넣으세요
WEBHOOK_URL = 'http://localhost:5678/webhook/your-webhook-id'

def main():
    data = json.loads(sys.stdin.read())
    query = data.get('input') or data.get('query') or ''

    req = Request(
        WEBHOOK_URL,
        data=json.dumps({'query': query}).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urlopen(req, timeout=30) as res:
            result = json.loads(res.read().decode())
            print(json.dumps(result, ensure_ascii=False))
    except URLError as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
