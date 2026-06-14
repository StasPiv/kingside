#!/usr/bin/env bash
# ADR-095 Этап A — S1: один запрос `claude --print` в контейнере.
# Ожидание: успешный ответ модели, не более 30 секунд, никаких 401/403.
#
# Использование (вне контейнера, на dev-машине):
#   docker run --rm \
#       -v ~/.claude/.credentials.json:/home/runtime/.claude/.credentials.json:ro \
#       adr-095-smoke /home/runtime/s1.sh

set -u

echo "=== ADR-095 S1: single claude --print ==="
echo "host: $(hostname)"
echo "user: $(id -un) uid=$(id -u)"
echo "date: $(date -u +%FT%TZ)"
echo "claude version: $(claude --version 2>&1 | head -1)"
echo "creds present: $(test -f /home/runtime/.claude/.credentials.json && echo yes || echo NO)"
echo "creds size: $(stat -c '%s bytes' /home/runtime/.claude/.credentials.json 2>/dev/null || echo n/a)"
echo "---"

START_TS=$(date +%s%3N)
# --print: один-shot, выйти после ответа. Без MCP, без resume.
OUTPUT=$(claude --print "Reply with exact text: SMOKE_OK" 2>&1)
EXIT_CODE=$?
END_TS=$(date +%s%3N)
DURATION_MS=$((END_TS - START_TS))

echo "--- stdout/stderr ---"
echo "$OUTPUT"
echo "--- meta ---"
echo "exit_code: $EXIT_CODE"
echo "duration_ms: $DURATION_MS"

if [ "$EXIT_CODE" -eq 0 ] && echo "$OUTPUT" | grep -q "SMOKE_OK"; then
    echo "RESULT: PASS"
    exit 0
else
    echo "RESULT: FAIL"
    exit 1
fi
