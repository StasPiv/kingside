#!/bin/bash
LOCAL_PORT=${1:-9876}
REMOTE_PORT=${2:-9877}
echo "Туннель: kamatera-chess:${REMOTE_PORT} -> localhost:${LOCAL_PORT}"
# Авто-reconnect: ssh при разрыве сети/DNS возвращает ненулевой код,
# цикл переподнимает с экспоненциальной паузой (5с → 10 → 20 → 40 → 60),
# чтобы не долбить kamatera-chess при длительной потере связи.
backoff=5
while true; do
    ssh -N -R "${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" kamatera-chess \
        -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes -o ConnectTimeout=15
    rc=$?
    echo "[tunnel] ssh exit=${rc}, retry in ${backoff}s ($(date -Is))"
    sleep "${backoff}"
    if [ "${backoff}" -lt 60 ]; then
        backoff=$((backoff * 2))
        [ "${backoff}" -gt 60 ] && backoff=60
    fi
done
