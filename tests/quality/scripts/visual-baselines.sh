#!/usr/bin/env bash
# Regenerates the visual-regression baselines in the same Linux image CI uses (fonts and anti-aliasing differ per OS).
# Usage (repo root, Git Bash/Linux/macOS):  bash tests/quality/scripts/visual-baselines.sh [update|check]
set -euo pipefail
MODE="${1:-update}"
IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
(cd "$ROOT/tests/quality" && pnpm build:server)
MSYS_NO_PATHCONV=1 docker run --rm --ipc=host -v "$ROOT:/repo:ro" -v "$ROOT/tests/quality/src/__screenshots__:/out" "$IMAGE" bash -c '
  set -e
  W=/work; mkdir -p $W/tests/quality $W/packages/templates $W/apps/sites
  cp -r /repo/tests/quality/src /repo/tests/quality/playwright.config.ts /repo/tests/quality/.cache $W/tests/quality/
  rm -rf $W/tests/quality/src/__screenshots__ $W/tests/quality/src/a11y.spec.ts $W/tests/quality/src/browsers.spec.ts $W/tests/quality/src/modes.spec.ts
  cp -r /repo/packages/templates/seed $W/packages/templates/seed
  cp -r /repo/apps/sites/public $W/apps/sites/public
  cd $W/tests/quality
  [ -d /out ] && [ "'"$MODE"'" = check ] && cp -r /out src/__screenshots__ || true
  npm init -y >/dev/null && npm i --silent @playwright/test@1.64.1
  if [ "'"$MODE"'" = update ]; then npx playwright test --grep @visual --update-snapshots; cp -r src/__screenshots__/. /out/; else npx playwright test --grep @visual; fi
'
