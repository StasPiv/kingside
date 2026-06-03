#!/bin/bash
# scripts/wasm-build/build.sh
# KS-3653 / ADR-107 rev 2 — сборка stockfish-trace.{wasm,js} через emsdk.
#
# Usage:
#   scripts/wasm-build/build.sh <path-to-stockfish-trace-source>
#
# Аргумент — путь к каталогу с исходниками stockfish-trace (с патчем C1a от
# backend, KS-3648). Должен содержать `src/Makefile` (или его аналог) от
# upstream Stockfish 16 + наш патч.
#
# Артефакты:
#   scripts/wasm-build/out/stockfish-trace.wasm
#   scripts/wasm-build/out/stockfish-trace.js
#
# После успешной сборки скрипт прогоняет smoke-проверку: `uci`,
# `position startpos`, `eval json` через node-обвязку.

set -euo pipefail

SRC="${1:-}"
if [ -z "$SRC" ]; then
    echo "Usage: $0 <path-to-stockfish-trace-source>" >&2
    exit 1
fi
if [ ! -d "$SRC" ]; then
    echo "ERROR: source dir not found: $SRC" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/out"
mkdir -p "$OUT_DIR"

IMAGE="kingside-emsdk:3.1.55"

# Образ собираем при первом запуске (идемпотентно — Docker кэширует).
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[wasm-build] Building emsdk image $IMAGE..."
    docker build -t "$IMAGE" -f "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR"
fi

echo "[wasm-build] Compiling stockfish-trace WASM from $SRC..."

# Запуск make внутри контейнера. ARCH=wasm + наш профиль (см. Makefile.wasm).
# `-Oz` + `--closure 1` + lto для размера, single-thread (без pthread —
# Stockfish-eval синхронный, multi-thread даёт прирост только при поиске).
docker run --rm \
    -v "$SRC":/src \
    -v "$OUT_DIR":/out \
    -e EMSCRIPTEN_TMP=/tmp \
    "$IMAGE" \
    bash -c '
        set -euo pipefail
        cd /src/src
        emmake make -j"$(nproc)" \
            ARCH=wasm \
            COMP=emscripten \
            EXE=stockfish-trace.js \
            build
        cp -v stockfish-trace.js stockfish-trace.wasm /out/
        ls -lh /out/
    '

echo "[wasm-build] Built:"
ls -lh "$OUT_DIR"/stockfish-trace.{wasm,js}

# Размер должен быть < 5 МБ (acceptance из задачи KS-3653).
WASM_SIZE=$(stat -c '%s' "$OUT_DIR/stockfish-trace.wasm")
WASM_SIZE_MB=$(( WASM_SIZE / 1024 / 1024 ))
if [ "$WASM_SIZE_MB" -ge 5 ]; then
    echo "WARN: stockfish-trace.wasm size = ${WASM_SIZE_MB} MB (>= 5 MB target)" >&2
fi

# Smoke: запускаем wasm через node и проверяем uci-handshake + eval json.
echo "[wasm-build] Smoke test..."
node "$SCRIPT_DIR/smoke.js" "$OUT_DIR/stockfish-trace.js"

echo "[wasm-build] Done. Артефакты:"
echo "  $OUT_DIR/stockfish-trace.wasm"
echo "  $OUT_DIR/stockfish-trace.js"
