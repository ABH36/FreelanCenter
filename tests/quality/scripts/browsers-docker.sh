#!/usr/bin/env bash
# Runs the Firefox and WebKit checks in the same Linux image CI uses (WebKit needs system libraries that a
# Windows machine may lack). Usage (repo root): bash tests/quality/scripts/browsers-docker.sh
set -euo pipefail
IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
(cd "$ROOT/tests/quality" && pnpm build:server)
MSYS_NO_PATHCONV=1 docker run --rm --ipc=host -v "$ROOT:/repo:ro" "$IMAGE" bash -c '
  set -e
  W=/work; mkdir -p $W/tests/quality $W/packages/templates $W/apps/sites
  cp -r /repo/tests/quality/src /repo/tests/quality/playwright.config.ts /repo/tests/quality/.cache $W/tests/quality/
  cp -r /repo/packages/templates/seed $W/packages/templates/seed
  cp -r /repo/apps/sites/public $W/apps/sites/public
  cd $W/tests/quality
  npm init -y >/dev/null && npm i --silent @playwright/test@1.64.1 @axe-core/playwright@4.13.0
  npx playwright test --project=firefox --project=webkit-mobile
'
