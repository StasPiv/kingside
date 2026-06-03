# scripts/wasm-build/Dockerfile
# KS-3653 / ADR-107 rev 2 — образ для WASM-сборки нашего fork'а Stockfish.
#
# Используется как одноразовый build-контейнер: исходники монтируются в /src,
# артефакты складываются в /src/out (= scripts/wasm-build/out на хосте).
#
# Запуск:
#   docker build -t kingside-emsdk:3.1.55 -f scripts/wasm-build/Dockerfile scripts/wasm-build
#   ./scripts/wasm-build/build.sh /tmp/stockfish-trace
#
# Версия emsdk: 3.1.55 — совместима с C++17/20, требуемым для современного SF 16.
# lichess-org/stockfish.wasm официально требует em++ ^2.0.13 (для классической
# wasm-сборки), но наш fork в KS-3648 завязан на более свежий toolchain.

FROM emscripten/emsdk:3.1.55

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        make \
        wabt \
        binaryen \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Рабочая директория, сюда монтируются исходники stockfish-trace.
WORKDIR /src

# Sanity check toolchain (на build-этапе, чтобы образ был валидным).
RUN emcc --version && em++ --version
