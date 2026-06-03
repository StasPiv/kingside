# KS-3653 — WASM-сборка stockfish-trace, передача артефактов

Дата: 2026-06-03

## Артефакты

Готовые файлы в `/tmp/wasm-handover/`:

| Файл | Размер | sha256 |
|---|---:|---|
| `stockfish-16-trace.js` | 16 КБ | `991c9dc7758c73a8e3f2f9e9e19ff3f1f395cde69f4561a21ae1ac5632cde7ea` |
| `stockfish-16-trace.wasm` | 476 КБ | `c08a449f231f515ff5b9c1d3ede0930280271a4063bbea434f0fead96dfb0a82` |
| `stockfish-16-trace.worker.js` | 2.8 КБ | `eceec6beec1b6ccb27cb564e6c1c8b73ee2d54f5f10acb73c59d0795cc1ac19c` |

Размер `.wasm` (476 КБ) значительно ниже порога 5 МБ из критериев приёмки.

## Размещение

Все три файла → `apps/web/public/stockfish/` (зона frontend). Файлы должны
лежать рядом — `.js` `import()`-ит `.wasm`/`.worker.js` относительно своего
пути.

## API модуля

emcc-стандартный с `MODULARIZE=1` + `EXPORT_NAME=StockfishTrace`. Не lichess
preamble — то есть `addMessageListener` тут отсутствует.

```js
import StockfishTrace from '/stockfish/stockfish-16-trace.js';

const sf = await StockfishTrace({
  print: (line) => /* stdout-строка от движка */,
  printErr: (line) => /* stderr-строка */,
  stdin: () => /* вернуть код символа очередной UCI-команды, или null */,
  locateFile: (name) => `/stockfish/${name}`,
});
```

UCI-команды:

```
setoption name Use NNUE value false
position fen <FEN>
eval json
quit
```

`Use NNUE = false` обязателен: модуль собран с `NNUE_EMBEDDING_OFF`, NNUE-сети
внутри нет, и при `Use NNUE = true` движок будет искать `nn-*.nnue` в FS —
а FS у нас отключён (`FILESYSTEM=0`).

## HTTP-заголовки для браузера

WASM собран с `-pthread`, использует SharedArrayBuffer + pthread-worker.
Для корректной работы в браузере **обязательны** заголовки на верхнеуровневом
ответе:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

И на файлах `.js` / `.wasm` / `.worker.js`:

```
Cross-Origin-Embedder-Policy: require-corp
```

Без этих заголовков `SharedArrayBuffer` будет недоступен и модуль не
инициализируется.

## Эталоны для сверки

`/tmp/wasm-handover/baseline/` — 6 файлов (`startpos.json`, `pos-01.json` …
`pos-05.json`). Это JSON-вывод `eval json` от нативного бинарника
(`/tmp/stockfish-trace/src/stockfish`, ARCH=x86-64), собранного из того же
дерева, что и WASM. Frontend сверяет `subterms` поэлементно по
`id` + `color` + `square` (точное совпадение) и `value_mg` / `value_eg`
(допуск 1e-3 — на случай минимальных отклонений em++ от нативного).

Все 6 эталонов прошли формальную проверку JSON. Пример:
`pos-01.json` → 114 subterms, `total = {mg: 0.79, eg: 1.29, v: 0.78}`.

## Что важно знать про smoke в Node

Прямой smoke через `node` не выполнен: модуль собран с `-pthread`,
которому в Node нужны worker_threads, плюс `FILESYSTEM=0` ломает
стандартный stdin/stdout pipe. Это ожидаемо — артефакт целевой для
браузерной среды с SharedArrayBuffer. Загрузка проходит (баннер
`Stockfish 16 by ...` доходит до stdout), но UCI-цикл не получает
команд через emcc-stdin callback.

Проверочный запуск делает frontend в реальном браузерном окружении.

## Сборка (воспроизводимость)

Изменения в Makefile зафиксированы как
`tools/stockfish-trace-patches/0004-wasm-makefile-emcc.patch`. Сборка:

```bash
# emsdk (без sudo, локально):
git clone --depth 1 https://github.com/emscripten-core/emsdk.git /tmp/emsdk
cd /tmp/emsdk && ./emsdk install 3.1.55 && ./emsdk activate 3.1.55
source /tmp/emsdk/emsdk_env.sh

# Применить патч на src/ нашего форка SF16 + правки backend (Phase 1-10):
cd /tmp/stockfish-trace
git apply /project/tools/stockfish-trace-patches/0004-wasm-makefile-emcc.patch

# Сборка:
cd src
make clean
emmake make -j2 ARCH=wasm build
```

Результат — `stockfish-16-trace.{js,wasm,worker.js}` в `src/`.
