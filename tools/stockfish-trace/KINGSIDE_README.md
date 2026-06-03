# Kingside SF-trace fork (KS-3648 / ADR-107 rev 2)

Локальный форк Stockfish 16 с расширением `Trace`-инфраструктуры для
вывода ~63 позиционных подкомпонент в JSON через UCI команду
`eval json`. Используется на фронте Kingside для LLM-комментариев в
разборе партии (`apps/web/src/lib/review/`).

## Что внутри

- `src/` — исходники Stockfish 16 (база — upstream tag `sf_16`, коммит
  `68e1e9b3811e16cad014b590d7443b9063b3eb52`, релиз 29.06.2023) с
  наложенными правками C1a-этапов 1-10.
- `AUTHORS`, `Copying.txt`, `README.md` — оригинальные файлы upstream
  Stockfish (GPL-3, обязательны при распространении).
- `tests/` — оригинальные тесты Stockfish.
- `KINGSIDE_README.md` — этот файл.
- `.gitignore` — исключает сборочные артефакты `*.o`, `stockfish`,
  `*.nnue`.

Полный сводный файл правок от чистого `sf_16`:
`../stockfish-trace-patches/0003-phase1-10-with-psqt-mobility-attackers.patch`.

## Что меняли (C1a, 63 идентификатора Eval::Subterm)

### Каркас (фаза 1)
- `src/evaluate.h`: `enum Eval::Subterm` (63 ID), `enum Eval::Tracing
  { NO_TRACE, TRACE }`, `void Eval::add_subterm(...)`, объявление
  `Eval::trace_json(Position&)`, макросы `SF_TRACE_ADD_SUB(id, c, s,
  sq)` / `SF_TRACE_ADD_SUB_NS(id, c, s)` с `if constexpr (T ==
  Eval::TRACE)` — без накладных расходов в основном поиске.
- `src/evaluate.cpp`: `namespace Trace` расширен на
  `std::vector<SubtermEntry>`, `subterm_id_names[]`, `clear_sub`,
  `subterm_to_json`; новая `Eval::trace_json` форматирует
  `{position: {fen, sideToMove}, subterms: [...], total: {mg, eg, v}}`.
- `src/uci.cpp`: команда `eval json` (subcommand после `eval`);
  старое `eval` без аргумента сохраняет таблицу 13 терминов.

### Pawn-структура и щит короля (фазы 2-3, 11 ID)
- `src/pawns.cpp::evaluate<Color>` параметризовано
  `<Eval::Tracing T, Color>`, 7 точек: `pawn_doubled_early/connected/
  doubled/isolated/backward/lever_double/blocked`.
- `src/pawns.cpp::evaluate_shelter<Color>` параметризовано, 4 точки:
  `king_shelter_strength/blocked_storm/unblocked_storm/on_file`.
- `Pawns::trace_for<Color>(pos)` — wrapper для trace-режима, обходит
  кэш `HashTable`.

### Pieces (фаза 4, 17 ID)
`rook_on_king_ring`, `bishop_on_king_ring`,
`knight_uncontested_outpost`, `outpost_knight/bishop`,
`knight_reachable_outpost`, `minor_behind_pawn`,
`knight/bishop_king_protector_distance`, `bishop_pawns`,
`bishop_xray_pawns`, `bishop_long_diagonal`, `bishop_cornered`,
`rook_on_open_file`, `rook_on_closed_file`, `rook_trapped`,
`queen_weak`.

### King safety (фаза 5, 8 ID)
`king_safety_pawn`, `king_danger`, `king_safe_check_{rook,queen,
bishop,knight}`, `king_pawnless_flank`, `king_flank_attacks`.

### Threats (фаза 6, 10 ID)
`threat_by_{minor,rook,king}`, `threat_hanging`,
`threat_weak_queen_protection`, `threat_restricted_piece`,
`threat_by_safe_pawn`, `threat_by_pawn_push`,
`threat_knight_on_queen`, `threat_slider_on_queen`.

### Passed pawns (фаза 7, 4 ID)
`passed_rank`, `passed_king_proximity`, `passed_path_advance`,
`passed_file_edge`.

### Space (фаза 8, 1 ID)
`space`.

### Расширение (фаза 10, 12 ID)
- **PSQT**: `psqt_pawn/knight/bishop/rook/queen/king` (6) — цикл по
  всей доске в `Eval::trace_json`, эмитит таблицу за каждую фигуру
  на своей клетке.
- **Mobility per-piece**: `mobility_knight/bishop/rook/queen` (4) —
  в цикле `evaluate.cpp::pieces` через `if constexpr (Pt == ...)`.
- **King attackers**: `king_attackers_count`, `king_attackers_weight`
  (2) — в начале `evaluate.cpp::king<Us>` per side.

## Синхронизация имён с `packages/shared`

Все 63 идентификатора синхронизованы с
`packages/shared/src/types/api-contracts.ts::PositionalSubtermId`
(KS-3649). Порядок строк в `subterm_id_names[]` соответствует порядку
enum `Eval::Subterm`. При добавлении новых ID — синхронно обновить
оба места.

## Сборка

Нативный бинарь для разработки и тестов:

```bash
cd src
make build ARCH=x86-64
```

WASM-сборка для фронта (C1b, devops):

```bash
# 1. Клонировать lichess-org/stockfish.wasm (там Makefile.emscripten)
git clone https://github.com/lichess-org/stockfish.wasm.git /tmp/sf-wasm
# 2. Применить наши изменения поверх их src/
cp -r src/* /tmp/sf-wasm/src/
# 3. Собрать через docker emscripten (см. их README)
cd /tmp/sf-wasm && docker-compose run --rm builder
# 4. Положить артефакт в apps/web/public/stockfish/stockfish-16-trace.{js,wasm}
```

## Запуск и пример вывода

```bash
cd src
printf "setoption name Use NNUE value false\nposition fen rnbqkbnr/pp2pppp/2p5/3p4/3P4/2N1P3/PPP2PPP/R1BQKBNR w KQkq - 0 4\neval json\nquit\n" | ./stockfish
```

Возвращает JSON вида:
```json
{
  "position": {"fen": "...", "sideToMove": "w"},
  "subterms": [
    {"id":"pawn_connected","color":"w","square":"d4","value_mg":0.09,"value_eg":0.02},
    {"id":"outpost_knight","color":"b","square":"d5","value_mg":0.16,"value_eg":0.10},
    {"id":"king_safety_pawn","color":"w","square":"e1","value_mg":0.58,"value_eg":-0.07},
    ...
  ],
  "total": {"mg": 0.43, "eg": 0.32, "v": 0.40}
}
```

## Лицензия

Все изменения — производные от Stockfish 16 (**GPL-3**). При
распространении WASM-бинаря пользователям через
`apps/web/public/stockfish/`:

1. Бинарь — производное произведение, под GPL-3.
2. Этот форк (наш `tools/stockfish-trace/`) — производный код, тоже
   GPL-3. **Должен быть публичным**: либо вынести в отдельный
   GitHub-репозиторий `kingside/stockfish-trace`, либо оставить
   доступным как часть основного репо Kingside.
3. Рядом с WASM в раздаче положить `STOCKFISH_LICENSE.txt` (= наш
   `Copying.txt`) и ссылку на форк.

Сам TS/JS-код apps/web и backend Kingside — отдельная программа,
общается с WASM через `postMessage` (aggregate, не combined work).
Прецедент — Lichess и chess.com распространяют `stockfish.wasm` в
проприетарных продуктах по этой схеме.

## Базовый upstream и связанные ADR

- Upstream: https://github.com/official-stockfish/Stockfish, тег `sf_16`.
- ADR: `docs/adr/107-positional-features-without-stockfish-fork.md` (rev 2).
- Задачи: KS-3644 (анализ), KS-3648 (C1a — реализация), KS-3649 (F2 —
  типы), KS-3650 (F1 — фронт-интеграция, ждёт C1b), KS-3651 (B1 —
  prompt), KS-3652 (D1 — лицензионная обвязка).
- Сводный файл правок (для devops C1b):
  `tools/stockfish-trace-patches/0003-phase1-10-with-psqt-mobility-attackers.patch`.
