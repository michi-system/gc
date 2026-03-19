#!/bin/zsh
set -euo pipefail

ROOT="/Users/tadamichikimura/Downloads/dev-HQ/gc/greenfield"
LOG_DIR="$ROOT/.local/logs"

mkdir -p "$LOG_DIR"

cd "$ROOT"
npm run build >>"$LOG_DIR/server-build.log" 2>&1

export BASE_URL="https://gc.azus.tokyo"
exec /usr/bin/env node "$ROOT/dist/server.js" >>"$LOG_DIR/server.log" 2>&1
