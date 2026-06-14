#!/usr/bin/env bash
# ADR-095 Этап A — S4: 24-часовой long-run.
# Каждые 30 минут — один `claude --print`. Цель: поймать refresh access_token
# (он живёт ~1 час), убедиться что refresh не падает и что (опционально)
# обновлённый refresh_token дописывается обратно в .credentials.json.
#
# Использование (запуск в фоне на dev-машине или EC2):
#   docker run --rm -d --name adr-095-s4 \
#       -v ~/.claude/.credentials.json:/home/runtime/.claude/.credentials.json:rw \
#       -v $PWD/s4-logs:/home/runtime/logs \
#       adr-095-smoke /home/runtime/s4.sh
#
# ВНИМАНИЕ: маунт credentials как :rw — иначе claude не сможет
# дописать ротированный refresh_token. Если хочешь :ro — поменяй
# в команде выше, но тогда S4 проверяет только что старый refresh
# принимается без записи.

set -u

LOG_FILE="/home/runtime/logs/s4.log"
META_FILE="/home/runtime/logs/s4.meta"
mkdir -p /home/runtime/logs
INTERVAL_SEC=${INTERVAL_SEC:-1800}  # 30 min
TOTAL_HOURS=${TOTAL_HOURS:-24}
ITERATIONS=$((TOTAL_HOURS * 3600 / INTERVAL_SEC))

CREDS=/home/runtime/.claude/.credentials.json

log() {
    echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG_FILE"
}

# Снимаем начальный хэш credentials — чтобы детектить ротацию.
CREDS_HASH_START=$(sha256sum "$CREDS" 2>/dev/null | awk '{print $1}')
EXPIRES_START=$(grep -oE '"expiresAt":[0-9]+' "$CREDS" | head -1 | sed 's/.*://')
log "S4 start: iterations=$ITERATIONS interval=${INTERVAL_SEC}s"
log "creds hash (start): $CREDS_HASH_START"
log "creds expiresAt (start): $EXPIRES_START"
echo "iter,ts,exit_code,duration_ms,creds_changed,output_len" > "$META_FILE"

for i in $(seq 1 "$ITERATIONS"); do
    log "--- iteration $i / $ITERATIONS ---"
    T0=$(date +%s%3N)
    OUT=$(claude --print "Iteration $i. Reply: OK_$i" 2>&1)
    RC=$?
    T1=$(date +%s%3N)
    CREDS_HASH_NOW=$(sha256sum "$CREDS" 2>/dev/null | awk '{print $1}')
    CHANGED=$([ "$CREDS_HASH_NOW" != "$CREDS_HASH_START" ] && echo 1 || echo 0)
    LEN=$(echo "$OUT" | wc -c)

    log "iter=$i exit=$RC dur_ms=$((T1 - T0)) creds_changed=$CHANGED out_len=$LEN"
    if [ "$RC" -ne 0 ]; then
        log "STDERR/OUT (iter $i): $(echo "$OUT" | head -5)"
    fi
    if [ "$CHANGED" = "1" ]; then
        log "creds file changed at iter $i — refresh_token ротирован"
        EXPIRES_NOW=$(grep -oE '"expiresAt":[0-9]+' "$CREDS" | head -1 | sed 's/.*://')
        log "new expiresAt: $EXPIRES_NOW"
        CREDS_HASH_START="$CREDS_HASH_NOW"  # обновим baseline
    fi

    echo "$i,$(date -u +%FT%TZ),$RC,$((T1 - T0)),$CHANGED,$LEN" >> "$META_FILE"

    if [ "$i" -lt "$ITERATIONS" ]; then
        sleep "$INTERVAL_SEC"
    fi
done

log "S4 finished. Summary in $META_FILE."
echo "--- summary ---"
awk -F, 'NR>1 { total++; if ($3==0) ok++; total_dur+=$4; if ($5==1) rotated++ } END {
    if (total==0) { print "no iterations"; exit }
    printf "iterations: %d  ok: %d  failed: %d  avg_ms: %.0f  refresh_rotations: %d\n", \
        total, ok, total-ok, total_dur/total, rotated
}' "$META_FILE"
