# Stockfish (WASM) — лицензионная обвязка

В этом каталоге распространяются WebAssembly-сборки шахматного движка
Stockfish, используемые фронтом Kingside на странице разбора партии и
в смежных модулях.

## Состав

| Файл | Что это | Источник |
|---|---|---|
| `stockfish-16-trace.js` / `stockfish-16-trace.wasm` / `stockfish-16-trace.worker.js` | **Наше ответвление Stockfish 16** с расширенной командой `eval json` (выводит подкомпоненты позиционной оценки — pawns, pieces, king, threats, passed, space — с привязкой к квадратам). Используется для извлечения детальной позиционной разбивки на странице разбора партии (KS-3645). Собрано через emscripten 3.1.55 с `Use NNUE = false` (NNUE-сеть выкинута для уменьшения размера), pthread + SharedArrayBuffer обязательны. Подробнее — `scripts/wasm-build/HANDOVER.md`. | Наше ответвление `kingside/stockfish-trace` (см. KS-3653 / ADR-107 rev 2 §6 C1, репозиторий планируется к публикации перед публичным релизом). |
| `stockfish-16-lite.js` / `stockfish-16-lite.wasm` | Stockfish 16 (lite, classical evaluator с возможностью отключить NNUE). Стандартная upstream-сборка. Используется в текущей реализации `positionalEval.ts` для извлечения 13 терминов через `eval`. Будет заменена на `stockfish-16-trace.*` после интеграции (KS-3645). | Стандартная сборка Stockfish 16, ветка `sf_16`. |
| `stockfish-18-lite.js` / `stockfish-18-lite.wasm` | Stockfish 18 (lite, NNUE, multi-thread). Используется для основного анализа позиции в Game Review. | Вышестоящий проект Stockfish, ветка `sf_18`. |
| `stockfish-18-single.js` / `stockfish-18-single.wasm` | Stockfish 18 (single-thread). Используется как запасной вариант для окружений без поддержки SharedArrayBuffer. | Вышестоящий проект Stockfish, ветка `sf_18`. |
| `nn-5af11540bbfe.nnue` | Файл NNUE-весов для Stockfish 18. | Вышестоящий проект Stockfish (релиз SF 18). |

## Лицензия

Все перечисленные бинарники распространяются под **GNU General Public
License версии 3** (GPL-3). Полный текст лицензии — в файле
`STOCKFISH_LICENSE.txt` рядом с бинарниками.

GPL-3 требует, чтобы при распространении бинарника был обеспечен
доступ к исходному коду. Ссылки:

- Вышестоящий проект Stockfish: <https://github.com/official-stockfish/Stockfish>
- Ветка SF 16: <https://github.com/official-stockfish/Stockfish/tree/sf_16>
- Наше ответвление с расширенным trace-выводом
  (в работе по KS-3644 §6 C1): <https://github.com/kingside/stockfish-trace>
  (репозиторий будет публичным; до его создания исходники соответствуют
  стандартной сборке SF 16 без модификаций).

## Модификации

`stockfish-16-trace.*` — собственная модификация SF 16: расширен `Trace::add`
с per-square ёмкостью, добавлена команда `eval json` (выводит JSON с
подкомпонентами по группам Pawns / Pieces / King / Threats / Passed /
Space — с указанием квадрата для каждой подкомпоненты). Сборка через
emscripten 3.1.55 с `NNUE_EMBEDDING_OFF` и `FILESYSTEM=0` (FS не нужен —
обмен идёт через emcc-stdin callback). Патч на Makefile зафиксирован в
`tools/stockfish-trace-patches/0004-wasm-makefile-emcc.patch`.

Исходный код модификации публикуется в репозитории `kingside/stockfish-trace`
(см. KS-3653). До его публичной публикации исходники доступны по запросу.

Остальные бинарники (`stockfish-16-lite.*`, `stockfish-18-lite.*`,
`stockfish-18-single.*`) — стандартные сборки вышестоящего проекта без
наших модификаций.

## Совместимость с остальным кодом приложения

Код приложения Kingside (TypeScript/React) взаимодействует с движком
исключительно через `postMessage` (Worker API). По общепринятой
практике (Lichess, chess.com) такое взаимодействие классифицируется
как aggregate work и не делает остальной код производным от
Stockfish — лицензия GPL-3 распространяется только на сами WASM-сборки
и их исходный код, а не на остальную кодовую базу приложения.
