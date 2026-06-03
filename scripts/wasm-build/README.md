# scripts/wasm-build — WASM-сборка stockfish-trace

KS-3653 / ADR-107 rev 2.

## Назначение

Сборка WASM-бинарника нашего ответвления Stockfish 16 (`stockfish-trace`)
для распространения на фронте. Текущий каталог содержит:

- `Dockerfile` — образ с emsdk 3.1.55, инструментами `wabt` и `binaryen`.
- `build.sh` — точка входа: монтирует исходники, запускает `emmake make`,
  складывает `stockfish-trace.{wasm,js}` в `out/`, прогоняет smoke.
- `smoke.js` — Node-проверка `uci` → `eval json` на собранном бинарнике.
- `out/` — артефакты сборки (создаётся при первом запуске, добавлен в
  `.gitignore` отдельно).

## Зависимости

- Docker (на хосте, не в контейнере агента — образ собирается локально).
- Исходники stockfish-trace с применённым патчем C1a (KS-3648, backend).
  Ожидаемый путь по умолчанию: `/tmp/stockfish-trace`.

## Сборка

```bash
# 1. Получить патч от backend (KS-3648). Предположим: /tmp/stockfish-trace.
# 2. Сборка + smoke:
scripts/wasm-build/build.sh /tmp/stockfish-trace

# Артефакты:
#   scripts/wasm-build/out/stockfish-trace.wasm
#   scripts/wasm-build/out/stockfish-trace.js
```

## Параметры emcc

Базируются на `lichess-org/stockfish.wasm` (см. `Readme.upstream.md` в их
репозитории). Ключевые опции в Makefile нашего fork'а ожидаются такими:

```
EMFLAGS += -s MODULARIZE=1 -s EXPORT_NAME="StockfishTrace"
EMFLAGS += -s ENVIRONMENT=web,worker,node
EMFLAGS += -s EXIT_RUNTIME=0 -s ALLOW_MEMORY_GROWTH=1
EMFLAGS += -s INITIAL_MEMORY=71303168 -s MAXIMUM_MEMORY=2147483648
EMFLAGS += -s FILESYSTEM=0 -s STRICT=1 -s ASSERTIONS=0
EMFLAGS += -Oz -flto --closure 1
```

Threading: single-thread (без `USE_PTHREADS=1`). Stockfish-eval синхронный,
multi-thread даёт прирост только при поиске; для trace-вывода достаточно
одного worker'а.

Конкретный набор флагов утвердит backend в патче C1a.

## Acceptance

- `stockfish-trace.wasm` < 5 МБ.
- `smoke.js` проходит: `uciok` + валидный JSON на `eval json`.
- 5–10 эталонных FEN: WASM-вывод побитово совпадает с нативным бинарником
  (сверку проводит devops после готовности C1a).

## Передача в `apps/web/public/stockfish/`

`apps/web/public/` — зона frontend. После сборки артефакты передаются им
через `agent_message` со ссылкой на `scripts/wasm-build/out/` (либо
дублируются в `/tmp/wasm-handover/`).
