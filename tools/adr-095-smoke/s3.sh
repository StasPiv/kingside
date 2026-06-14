#!/usr/bin/env bash
# ADR-095 Этап A — S3: 4 параллельных `claude --print` процесса.
# Цель — проверить multi-process OAuth contention (риск §6.2 ADR).
# Ожидание: все 4 завершаются успехом, нет 429/401/invalid_grant.
#
# Использование:
#   docker run --rm \
#       -v ~/.claude/.credentials.json:/home/runtime/.claude/.credentials.json:ro \
#       adr-095-smoke /home/runtime/s3.sh

set -u

N=4
echo "=== ADR-095 S3: $N parallel claude --print ==="
echo "host: $(hostname)  user: $(id -un)  date: $(date -u +%FT%TZ)"
echo "claude version: $(claude --version 2>&1 | head -1)"
echo "---"

LOGDIR=$(mktemp -d)
echo "logs: $LOGDIR"
START_TS=$(date +%s%3N)

PIDS=()
for i in $(seq 1 "$N"); do
    (
        T0=$(date +%s%3N)
        out=$(claude --print "Reply with text: SMOKE_OK_$i" 2>&1)
        rc=$?
        T1=$(date +%s%3N)
        echo "worker=$i exit=$rc dur_ms=$((T1 - T0))" > "$LOGDIR/w$i.meta"
        echo "$out" > "$LOGDIR/w$i.out"
    ) &
    PIDS+=($!)
done

FAIL=0
for pid in "${PIDS[@]}"; do
    if ! wait "$pid"; then
        FAIL=$((FAIL + 1))
    fi
done

END_TS=$(date +%s%3N)
echo "--- results ---"
for f in "$LOGDIR"/w*.meta; do
    echo "$(cat "$f")"
    # Первая строка вывода каждого воркера для краткого обзора.
    head -1 "${f%.meta}.out"
    echo "..."
done
echo "--- summary ---"
echo "total_duration_ms: $((END_TS - START_TS))"
echo "workers: $N  failed: $FAIL"

if [ "$FAIL" -eq 0 ]; then
    # Дополнительно: проверка что в выводе нет признаков rate-limit / auth.
    if grep -lE "(429|401|invalid_grant|rate.?limit|unauthorized)" "$LOGDIR"/w*.out > /dev/null 2>&1; then
        echo "RESULT: FAIL (rate-limit/auth signal in output, см. $LOGDIR)"
        exit 2
    fi
    echo "RESULT: PASS"
    exit 0
else
    echo "RESULT: FAIL ($FAIL workers failed, см. $LOGDIR)"
    exit 1
fi
