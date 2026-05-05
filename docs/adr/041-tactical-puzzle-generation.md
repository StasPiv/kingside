# ADR-041: Автогенерация тактических задач из партий (Puzzle Generation)

**Дата:** 2026-05-05 (правка 2026-05-05: §2 пороги переведены с cp на winning chances; см. §2.0)
**Статус:** Предложено
**Задача:** KS-2430
**Связанные:**
- KS-1408 (предыдущий research, source-of-truth по lichess-puzzler) — план был принят, но кода в репо не осталось; MVP начинается заново, опираясь на тот же подход, но с уже готовой схемой `Puzzle`.
- [ADR-042 tactic-worker extraction](./042-tactic-worker-extraction.md) — генератор живёт **в `apps/tactic-worker`**, не в `apps/api`. Этот ADR (041) изначально описывал `apps/api/src/puzzle-generator/...`; ADR-042 (KS-2432) перенёс место запуска. Где этот ADR пишет «генератор / pipeline», читать как «команда tactic-worker'а».
- [ADR-035 Tactical pattern drills](./035-tactical-pattern-drills.md) — drill ≠ puzzle, см. §7.
- [ADR-013 game archive and tree](./013-game-archive-and-tree.md), [ADR-014 archive-games-by-position](./014-archive-games-by-position.md), [ADR-027 archive RDS sizing](./027-archive-rds-sizing.md), [ADR-033 archive database interface](./033-archive-database-interface.md) — `archive_games` как источник партий.
- [ADR-019/020 archive importer + EventBridge](./019-archive-importer-merge-into-service.md) — прецедент batch-job на ECS с расписанием.
- KS-2406, KS-2408, KS-2419 — safety/overlap правила в drill predicates, переиспользуем для тегирования (§3).

---

## 1. Контекст и scope

### 1.1 Что есть

| Компонент | Где | Что даёт |
|---|---|---|
| `Puzzle` модель | `packages/db/prisma/schema.prisma:263` | Уже различает Lichess и generated через `source` (`'lichess' \| 'generated'`); поля `sourceType` / `sourceId` / `sourceMoveNum` / `gap` / `depth` / `createdBy` / `isPublic` / `acceptedMoves` / `sourceMetadata` пустуют для Lichess и заполняются для генерации. Glicko-rating через `puzzle-rating.service.ts` уже работает на оба источника. UI-flow `/puzzles` и Puzzle Rush обрабатывают оба source'а (см. `validatePlayerSide` в `puzzle.service.ts:526` — для generated player играет первым ходом). |
| `ArchiveGame` | `packages/archive-db/prisma/schema.prisma:56` | TWIC + (потенциально) импортированные партии пользователей; поля `pgn`, `whiteElo`, `blackElo`, `timeControlCategory`, `playedAt`, `plyCount`. Индексы `(playedAt DESC, id DESC)` и `(timeControlCategory, playedAt DESC, id DESC)` — удобно для cursor-batch. |
| `StockfishService` | `apps/api/src/engine/stockfish.service.ts` | Pool `STOCKFISH_POOL_SIZE`, метод `analyzeMultiPV(fen, depth, mpv)` (строки 340–408 файла). Готов к использованию. |
| `indexer-pipeline.ts` + `tactic-drill-incremental.scheduler.ts` | `apps/api/src/tactic-drill/` | Паттерн «cursor в Redis + читаем archive-db pg-клиентом + пишем в основную БД + идемпотентность через UNIQUE». 1:1 переносится на puzzle-generator. |
| Drill predicates | `apps/api/src/tactic-drill/predicates/` | `find-fork`, `find-pin`, `find-hanging-piece`, `find-loose-piece`, `find-undefended-attack`, `find-all-checks`, `count-attackers`. Используем для авто-тегирования (§3). |
| ECS RunTask без env override | KS-2410 / KS-2411 | Инфра-долг закрыт: batch-таск можно запускать как `archive-importer`. |

### 1.2 Чего нет

- Кода puzzle-generator'а в репо нет (комментарий KS-1408 от 2026-04-13 описывает реализацию, но в `apps/api/src/puzzle/` файлов `puzzle-generator*` нет, в схеме нет модели `GeneratedPuzzle` отдельно — есть только nullable-поля в `Puzzle`).
- Нет cursor / scheduler / RunTask-сценария для batch-генерации.
- Нет UNIQUE по `(fen, source)` или хеша FEN — без него повторы из разных партий гарантированно возникнут (TWIC содержит много партий с одинаковым началом).
- Нет UI-режима «свежие задачи из партий».

### 1.3 Scope ADR

Только дизайн. Без миграций, кода, компонентов. Тикеты на этапы — в §6.

---

## 2. Алгоритм детекции

База — `lichess-puzzler` (см. KS-1408). Здесь — параметры с явным обоснованием и опорой на свойства `archive_games`.

### 2.0 Шкала оценки: winning chances, не cp

**Все пороги в этом разделе (и в §5) выражены не в cp, а в `winning chances` (WC) — той же шкале, что использует lichess-puzzler.** Это уточнение по итогам code-review реализации в `apps/tactic-worker/src/puzzle-generator/`: ранее ADR фиксировал чистые cp-пороги, но в позициях с уже большим перевесом cp-разности нелинейны относительно «реального» влияния хода — а именно это влияние и является признаком тренировочной ценности.

**Формула** (как у lichess):
```
WC(cp) = 2 / (1 + exp(−0.00368208 × cp)) − 1
```
Диапазон: `[−1, +1]`, где `0` — равно, `+1` — выиграно стороной на ходу, `−1` — проиграно.

**Матовые оценки** не конвертируются через cp:
- мат за сторону на ходу: `WC = +1`;
- мат против стороны на ходу: `WC = −1`;
- разность `|ΔWC|` корректно работает на смешанных «cp ↔ mate» парах без условных «1000 + matedist» костылей.

**Свойства, которые мы получаем:**
- мелкие cp-разности около равенства (положение около 0) усиливаются (≈ ±200 cp ↔ ±0.35 ΔWC);
- большие cp-разности в уже выигранной позиции игнорируются (`+900 → +700` ↔ `~0.96 → ~0.92`, `ΔWC ≈ 0.04` — не блýндер);
- ход, переводящий равенство в проигранное (`+20 → −180`), даёт `ΔWC ≈ 0.40` — фиксируется как блýндер.

Все cp-пороги ниже даны в скобках для справки (≈ cp около оценки 0), но реализация должна сравнивать именно `ΔWC`.

### 2.1 Stockfish-параметры

| Параметр | Значение | Почему |
|---|---|---|
| Глубина основного анализа | 18 | KS-1408 экспертный минимум; +2 относительно текущих drill-индексеров (drill только проверяют форму, тут нужна оценка). |
| Глубина при построении линии | 20 | Каждый ход вглубь линии — выше шанс «случайного» лучшего хода; компенсируем глубиной. |
| MultiPV | 3 | Нужны лучший / второй / третий ход для уникальности (spread между 1 и 2). Третий — для редких случаев «два равно-плохих ответа». |
| Movetime fallback | 2000 ms | Если depth не достигнут (сложная позиция / ограниченное CPU) — soft cap, чтобы не зависнуть. |

Сразу после получения cp/mate из Stockfish — конвертация в WC по формуле §2.0; дальнейшие сравнения идут в WC.

### 2.2 Критерии «здесь есть тактика»

Двухэтапная проверка по позиции после хода, который анализируем. На каждом ходу партии (start ≥ ply 20). Все разности — в WC-шкале (§2.0).

1. **Blunder detection** на сделанном ходе:
   - `evalDropWC = |WC(bestScore) − WC(madeMoveScore)|`, **с учётом стороны на ходу** (WC всегда считается «глазами стороны, которая ходит» — поэтому пара берётся из одного и того же расчёта, без знаковых ловушек).
   - Принять, если `evalDropWC ≥ 0.30` (≈ 170 cp около оценки 0). Иначе — не пропуск тактики, идём дальше.
   - Точное числовое значение порога — ориентир из lichess-puzzler; финальную калибровку делаем в §5.2 на sample-тесте chess-expert'а. Если в актуальном `cook.py` lichess закреплено иное число (документировано в коде их репо) — реализация берёт именно его и фиксирует в ADR через короткий апдейт §2.

2. **Uniqueness** в позиции «после blunder» (это и будет начальная позиция puzzle):
   - `spreadWC = |WC(bestScore) − WC(secondScore)|` в MultiPV-результате стороны на ходу.
   - Принять, если `spreadWC ≥ 0.14` (≈ 75 cp около оценки 0). Иначе несколько хороших ходов — обычная позиция, не тренировочный puzzle.

3. **Длина форсированной линии** — построение, см. §2.4. Принять только если результирующая линия имеет 2 ≤ длина ≤ 6 полуходов.

### 2.3 Фильтры партии (применяются до анализа)

| Фильтр | Порог | Источник поля | Комментарий |
|---|---|---|---|
| Тип контроля | `timeControlCategory ∈ {blitz, rapid, classical}` (не bullet, не unknown) | `archive_games.time_control_category` | Bullet содержит много шумовых blunder'ов; unknown — без гарантии. |
| Рейтинг обоих игроков | `whiteElo ≥ 1400 AND blackElo ≥ 1400` | `archive_games.white_elo / black_elo` | Жёстче KS-1408 (≥ 1200) — повышаем планку, у нас задачи для 1200–2000 пользователей. Если данных нет (`null`) — допускаем (TWIC обычно содержит titled players без явного Elo). |
| Длина партии | `plyCount ≥ 20` | `archive_games.ply_count` | Стартовая позиция puzzle берётся с ply 20 минимум (= 10 полных ходов). |
| Категория | `category ≠ 'bot'` (если поле проставляется), и `isClassical` не строго требуется (но стартуем с classical-партий — большая глубина расчёта, более чистые тактики) | `archive_games.category / is_classical` | MVP: только classical/rapid; blitz добавим после калибровки шума. |
| Не из дебюта | `ply ≥ 20` для начала puzzle | вычисляется при ходьбе по партии | KS-1408 минимум 10 полных ходов — оставляем. |

### 2.4 Построение форсированной линии

После того как позиция прошла проверки 2.2.1 и 2.2.2 — это **позиция после blunder**, ход за стороной, у которой был лучший ответ. Линия строится итеративно. Все сравнения — в WC (§2.0).

- На каждом шаге `i` (нечётный i = ход «решающего» — нашего, чётный = ответ соперника):
  1. Stockfish MultiPV=2 на текущей позиции, depth=20.
  2. Если `i` — наш ход: применить `bestMove`, требовать `spreadWC ≥ 0.14` между лучшим и вторым (иначе строго не уникально → стоп, обрезаем линию). Сравнение в WC стороны на ходу.
  3. Если `i` — ход соперника: если у соперника **только один** легальный ход — применить его (форсированно). Иначе MultiPV: применяем «защищающий» лучший ход; принимаем только если все его легальные ходы дают одинаковую (или близкую, `|ΔWC| ≤ 0.05`) итоговую оценку — тогда любая защита проигрывает одинаково. Иначе — стоп.
- Стоп-условия:
  - длина ≥ 6 полуходов;
  - чек-мат на доске (конец линии);
  - нарушение uniqueness;
  - повтор позиции (защита от циклов).

`acceptedMoves` (`Puzzle.acceptedMoves`) пишется при наличии нескольких equally-good защит соперника — фронт уже умеет принимать любой из них, см. KS-2300+ работа над `accepted_moves`.

### 2.5 Отсев тривиальных puzzle'ов

- **Рекапчер на старте**: если первый ход линии — взятие на той же клетке, где было предыдущее взятие в партии (т.е. простой recapture после торгов), и `spreadWC ≥ 0.14` даёт это «бесплатно» — drop. Реализация: смотрим `madeMove.captured` в партии и сравниваем целевую клетку.
- **Мат в 1 на первом ходу с большим выбором** (≥3 матующих хода) — drop, нет тренировочной ценности. Мат-в-1 как единственный решение — допустим, тег `mateIn1`.
- **Линия чистого размена** (последовательность взятий на одной клетке, eval сходится) — drop.

---

## 3. Стек / pipeline

### 3.1 Где запускается

**Решение:** subcommand `generate-puzzles` в `apps/tactic-worker` (см. ADR-042). ECS RunTask на task-def `kingside-tactic-worker`, Fargate Spot.

Обоснование:
- Stockfish MultiPV depth 18 — CPU-heavy, ~50–60 сек на партию. Внутри `apps/api` (0.5 vCPU, REST + WS) задушит event loop.
- `tactic-worker` уже содержит `StockfishService` (через `@kingside/stockfish`), drill-предикаты для tagging'а (§4.1а) и pattern «cursor + pg.Client + Prisma» — нужен только новый CLI-subcommand с pipeline'ом генерации.
- Spot-инстансы дешевле, генерация не имеет SLA.

Альтернативы «cron в `apps/api`» и «отдельный mono-purpose сервис только под puzzle-gen» рассмотрены и отклонены: первая нагружает api Stockfish'ем, вторая дублирует инфру (Dockerfile, IAM, Secrets), которую `tactic-worker` уже несёт для drill-индексера.

### 3.2 Расписание

- **MVP:** ручной запуск через `aws ecs run-task` на task-def `kingside-tactic-worker` с `containerOverrides.command = ["node", "dist/main.js", "generate-puzzles", "--max-games", "N"]`. Запуск девопсом для калибровки.
- **После калибровки:** EventBridge → ECS RunTask раз в сутки (например 02:00 UTC), batch 500 партий, cursor в Redis (key `puzzle-generator:incremental:cursor`).

### 3.3 Concurrency

- 1 task = `STOCKFISH_POOL_SIZE` параллельных Stockfish (default 5). На партии последовательно (35 позиций × ≥1.5 сек / 5 параллели → ~10–15 сек/партия).
- Несколько tasks одновременно — нет (cursor-based, race на cursor решается lock'ом в Redis по `SET … NX EX`).

### 3.4 Бюджет CPU

| Объём | Время на 1 vCPU | На 4 vCPU (1 task pool=5) |
|---|---|---|
| 100 партий | ~100 мин | ~25 мин |
| 1000 партий | ~17 ч | ~4 ч |
| 10000 партий | ~7 суток | ~40 ч |

→ MVP реалистичен, full-archive sweep — недели одного instance, но и не нужен сразу: мы калибруем на 1000 партиях, выбираем threshold'ы, потом гоним incremental по новым TWIC-импортам.

### 3.5 Хранение

**Решение:** не плодить новую таблицу. Использовать существующий `Puzzle` с `source='generated'`. Все нужные поля уже есть.

Что обязательно проставляем при генерации:
- `id`: UUID;
- `fen`, `moves` (UCI через пробел, без setup-move);
- `source = 'generated'`;
- `sourceType = 'archive_game'` (на будущее: `'user_game'`);
- `sourceId = archive_games.id`;
- `sourceMoveNum`: ply, с которого взята позиция;
- `gap`: `spread` в cp (для UI «насколько чисто решение»; считается как `cp(bestScore) − cp(secondScore)` стороны на ходу — это совместимо с существующим UI и сохранением Lichess-puzzle gaps. **WC-проверки уже сделаны раньше**, gap здесь только для отображения / UX-фильтрации, не для решения «принять / drop»);
- `depth`: 18 / 20 (что использовали);
- `themes`: см. §3.7 (через пробел);
- `rating`: начальное по §3.6;
- `ratingDev`: 350 (стандартный default — Glicko ещё не уверен);
- `isPublic`: `true` для MVP. Если потом введём ручную модерацию — выставлять `false` до approve.
- `sourceMetadata` (JSON): `{ "evalDropWC": …, "evalDropCp": …, "spreadWC": …, "lineLength": …, "engine": "stockfish-XX", "engineVersion": "…", "generatedAt": "…" }`. WC-значения — основные (по ним принималось решение); cp — справочно для отладки и для совместимости с инструментами анализа.

### 3.6 Начальный рейтинг

```
avgPlayerRating = round(avg(whiteElo, blackElo, default 1500))
lengthAdj = (lineLength − 4) × 100        // 2 ходов = −200, 6 ходов = +200
gapAdj = spreadWC > 0.55 ? −100 : spreadWC < 0.27 ? +100 : 0
rating = clamp(600, 2800, avgPlayerRating + lengthAdj + gapAdj)
```

Формула из KS-1408 с заменой cp-порогов на WC (старые `gap > 400 / < 200` соответствовали ≈ `WC > 0.55 / < 0.27`). Glicko на attempts далее скорректирует.

### 3.7 Дедупликация и идемпотентность

**Проблема:** один и тот же FEN встречается во многих TWIC-партиях (любая популярная теория). Без UNIQUE — за 1000 партий получим тысячи дублей.

**Решение:**
1. Миграция: `CREATE UNIQUE INDEX puzzles_fen_source_unique ON puzzles(fen, source) WHERE source = 'generated'` (partial unique — Lichess-данные мы не трогаем, у них могут быть дубли по импортной логике).
2. Insert через `ON CONFLICT (fen, source) DO NOTHING`. При conflict — обновляем счётчик `gamesProcessed`, drill не переиндексируем.
3. На уровне индексера — Bloom-filter на FEN'ах текущего batch'а (memory-only, чтобы не делать тысячи `SELECT 1` по DB).

---

## 4. Классификация по тегам

### 4.1 Источники тегов

**(а) Drill predicates как точный источник** (новое после KS-2406/2408/2419 — сейчас они strict с safety- и overlap-фильтрами):

После генерации puzzle берём **позицию начала линии** (тот FEN, что хранится) и **первый ход линии**. Прогоняем через predicate:

| Drill predicate | Какой тег ставится | Условие |
|---|---|---|
| `findFork(fen)` valid + answer == первому ходу линии | `fork` | Позиция содержит ровно одну fork-creating move, и она же — наше решение. |
| `findUndefendedAttack(fen)` valid + answer == первому ходу | `hangingPiece` (или `hanging-creation`) | Аналогично. |
| `findHangingPiece(fen)` valid + answer == первому ходу (move-shape) | `hanging` | Готовая висящая фигура, решение — взять. |
| `findPin(fen)` valid + первый ход = ход той связанной фигуры | `pin` | После хода связки соперник теряет анкер. |

Strict-uniqueness predicate'ов даёт **нулевой false-positive**: тег `fork` появляется, только если в позиции действительно ровно одна вилка (это и есть решение). Это сильнее, чем в lichess-puzzler, где теги ставятся эвристически.

**(б) Алгоритмические теги** (по решению, без drill predicate):

| Тег | Алгоритм |
|---|---|
| `mateIn1` / `mateIn2` / `mateInN` | Длина линии до checkmate (на последнем полуходе `chess.isCheckmate()`). |
| `discoveredAttack` | После первого хода нашей фигуры — другая наша фигура атакует ценную цель противника, причём раньше эта линия атаки была заблокирована ушедшим. Реализация: snapshot all-attacks before/after, ищем new attack от не-двинувшейся фигуры. |
| `skewer` | Аналог pin'а, но впереди по линии — более ценная фигура, а сзади — менее ценная (зеркало pin). После хода первая уходит → бьём вторую. |
| `sacrifice` | Если в первом ходе нашей фигуры её SEE < 0 (отдаём материал), а итоговая оценка линии — мат или большой плюс. |
| `endgame` | ≤ 7 фигур на доске (стандарт). |
| `crushing` / `mate` / `advantage` | Буквенный тег по итоговой оценке (mate ⇒ `mate`, ≥ +500cp ⇒ `crushing`, ≥ +200cp ⇒ `advantage`). |

**(в) Фигура-исполнитель**: тег по типу первой нашей фигуры (`knightMove`, `bishopMove`, …) — для фильтрации в UI.

### 4.2 Хранение

Теги — пробел-разделённая строка в `Puzzle.themes` (формат уже есть, drill-теги совместимы).

---

## 5. Качество

### 5.1 Численные критерии (применяются автоматически)

- `evalDropWC ≥ 0.30` (есть тактика).
- `spreadWC ≥ 0.14` на ходе решения и на каждом нашем последующем ходе.
- `2 ≤ lineLength ≤ 6`.
- Первый ход — не recapture-без-тактики (см. §2.5).
- Не первый ход — не очевидный мат-в-1 при ≥3 матующих кандидатах.

Точные числовые значения порогов WC выверяем по реализации в lichess-puzzler (`cook.py`) и при необходимости корректируем sample-test'ом chess-expert'а (§5.2).

### 5.2 Sample-test через chess-expert

После первого batch'а 100 партий (~ожидаемо 50–150 сгенерированных puzzle'ов):
1. Architect / coordinator передают chess-expert'у сэмпл (например 20 случайных + 5 с самым низким spread + 5 с самым большим evalDrop).
2. Chess-expert по каждому: «учебный / проходной / drop». Цель — оценить % шумных позиций.
3. Если шум > 10% — корректируем threshold'ы (главным образом `spread` и `evalDrop`).

### 5.3 Постмодерация

- `isPublic=false` для всех первых N puzzle'ов до явной модерации (опц. ручная или авто-через-attempts: после 10 attempts с accuracy ≥ 30% → `isPublic=true`).
- Подтверждённый шум (accuracy < 5% за 50 attempts) → `isPublic=false` обратно.

В MVP: `isPublic=true` сразу, без модерации; sample-test закрывает риск.

### 5.4 Что считается «хорошим» puzzle'ом (рамка)

| Признак | Хороший | Плохой |
|---|---|---|
| Длина | 3–5 полуходов | 2 (тривиально), 6 (нудно для рейтинга 1200) |
| Spread (WC) | 0.30–0.80 | < 0.14 (несколько решений), > 0.85 (очевидно) |
| Тег | хотя бы один из drill-предикатов / mate / sacrifice | пусто (не классифицировано — повод проверить) |
| Стартовый ход | взятие, шах, тихий тактический ход | recapture, тривиальное защитное движение |

---

## 6. Этапы внедрения / план тикетов

MVP — три этапа. Каждый — отдельный тикет, тегается координатором соответствующему агенту.

### Этап 1: Batch-генератор (без UI)

- **[backend] CLI-subcommand `generate-puzzles` в `apps/tactic-worker`** + модуль `apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts` по образцу `drill-indexer/indexer-pipeline.ts`. Параметры: `--max-games`, `--cursor`, `--depth`, `--min-rating`. Выходом — `Puzzle`-записи (`source='generated'`). Зависимости: `StockfishService` из `@kingside/stockfish`, archive-БД через `pg.Client`. Не пишет ничего на UI. **Зависит от ADR-042 / KS-2432 (`tactic-worker` поднят)**.
- **[backend] Predicate-tagging adapter** — модуль `apps/tactic-worker/src/puzzle-generator/tagging.ts`, импортирует predicate'ы из `apps/tactic-worker/src/predicates/` и расставляет теги (§4.1а). Алгоритмические теги (§4.1б) — отдельный модуль того же тикета.
- **[backend] Миграция Prisma** — partial UNIQUE `(fen, source)` где `source='generated'` (§3.7), **в `apps/api/prisma/migrations/`** (Prisma-история централизована в api по конвенции монорепо). Совместимость с существующими Lichess-данными проверить (сделать миграцию idempotent, т.е. безопасной к повторному запуску).
- **[chess-expert] Sample-test** — после первого batch'а 100 партий: 30 puzzle'ов на проверку, отчёт с %шума и предложением корректировки threshold'ов (§5.2). Зависит от backend (генератор работает на dev DB или одноразово в prod).
- **[qa] Smoke-тест** — запуск скрипта на 10 dev-партиях, проверка структуры Puzzle-записей, тегов, отсутствия дублей FEN. Зависит от backend (миграция и скрипт готовы).

### Этап 2: Хранение + интеграция в Puzzle Rush + автозапуск

- **[devops] EventBridge schedule** на task-def `kingside-tactic-worker` (уже зарегистрирован в KS-2432), command `["generate-puzzles","--max-games","500"]`, расписание `cron(0 2 * * ? *)` UTC. Cursor-key в Redis (`puzzle-generator:incremental:cursor`). Зависит от backend этапа 1 + ADR-042.
- **[backend] Включить generated-puzzles в выдачу Puzzle Rush**: проверить, что сейчас Rush отдаёт только Lichess (или уже всё подряд) — если фильтрует, добавить флаг «включать generated», по умолчанию ON. Зависит от этапа 1 (записи существуют).
- **[frontend] Категория «Свежие задачи из партий»** на странице `/puzzles`: фильтр по `source='generated'`, опционально по теме. Опциональный для MVP — Puzzle Rush уже даст пользу. Зависит от backend.
- **[qa] Регресс-тест Puzzle Rush** — что добавление generated-puzzles не ломает существующий flow; пользовательский side определяется правильно (см. `validatePlayerSide:526` для generated — стартует с side-to-move в FEN, а не после setup-move как Lichess).

### Этап 3 (после калибровки и решения юридики): персональная генерация

- **[backend] Endpoint `POST /api/puzzles/generated/from-my-game/:gameId`** — пользователь явно запрашивает генерацию из своей партии (если такая есть в `archive_games` с привязкой к user_id).
- **[backend] Очередь user-on-demand отдельно** от batch (Redis stream, чтобы пользователь видел прогресс).
- **[frontend] UI в архиве «Сделать задачи из этой партии»**.
- **[chess-expert] Калибровка под пользовательские партии** — у любителей шум выше, threshold'ы могут меняться (`spread ≥ 200cp`, `min-rating` снять).

Этап 3 — после явного зелёного света по юридике и качеству batch'а.

---

## 7. Связь с drill-системой (ADR-035)

Drill и puzzle в Kingside — два дополняющих, не пересекающихся режима:

| | Drill (ADR-035) | Puzzle (ADR-041 + текущая Lichess-выдача) |
|---|---|---|
| Что тренирует | Зрение / распознавание паттерна за 1–2 секунды | Расчёт форсированного варианта на 2–6 полуходов |
| Длительность одной задачи | 5–15 секунд | 30–120 секунд |
| Ход на доске | Не делается (либо 1 клик, либо 1 ход) | Игрок проходит несколько полуходов подряд |
| Strict-uniqueness | Один ответ-паттерн на FEN | Уникальный лучший ход на каждом ходу линии |
| Где генерируется | `tactic-drill/indexer-pipeline.ts` | `puzzle-generator/generator-pipeline.ts` (этап 1) |
| Источник данных | `archive_games` (поиск чистого паттерна) | `archive_games` (поиск blunder'а) |
| Рейтинг | per-type, без Glicko | Glicko-2 как сейчас |

Точки переиспользования:
- Drill predicates → теги в puzzle (§4.1а) — drill-движок становится вторичным потребителем, не дублируется.
- Pipeline-паттерн «cursor + pg.Client + idempotent insert» — общий, но сами скрипты разные (предметные алгоритмы разные).

Не пересекаются:
- Один FEN может **появиться и в drill, и в puzzle** — это нормально. В drill его покажут с вопросом «найди связку», в puzzle — с вопросом «реши линию». Контексты UX не путаются (разные страницы).
- В Puzzle Rush drill'ов нет (это уже выяснено в ADR-035 §1.2). Drill-сессии (sprint) и Puzzle Rush — отдельные UX.

---

## 8. Риски и открытые вопросы

### 8.1 CPU-бюджет

См. §3.4. Калибровка на 1000 партиях — около 4 часов на 4 vCPU spot-task. Приемлемо. После калибровки full-sweep архива (несколько десятков тысяч TWIC-партий) — недели одного instance, но это incremental: новые TWIC-импорты идут потоком ~10–50 партий/день, что укладывается в один nightly-task.

**Открытый вопрос:** Stockfish 17/18 vs 16 на нашем `/usr/games/stockfish` — что установлено сейчас и стоит ли обновлять до NNUE-сильной версии. Не блокирующее, выясняется на этапе 1 (devops).

### 8.2 Юридика

| Источник | Лицензия | Право публиковать как puzzle |
|---|---|---|
| TWIC | The Week in Chess — публикуется как database, общая практика — свободное использование PGN | Да; уже используется в drill (ADR-035 / ADR-013), претензий не было. |
| Lichess database | CC0 | Да; уже используется в `Puzzle` (`source='lichess'`) с момента запуска puzzles. |
| Партии пользователей Kingside | Соглашение — нужно проверить ToS | **Открытый вопрос** для этапа 3. На этапе 1 не используем. |
| Партии других сайтов (chess.com, lichess) импортируемые юзером | Зависит от пользователя как загрузчика | Этап 3, после юридической проверки. |

KS-2360 (board-recog, упомянут в задаче) ставил похожий вопрос — координатор может проверить статус. На MVP (этап 1–2) используется только TWIC, юридический риск минимален.

### 8.3 Разнообразие

MVP-источник — только TWIC. Это партии гроссмейстеров и мастеров, у них меньше явных blunder'ов → puzzle'ов будет меньше, но они будут чистые. После калибровки можно расширить:
- Lichess-database (есть бесплатные дампы партий) → много, но шумно (любители).
- Партии пользователей Kingside.
- chess.com PGN — только если пользователь сам загружает.

### 8.4 Дублирование с Lichess Puzzle DB

Lichess уже предоставляет ~3M puzzle'ов в CC0 (мы их импортировали). Зачем своя генерация:
- Свежие partии TWIC, появляющиеся раньше, чем Lichess их успеет проанализировать.
- Партии пользователей платформы (этап 3) — этого Lichess не даст.
- Контроль качества и тегирования через наши drill-предикаты — точнее эвристик lichess-puzzler.

**Открытый вопрос:** не делать ли import целиком Lichess puzzles вместо своей генерации? Уже импортированы (`source='lichess'`), вопрос «надо ли вообще генерировать своё». Ответ от пользователя: «партии из ваших игр» — это персональный feature (этап 3), для которого без своей генерации не обойтись. Этап 1–2 — bootstrap pipeline'а под этап 3.

### 8.5 Совместимость с UX Puzzle Rush

Lichess puzzles в Rush — формат «moves[0] — setup-ход противника, дальше игрок». Generated — без setup, игрок сразу первым ходом. Код `validatePlayerSide` (`puzzle.service.ts:526`) уже это различает по `source`. Но Puzzle Rush UI рендерит позицию исходя из FEN — нужно убедиться, что для generated не показывается «лишний» ход противника. Проверка в этапе 2 (qa-регресс).

### 8.6 Отзыв тегов после изменений drill-предикатов

Drill predicates эволюционируют (KS-2406/2408/2419 — последние правки). Если предикат меняется → старые теги в `Puzzle.themes` могут стать неточными. На MVP — terпим (теги — best-effort). На будущее: nightly-job «retag generated puzzles», если детектируется большое расхождение.

---

## 9. Сводный список тикетов MVP (для координатора)

### Этап 1 — Batch-генератор без UI

> **Предусловие:** ADR-042 / KS-2432 — `apps/tactic-worker` поднят (cм. KS-2433+ в плане ADR-042).

- [ ] **backend (генератор):** subcommand `generate-puzzles` в `apps/tactic-worker` + `puzzle-generator/generator-pipeline.ts` по образцу drill-индексера (тоже в tactic-worker). Параметры CLI, чтение `archive_games` через pg, запись в `Puzzle` через Prisma. Threshold'ы из §2 как ENV.
- [ ] **backend (predicate-tagging):** модуль `apps/tactic-worker/src/puzzle-generator/tagging.ts` — drill-predicate'ы (импорт из локального `predicates/`) + алгоритмические теги (§4). Зависит от генератора.
- [ ] **backend (миграция):** Prisma migration в `apps/api/prisma/migrations/` — partial UNIQUE `(fen, source) WHERE source='generated'`. Зависит от генератора (без неё дубли).
- [ ] **chess-expert (sample-test):** оценить 30 puzzle'ов из первого batch'а 100 партий, отчёт с %шума и предложением threshold'ов. Зависит от backend.
- [ ] **qa (smoke):** запуск на 10 dev-партиях, проверка структуры записей, тегов, отсутствия дублей. Зависит от backend.

### Этап 2 — Автозапуск + интеграция в Puzzle Rush

- [ ] **devops (EventBridge):** schedule на task-def `kingside-tactic-worker` (зарегистрирован в KS-2432), command `["generate-puzzles","--max-games","500"]`, cron `0 2 * * ? *` UTC. Cursor-key в Redis. Зависит от этапа 1 + ADR-042.
- [ ] **backend (Puzzle Rush):** включить generated-puzzles в выдачу (проверить фильтры, флаг включения, default ON). Зависит от этапа 1.
- [ ] **frontend (опц.):** категория «Свежие задачи из партий» на `/puzzles` с фильтром по `source` и темам. Опционально для MVP.
- [ ] **qa (регресс):** Puzzle Rush + единичный `/puzzles` flow на generated-puzzle проверить (`validatePlayerSide` для generated). Зависит от backend.

### Этап 3 — Персональная генерация (после юридики и калибровки)

- [ ] **backend (endpoint):** `POST /api/puzzles/generated/from-my-game/:gameId`.
- [ ] **backend (очередь):** Redis stream для on-demand с прогрессом.
- [ ] **frontend (UI):** «Сделать задачи из этой партии» в архиве пользователя.
- [ ] **chess-expert (калибровка):** threshold'ы под пользовательские партии (выше шум).
- [ ] **coordinator (юридика):** подтверждение по ToS Kingside о праве генерировать puzzles из партий пользователей. **Блокер этапа 3.**

---

## 10. Резюме

- Схема `Puzzle` уже умеет хранить generated-данные — миграции почти не нужны (только partial UNIQUE).
- Stockfish service и pattern «cursor + pg.Client» уже работают в drill-индексере; puzzle-генератор — отдельный скрипт по тому же шаблону.
- Drill-предикаты (после KS-2406/2408/2419) дают точное тегирование с нулевым false-positive — это плюс по сравнению с lichess-puzzler.
- MVP — этап 1: один CLI-скрипт + миграция + chess-expert sample-test. Дальше автозапуск (этап 2) и личная генерация (этап 3).
- Юридика блокирует только этап 3; этапы 1–2 на TWIC закрыты ADR-013/014.
