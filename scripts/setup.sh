#!/usr/bin/env bash
# pi-zed one-shot setup: install deps → build → smoke test → register in Zed.
# Usage: ./scripts/setup.sh [--uninstall] [--skip-test]
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--uninstall" ]]; then
  node scripts/configure-zed.mjs --uninstall
  exit 0
fi

# 1. 사전 조건
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( node_major < 22 )); then
  echo "✗ Node.js 22+ 필요 (현재: $(node -v 2>/dev/null || echo 없음))"; exit 1
fi
if [[ ! -d "$HOME/.pi/agent" ]]; then
  echo "! ~/.pi/agent 없음 — 터미널에서 pi를 한 번 실행해 모델/키를 먼저 설정하세요."
fi

# 2. 설치 & 빌드
echo "• npm install"; npm install --silent
echo "• build";       npm run --silent build
chmod +x dist/index.js

# 3. 스모크 테스트 (모델 호출 없음: initialize + session/new 만)
if [[ "${1:-}" != "--skip-test" ]]; then
  echo "• smoke test"
  if ! out=$(SMOKE_CAPS=none SMOKE_TIMEOUT_MS=30000 node scripts/smoke.mjs 2>&1); then
    echo "$out"; echo "✗ 스모크 테스트 실패"; exit 1
  fi
  grep -q '"sessionId"' <<<"$out" || { echo "$out"; echo "✗ 세션 생성 실패"; exit 1; }
fi

# 4. Zed 등록
node scripts/configure-zed.mjs

echo
echo "완료! Zed Agent 패널 → '+' → pi-zed 선택 (Zed가 켜져 있으면 설정은 자동 반영됩니다)."
echo "제거: ./scripts/setup.sh --uninstall"
