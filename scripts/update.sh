#!/usr/bin/env bash
# pi-zed update: pull → install deps (if changed) → build aside → smoke test → swap → re-register.
# The running build (dist/) is only replaced after the new one passes; on failure the
# checkout is rolled back and the current install keeps working.
# Usage: ./scripts/update.sh [--check] [--force] [--skip-test]
set -euo pipefail
cd "$(dirname "$0")/.."

check=0 force=0 skip_test=0
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    --force) force=1 ;;
    --skip-test) skip_test=1 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✗ 알 수 없는 옵션: $arg"; exit 1 ;;
  esac
done

version() { node -p 'require("./package.json").version'; }

# 1. 사전 조건
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( node_major < 22 )); then
  echo "✗ Node.js 22+ 필요 (현재: $(node -v 2>/dev/null || echo 없음))"; exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "✗ 로컬 변경사항이 있습니다. 커밋하거나 stash 한 뒤 다시 실행하세요."
  git status --short --untracked-files=no
  exit 1
fi
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) || {
  echo "✗ 현재 브랜치에 upstream이 없습니다 (git branch -u origin/main)"; exit 1
}

# 2. 새 버전 확인
echo "• git fetch"
git fetch --quiet
old_rev=$(git rev-parse HEAD)
old_version=$(version)
behind=$(git rev-list --count "HEAD..$upstream")

if (( behind == 0 )); then
  echo "✓ 이미 최신입니다 (v$old_version, $(git rev-parse --short HEAD))"
  if (( check )) || { (( ! force )) && [[ -f dist/index.js ]]; }; then
    exit 0
  fi
  echo "• 재빌드합니다 (--force 또는 dist 없음)"
else
  echo "• 업데이트 $behind개 커밋:"
  git log --oneline --no-decorate "HEAD..$upstream" | sed 's/^/    /'
  (( check )) && exit 0
fi

# 3. 실패하면 이전 커밋/의존성으로 되돌린다 (dist/는 아직 건드리지 않았음)
deps_changed=0
rollback() {
  echo "✗ 업데이트 실패 — $(git rev-parse --short "$old_rev") 로 되돌립니다"
  rm -rf dist.next
  git reset --quiet --hard "$old_rev"
  if (( deps_changed )); then npm install --silent || true; fi
  echo "  기존 설치는 그대로 동작합니다."
}
trap rollback ERR

if (( behind > 0 )); then
  echo "• git pull"
  git merge --quiet --ff-only "$upstream"
fi

# 4. 의존성 (lockfile이 바뀌었거나 node_modules가 없을 때만)
if ! git diff --quiet "$old_rev" HEAD -- package.json package-lock.json || [[ ! -d node_modules ]]; then
  deps_changed=1
  echo "• npm install"; npm install --silent
fi

# 5. 옆 디렉터리에 빌드 → 스모크 테스트 (Zed가 쓰는 dist/는 그대로)
echo "• build"
rm -rf dist.next
npx --no-install tsc --outDir dist.next
chmod +x dist.next/index.js
if (( ! skip_test )); then
  echo "• smoke test"
  out=$(SMOKE_ENTRY="$PWD/dist.next/index.js" SMOKE_CAPS=none SMOKE_TIMEOUT_MS=30000 node scripts/smoke.mjs 2>&1) || { echo "$out"; false; }
  grep -q '"sessionId"' <<<"$out" || { echo "$out"; echo "✗ 세션 생성 실패"; false; }
fi

# 6. 교체
rm -rf dist.old
[[ -d dist ]] && mv dist dist.old
mv dist.next dist
rm -rf dist.old
trap - ERR

# 7. Zed 등록 갱신 (node 경로가 바뀐 경우 대비, 변경 없으면 그대로)
node scripts/configure-zed.mjs

echo
echo "✓ 완료: v$old_version ($(git rev-parse --short "$old_rev")) → v$(version) ($(git rev-parse --short HEAD))"
echo "  이미 열려 있는 pi-zed 프로세스에는 반영되지 않습니다. Zed를 재시작하세요."
