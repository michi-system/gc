#!/bin/zsh
set -euo pipefail

ROOT="/Users/tadamichikimura/Downloads/dev-HQ/gc/greenfield"
LOG_DIR="$ROOT/.local/logs"

mkdir -p "$LOG_DIR"

exec /opt/homebrew/bin/cloudflared tunnel --config "$ROOT/cloudflared-gc-console.yml" run gc-console >>"$LOG_DIR/tunnel.log" 2>&1
