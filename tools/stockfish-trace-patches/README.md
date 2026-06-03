# stockfish-trace-patches

Патчи Stockfish 16 (KS-3648 / ADR-107 rev 2 §3) для расширения `Trace`
до per-subterm JSON-вывода. Артефакт C1a (backend) → передаётся в C1b
(devops) для WASM-сборки через emscripten.

## База

- Upstream: `https://github.com/official-stockfish/Stockfish`, тег `sf_16`,
  коммит `68e1e9b3811e16cad014b590d7443b9063b3eb52` (релиз 29.06.2023).
- Локальный рабочий каталог: `/tmp/stockfish-trace` (ветка
  `feature/trace-subterms`).
- Сверка номеров строк в комментариях патча — с этим коммитом upstream.

## Файлы

| Файл | Этапы | Описание |
|---|---|---|
| `0001-phase1-3-trace-skeleton-and-pawns.patch` | Phase 1-3 (из 11) | Каркас `Trace::Subterm` + UCI `eval json` skeleton; параметризация `pawns.cpp::evaluate<Tracing,Color>` и `evaluate_shelter<Tracing,Color>`; 11 из 51 точек `SF_TRACE_ADD_SUB` (7 pawn + 4 shelter/storm). |

## Применение

```bash
git clone --branch sf_16 https://github.com/official-stockfish/Stockfish.git
cd Stockfish
git am /path/to/0001-phase1-3-trace-skeleton-and-pawns.patch
# при появлении следующих фаз — git am 0002-…, 0003-…
make -C src build ARCH=x86-64   # native baseline для тестов
# WASM-сборка — задача C1b (devops): нужен fork lichess-org/stockfish.wasm
# + наложение этих патчей поверх + сборка emscripten Makefile.
```

## Статус

- **Phase 1-3 готовы** (этот патч):
  - `enum Eval::Subterm` (51 ID, синхронизован с
    `packages/shared/.../PositionalSubtermId`, KS-3649).
  - `Eval::add_subterm(id, color, score, square)` + макросы
    `SF_TRACE_ADD_SUB(id, c, s, sq)` / `SF_TRACE_ADD_SUB_NS(id, c, s)`
    с `if constexpr (T == Eval::TRACE)` — zero overhead в основном
    поиске.
  - `Eval::trace_json(Position&)` — сериализация в JSON
    `{position, subterms[], total}` (см. ADR §3.4).
  - UCI `eval json` (subcommand `eval`).
  - 11 точек разметки: 7 в pawn-оценке (`pawn_doubled_early`,
    `pawn_connected`, `pawn_doubled`, `pawn_isolated`, `pawn_backward`,
    `pawn_lever_double`, `pawn_blocked`) + 4 в shelter/storm
    (`king_shelter_strength`, `king_blocked_storm`,
    `king_unblocked_storm`, `king_on_file`).
  - `Pawns::trace_for<Color>(pos)` — обходит pawn-кэш для trace-режима,
    вызывается из `Eval::trace_json` перед `Evaluation<TRACE>`.

- **Phase 4-8 не вошли** (следующие коммиты в /tmp/stockfish-trace,
  следующие патч-файлы):
  - `pieces()` — 17 точек: `outpost_knight/bishop`,
    `bishop_pawns`, `bishop_xray_pawns`, `bishop_long_diagonal`,
    `bishop_cornered`, `rook_on_open_file/closed_file`, `rook_trapped`,
    `queen_weak`, `knight_uncontested_outpost`,
    `knight_reachable_outpost`, `minor_behind_pawn`,
    `knight/bishop_king_protector_distance`, `rook_on_king_ring`,
    `bishop_on_king_ring`.
  - `king()` — 8: `king_safety_pawn`, `king_danger`,
    `king_safe_check_{rook,queen,bishop,knight}`, `king_pawnless_flank`,
    `king_flank_attacks`.
  - `threats()` — 10: `threat_by_{minor,rook,king}`, `threat_hanging`,
    `threat_weak_queen_protection`, `threat_restricted_piece`,
    `threat_by_safe_pawn`, `threat_by_pawn_push`,
    `threat_knight_on_queen`, `threat_slider_on_queen`.
  - `passed()` — 4: `passed_rank`, `passed_king_proximity`,
    `passed_path_advance`, `passed_file_edge`.
  - `space()` — 1.

- **Phase 9 (тесты-инварианты)** — 50 эталонных FEN, проверка
  `Σ subterms по группе == агрегат соответствующего из 13 терминов`
  (с принудительным отключением `LazyThreshold1/2`).

## Проверка собранного бинаря

```bash
cd /tmp/stockfish-trace/src
printf "setoption name Use NNUE value false\nposition startpos\neval json\nquit\n" | ./stockfish
```

На startpos: пустой `subterms[]` (пешки в стартовой связаны, но
`pawn_connected` эмитится — см. реальный вывод). На любой нетривиальной
позиции — десятки записей с `id`, `color`, `square`, `value_mg`,
`value_eg`.

## Лицензия

Все правки — производные от Stockfish 16 (GPL-3). Сам репозиторий
forka должен быть публичным под GPL-3, рядом с WASM в раздаче —
`STOCKFISH_LICENSE.txt` со ссылкой на forknik (см. ADR-107 rev 2 §4).
Создание GitHub-репозитория — на пользователе по факту готовности
полного патча.
