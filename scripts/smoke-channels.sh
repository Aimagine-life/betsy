#!/usr/bin/env bash
# Manual smoke test for Personal Betsy v2 channels layer.
#
# Requirements:
#   - Postgres reachable via BC_DATABASE_URL
#   - Real GEMINI_API_KEY
#   - Real BC_TELEGRAM_BOT_TOKEN (test bot, not production)
#
# Usage:
#   BC_DATABASE_URL=postgres://... \
#   GEMINI_API_KEY=... \
#   BC_TELEGRAM_BOT_TOKEN=... \
#   ./scripts/smoke-channels.sh
#
# What happens:
#   1. Builds the project
#   2. Starts `BETSY_MODE=multi node dist/index.js` in background
#   3. Waits for healthz to go green
#   4. Prints the bot username from getMe
#   5. You open Telegram and write to that bot
#   6. You ctrl+c to kill the server
#
# Expected user journey:
#   - /start → bot asks your name
#   - You type "Константин" → bot asks business
#   - You type "Делаю AI-агентов" → bot asks ty/vy
#   - You click "На ты" → bot greets and activates
#   - You type "Привет! Что ты обо мне помнишь?" → bot answers in Betsy's vibe with your facts
#   - You type "/status" → plan, tokens, balance
#   - You type "/link" → bot gives a 6-digit code

set -e

if [ -z "${BC_DATABASE_URL}" ]; then
  echo "BC_DATABASE_URL is required"; exit 1
fi
if [ -z "${GEMINI_API_KEY}" ]; then
  echo "GEMINI_API_KEY is required"; exit 1
fi
if [ -z "${BC_TELEGRAM_BOT_TOKEN}" ]; then
  echo "BC_TELEGRAM_BOT_TOKEN is required"; exit 1
fi

export BETSY_MODE=multi
export BC_HTTP_PORT=${BC_HTTP_PORT:-18080}
export BC_HEALTHZ_PORT=${BC_HEALTHZ_PORT:-18081}
export BC_LOG_LEVEL=${BC_LOG_LEVEL:-info}

echo "[smoke] building..."
npm run build

echo "[smoke] checking Telegram bot username..."
BOT_INFO=$(curl -s "https://api.telegram.org/bot${BC_TELEGRAM_BOT_TOKEN}/getMe")
USERNAME=$(echo "$BOT_INFO" | grep -oE '"username":"[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$USERNAME" ]; then
  echo "[smoke] Telegram getMe failed:"
  echo "$BOT_INFO"
  exit 1
fi
echo "[smoke] bot: @$USERNAME  →  https://t.me/$USERNAME"

echo "[smoke] starting multi server..."
node dist/index.js &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null || true" EXIT

sleep 5

echo "[smoke] checking healthz..."
curl -s -w "\nHTTP %{http_code}\n" "http://localhost:${BC_HEALTHZ_PORT}/healthz"

echo ""
echo "========================================="
echo "Server running. Open https://t.me/$USERNAME"
echo "Try: /start, then answer 3 questions,"
echo "     then send 'Что ты обо мне помнишь?'"
echo "Ctrl+C to stop."
echo "========================================="

wait $SERVER_PID
