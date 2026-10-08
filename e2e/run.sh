#!/usr/bin/env bash
# Startet Testserver (frische In-Memory-Datenbank) und Vite, führt den Browsertest aus und räumt auf.
# Voraussetzungen: `pnpm install`, ein Chromium (CHROMIUM_PATH oder von Playwright installiert).
# Optional: ML_SERVICE_URL (Spracherkennung/Embeddings/OCR), E2E_MIC_WAV (+ E2E_MIC_EXPECT) für den Sprachdialog.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${E2E_API_PORT:-3100}"
WEB_PORT="${E2E_WEB_PORT:-5173}"
LOG_DIR="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_for() { # Datei, Muster, Name
  for _ in $(seq 1 90); do grep -aq "$2" "$1" 2>/dev/null && return 0; sleep 1; done
  echo "$3 wurde nicht bereit, Log: $1" >&2; tail -20 "$1" >&2 || true; exit 1
}

PORT="$API_PORT" NODE_ENV=production pnpm --filter @bid/api exec tsx ../../e2e/smoke-server.mts >"$LOG_DIR/api.log" 2>&1 &
PIDS+=($!)
wait_for "$LOG_DIR/api.log" "bereit" "Testserver"

API_URL="http://127.0.0.1:$API_PORT" pnpm --filter @bid/web exec vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort >"$LOG_DIR/web.log" 2>&1 &
PIDS+=($!)
wait_for "$LOG_DIR/web.log" "Local" "Vite"

E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" node e2e/smoke.mjs
