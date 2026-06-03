# stockfish-trace-patches

Файлы правок Stockfish 16 (KS-3648 / ADR-107 rev 2 §3) для расширения
`Trace` до per-subterm JSON-вывода. Артефакт C1a (backend) → передаётся
в C1b (devops) для сборки WASM через emscripten.

## База

- Upstream: `https://github.com/official-stockfish/Stockfish`, тег `sf_16`,
  коммит `68e1e9b3811e16cad014b590d7443b9063b3eb52` (релиз 29.06.2023).
- Локальный рабочий каталог: `/tmp/stockfish-trace` (ветка
  `feature/trace-subterms`, 3 коммита: Phase 1, Phase 2-3, Phase 4-8).
- Сверка номеров строк в комментариях файла правок — с этим коммитом
  upstream.

## Файлы

| Файл | Этапы | Описание |
|---|---|---|
| `0001-phase1-3-trace-skeleton-and-pawns.patch` | Фазы 1-3 | Промежуточная контрольная точка (только pawns.cpp). Можно пропустить — заменён следующим. |
| `0002-phase1-8-full-coverage.patch` | Фазы 1-8 | 51 ID — полное покрытие именованных классических подкомпонент SF 16. Заменён следующим. |
| `0003-phase1-10-with-psqt-mobility-attackers.patch` | **Фазы 1-10 (последний, для devops)** | 63 ID. Добавлены PSQT per-piece (6), mobility per-piece (4), king_attackers count/weight (2). Этот файл правок передаётся в C1b. |

## Применение

```bash
git clone --branch sf_16 https://github.com/official-stockfish/Stockfish.git
cd Stockfish
git am /path/to/0003-phase1-10-with-psqt-mobility-attackers.patch
make -C src build ARCH=x86-64   # нативная сборка для тестов
# WASM-сборка — задача C1b (devops): форк lichess-org/stockfish.wasm
# + наложение этого файла правок поверх + сборка emscripten Makefile.
```

## Статус: Фазы 1-8 готовы (51/51 подкомпонент)

### Каркас (фаза 1)
- `enum Eval::Subterm` (51 ID, синхронизован с
  `packages/shared/.../PositionalSubtermId`, KS-3649).
- `Eval::add_subterm(id, color, score, square)` + макросы
  `SF_TRACE_ADD_SUB(id, c, s, sq)` / `SF_TRACE_ADD_SUB_NS(id, c, s)`
  с `if constexpr (T == Eval::TRACE)` — без накладных расходов в
  основном поиске.
- `Eval::trace_json(Position&)` — JSON-структура
  `{position: {fen, sideToMove}, subterms: [...], total: {mg, eg, v}}`
  по ADR §3.4.
- UCI команда `eval json` (subcommand после `eval`).

### Pawns (фазы 2-3)
- `pawns.cpp::evaluate<Color>` параметризовано
  `<Eval::Tracing T, Color>`. 7 точек:
  `pawn_doubled_early`, `pawn_connected`, `pawn_doubled`,
  `pawn_isolated`, `pawn_backward`, `pawn_lever_double`, `pawn_blocked`.
- `pawns.cpp::evaluate_shelter<Color>` параметризовано. 4 точки:
  `king_shelter_strength`, `king_blocked_storm`,
  `king_unblocked_storm`, `king_on_file`.
- `Pawns::trace_for<Color>(pos)` — wrapper для trace-режима
  (обходит pawn-кэш `HashTable`).

### Pieces (фаза 4)
17 точек в цикле `evaluate.cpp::pieces`: `rook_on_king_ring`,
`bishop_on_king_ring`, `knight_uncontested_outpost`,
`outpost_knight/bishop`, `knight_reachable_outpost`,
`minor_behind_pawn`, `knight/bishop_king_protector_distance`,
`bishop_pawns`, `bishop_xray_pawns`, `bishop_long_diagonal`,
`bishop_cornered`, `rook_on_open_file`, `rook_on_closed_file`,
`rook_trapped`, `queen_weak`.

### King (фаза 5)
8 точек в `evaluate.cpp::king`: `king_safety_pawn` (начальный
score из shelter), `king_safe_check_×4` (вклад в `kingDanger`
для rook/queen/bishop/knight, эмитятся как `-make_score(v,v)`),
`king_danger` (итоговый `-(kingDanger²/4096, kingDanger/16)` при
`kingDanger > 100`), `king_pawnless_flank`, `king_flank_attacks`.

### Threats (фаза 6)
10 точек в `evaluate.cpp::threats`: `threat_by_minor/rook` (в loop
per attacked square), `threat_by_king`, `threat_hanging`,
`threat_weak_queen_protection`, `threat_restricted_piece`,
`threat_by_safe_pawn`, `threat_by_pawn_push`,
`threat_knight_on_queen`, `threat_slider_on_queen` (последние два с
привязкой к квадрату вражеского ферзя).

### Passed (фаза 7)
4 точки в `evaluate.cpp::passed` per passed pawn square:
`passed_rank`, `passed_king_proximity`, `passed_path_advance`,
`passed_file_edge`.

### Space (фаза 8)
1 точка: `space` (агрегат, side-обладатель).

### PSQT + mobility + king attackers (фаза 10)

**PSQT (6 точек):** `psqt_pawn / knight / bishop / rook / queen / king`. Эмитятся в `Eval::trace_json` циклом по всей доске — каждая фигура получает запись со своим квадратом и mg/eg-вкладом из таблицы `PSQT::psq[piece][square]`. Знак уже POV владельца (SF в `psqt.cpp::init` инвертирует через `psq[~pc][flip_rank(s)] = -psq[pc][s]`).

**Mobility per-piece (4 точки):** `mobility_knight / bishop / rook / queen`. В цикле `evaluate.cpp::pieces` после `mobility[Us] += MobilityBonus[Pt-2][mob]` через `if constexpr (Pt == ...)` — каждая лёгкая/тяжёлая фигура получает свой вклад с привязкой к квадрату.

**King attackers (2 точки):** `king_attackers_count / weight`. В начале `evaluate.cpp::king<Us>` эмитим один раз per side: `kingAttackersCount/Weight[Them]` = атакующие стороны Them на наш kingRing. Запись с `color=Them` (атакующие их фигур), без квадрата, как `make_score(v, v)` для удобства потребителя (в kingDanger хранится int, а Score нужен в пешечных-cp).

## Не вошло

- **Фаза 9 — инвариант на 50 эталонных FEN**:
  `Σ subterms по группе == агрегат соответствующего из 13 классических
  терминов вышестоящего SF`. Требует FEN'ов от пользователя; делается
  отдельным проходом после получения списка.
- **Фаза 11 (резерв)** — дополнительные подкомпоненты, которые
  технически можно вытащить из SF 16:
  - `material_per_piece_type` (6 ID) — расчёт через `PieceValue[]` +
    `pos.count<Pt>(c)`. Низкая ценность — дублирует FEN.
  - `imbalance_*` (5 ID) — `material.cpp::QuadraticOurs/Theirs` матрица.
    Требует структурных правок `material.cpp`.
  - `winnable_*` (4 ID) — `evaluate.cpp::winnable()`, булевы факторы
    эндшпильной корректировки.
- **C1b (devops) — WASM-сборка** через emscripten на форке
  `lichess-org/stockfish.wasm`.

## Известные особенности

- **SafeCheck-подкомпоненты в king** не попадают напрямую в Score,
  они влияют на финальный score через формулу `score -= make_score(
  kingDanger²/4096, kingDanger/16)`. Для удобства потребителя они
  эмитятся как `-make_score(v, v)` (где `v` — int-вклад в kingDanger).
  Это даёт приближение «вклад в опасность короля» в pawn-cp, но
  строгий инвариант с агрегатом KING нарушается на величину разницы
  между линейной суммой и квадратичной формулой. В Phase 9 это нужно
  будет учесть как отдельную статистику.
- **`LazyThreshold1/2`** (early-skip в `Evaluation<T>::value`) могут
  пропускать threats/space в основном поиске. В trace-режиме SF их
  принудительно НЕ отключает — `Eval::trace_json` вызывает
  `Evaluation<TRACE>(pos).value()` который полностью повторяет
  логику `Eval::evaluate`. Если инвариант фазы 9 покажет
  расхождения — потребуется явно убрать lazy-skip в trace-режиме.
- **Pawn-кэш** обходится через отдельный `Pawns::trace_for<Color>`
  на временном Entry, поэтому pawn-subterms всегда полные.
  `Evaluation<TRACE>` параллельно вызывает обычный
  `Pawns::probe` для агрегата `PAWN` — оба источника согласованы по
  значению.

## Smoke-проверка

На FEN из системы Свешникова
(`r1bqkb1r/pp3ppp/2np1n2/1N2p3/4P3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 7`):

```bash
cd /tmp/stockfish-trace/src
printf "setoption name Use NNUE value false\nposition fen r1bqkb1r/pp3ppp/2np1n2/1N2p3/4P3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 7\neval json\nquit\n" | ./stockfish
```

71 запись, включая ключевые позиционные сигналы Свешникова:
`pawn_backward d6` (отсталая пешка), `knight_reachable_outpost c3`
(конь готов на d5), `bishop_pawns` для обеих сторон,
`threat_slider_on_queen`, `space`, `king_safety_pawn`,
`king_flank_attacks`. `total = +0.10` — совпадает с upstream-SF.

## Лицензия

Все правки — производные от Stockfish 16 (GPL-3). Сам репозиторий
форка должен быть публичным под GPL-3, рядом с WASM в раздаче —
`STOCKFISH_LICENSE.txt` со ссылкой на форк (см. ADR-107 rev 2 §4).
Создание GitHub-репозитория — на пользователе по факту готовности
полного файла правок.
