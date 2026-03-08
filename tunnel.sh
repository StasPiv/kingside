#!/bin/bash
LOCAL_PORT=${1:-9876}
REMOTE_PORT=${2:-9877}
echo "Туннель: kamatera-chess:${REMOTE_PORT} -> localhost:${LOCAL_PORT}"
exec ssh -N -R "${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" kamatera-chess \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes
