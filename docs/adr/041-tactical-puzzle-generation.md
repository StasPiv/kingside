# ADR-041: Автогенерация тактических задач из партий (Puzzle Generation)

**Дата:** 2026-05-05 (правка 2026-05-05: §2 переписан под реальный алгоритм lichess-puzzler `analyze_position` / `cook_advantage` / `cook_mate` — триггер «переход в выигранную позицию», spread `0.7 WC`, нечётная длина ≥ 5, `pair_limit = depth=50/time=30s/nodes=25M`. Детали в §2.0–§2.5, §3.4, §3.6, §5)
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

Все значения — из `lichess-puzzler/generator/generator.py` (константы `pair_limit`, mate-defense `Limit`).

| Параметр | Значение | Где у lichess |
|---|---|---|
| `pair_limit` (advantage-анализ позиций партии и линии) | `depth=50, time=30s, nodes=25_000_000` | `pair_limit` |
| Mate-defense limit (для соперника в mate-линии) | `depth=15, time=10s, nodes=8_000_000` | передаётся в `cook_mate` |
| MultiPV | 2 | lichess работает с парой `(best, second)` — `EngineMove`-pair |
| `mate_soon` (порог для перехода в mate-режим) | `Mate(15)` | `mate_soon` |

Stockfish вызывается с soft-лимитами (любое из условий — depth/time/nodes — гасит расчёт). Реальное среднее сходится раньше `time=30s`; это потолок для сложных позиций.

Сразу после получения cp/mate из Stockfish — конвертация в WC по формуле §2.0; дальнейшие сравнения идут в WC.

### 2.2 Триггер «здесь есть пазл»

**Не дельта от сделанного хода.** Триггер привязан к самой позиции и к её разнице с предыдущей (`prev_score`). Это `analyze_position` из lichess-puzzler — берём один-в-один:

На каждом ply партии (с `prev_score` от предыдущей позиции; `score` — оценка текущей позиции из MultiPV; `winner` — сторона, в чью пользу `score`):

1. **Hard drop conditions (любое — drop):**
   - `prev_score > Cp(300) and score < mate_soon` — позиция уже была явно выигранной до этого хода, не учебный момент;
   - `is_up_in_material(winner)` — winner уже впереди по материалу: это реализация перевеса, не тактика;
   - `score >= Mate(1) and tier < 3` — мат-в-1 принимается только в высшем tier; для MVP `tier = 3`, поэтому **мат-в-1 всегда drop**.

2. **Mate-puzzle**: `score > Mate(15)` (`mate_soon`) → передаём в `cook_mate(...)` (см. §2.4).

3. **Advantage-puzzle**: `score >= Cp(200) AND WC(score) > WC(prev_score) + 0.6` → передаём в `cook_advantage(...)`.
   - Дополнительное drop-условие: `if score < Cp(400) and material_diff(winner) > -1` — если перевес умеренный (200..400cp) И winner НЕ отстаёт по материалу (то есть либо равен, либо впереди) — drop. Цель: мы хотим тактики, где winner отдал материал и взамен получил позиционный/комбинационный перевес. Если материал уже у него — это снова реализация, а не тактика.

4. Иначе — не пазл, идём к следующему ply.

**Замечание о `prev_score`.** Считается на позиции **до** текущего хода партии (как и `score` — на позиции **после**). Поэтому индексирование позиций партии — стандартное: для каждого ply имеем пару `(scoreBefore, scoreAfter)`; `prev_score = scoreBefore`, `score = scoreAfter`.

**Замечание о tier.** В lichess-puzzler tier — параметр командной строки (`--tier`), управляет «насколько дорогая глубина анализа и какой минимум длины линии». Для MVP фиксируем `tier = 3` (учебные пазлы для 1200–2000): полный `pair_limit` + минимум 5 полуходов в линии (см. §2.4).

### 2.3 Фильтры партии (применяются до анализа)

| Фильтр | Порог | Источник поля | Комментарий |
|---|---|---|---|
| Тип контроля | `timeControlCategory ∈ {blitz, rapid, classical}` (не bullet, не unknown) | `archive_games.time_control_category` | Bullet содержит много шумовых blunder'ов; unknown — без гарантии. |
| Рейтинг обоих игроков | `whiteElo ≥ 1400 AND blackElo ≥ 1400` | `archive_games.white_elo / black_elo` | Жёстче KS-1408 (≥ 1200) — повышаем планку, у нас задачи для 1200–2000 пользователей. Если данных нет (`null`) — допускаем (TWIC обычно содержит titled players без явного Elo). |
| Длина партии | `plyCount ≥ 20` | `archive_games.ply_count` | Стартовая позиция puzzle берётся с ply 20 минимум (= 10 полных ходов). |
| Категория | `category ≠ 'bot'` (если поле проставляется), и `isClassical` не строго требуется (но стартуем с classical-партий — большая глубина расчёта, более чистые тактики) | `archive_games.category / is_classical` | MVP: только classical/rapid; blitz добавим после калибровки шума. |
| Не из дебюта | `ply ≥ 20` для начала puzzle | вычисляется при ходьбе по партии | KS-1408 минимум 10 полных ходов — оставляем. |

### 2.4 Построение линии

Две ветки — `cook_advantage` (для advantage-puzzle) и `cook_mate` (для mate-puzzle). Реализация — один-в-один lichess-puzzler.

#### 2.4.1 `cook_advantage` (advantage)

Стартовая позиция — та, на которой сработал триггер из §2.2 (advantage). Сторона на ходу — `winner` (та, в чью пользу `score`). Линия строится итеративно; все сравнения в WC (§2.0).

На каждом шаге:
1. `pair_limit` MultiPV=2 на текущей позиции (`depth=50, time=30s, nodes=25M`).
2. Получаем `pair = (best, second)`.
3. **Условие приёма хода в линию (`is_valid_attack`)**:
   `WC(best.score) > WC(second.score) + 0.7` — лучший ход доминирует над вторым на ≥ 0.7 WC. Если да — `best` идёт в линию. Если нет — линия обрывается на этой позиции.
4. Применяем `best` к доске. Если новая позиция — мат, конец линии.
5. **Ход соперника:** считаем `pair_limit` MultiPV=2; берём `best` соперника без отдельной проверки уникальности (lichess не вводит порог на ход соперника — триггер из §2.2 уже гарантирует, что любой ход проигрывает).
6. Применяем `best` соперника к доске.
7. **Условие продолжения:** `pair.best.score >= Cp(200)` от лица `winner` (с учётом смены стороны на ходу). Если упало ниже — обрыв; иначе goto 1.

**Длина:** для tier=3 — нечётная (последний ход — наш, `winner`'а), минимум 5 полуходов. Если набрано < 5 или длина чётная — пазл выбрасывается.

#### 2.4.2 `cook_mate` (mate)

Стартовая позиция — та, на которой сработал mate-триггер (§2.2.2). Линия идёт до checkmate.

На каждом шаге:
1. **Наш ход (`winner`'а):** Stockfish с `pair_limit`; ищется любой mating move (lichess не требует уникальности на нашем ходу в mate-режиме — главное, что мат форсирован).
2. **Ход соперника:** Stockfish с **mate-defense limit** (`depth=15, time=10s, nodes=8M`) — это легче `pair_limit`; берётся `best` (любая попытка отсрочить мат).
3. Линия идёт пока на доске нет checkmate.
4. **Stop-условия:** мат поставлен, либо длина превысила `Mate(15)` (защита от расходящихся вариантов).

**Длина:** для tier=3 минимум 5 полуходов. Mate-в-1 уже отсеян на §2.2.1. Mate-в-2 (3 полухода) — отсеивается длиной. Принимаются mate-в-3 и длиннее.

#### 2.4.3 `acceptedMoves`

В lichess нет «равноценных защит соперника» как отдельной концепции — там просто `best` соперника. Поэтому в MVP `Puzzle.acceptedMoves` для generated **не заполняется**. Если в будущем потребуется — отдельный апдейт ADR; сейчас фронт корректно работает с одиночным «правильным» ответом соперника (как для большинства Lichess-пазлов).

### 2.5 Отсев тривиальных puzzle'ов

Тривиальные случаи отсекаются в §2.2 hard-drop conditions (мат-в-1, реализация перевеса, уже выигранная позиция) и в §2.4 длиной линии (mate-в-2, чётные advantage-линии). Дополнительных эвристик за пределами того, что делает lichess-puzzler, **не вводим** — это было основной причиной, по которой мой прежний §2 расходился с эталоном.

Если по результатам §5.2 (sample-test) chess-expert найдёт повторяющийся класс шума, который lichess не отсекает — обсуждаем добавку отдельным апдейтом ADR.

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

- 1 task = `STOCKFISH_POOL_SIZE` параллельных Stockfish (default 5). На партии последовательно: ~35 позиций × среднее `~10s` (`pair_limit` сходится раньше потолка `30s` в большинстве позиций) / 5 параллели → ~70 сек/партия.
- Несколько tasks одновременно — нет (cursor-based, race на cursor решается lock'ом в Redis по `SET … NX EX`).

### 3.4 Бюджет CPU

Под параметры lichess-puzzler (`pair_limit = depth=50, time=30s, nodes=25M`). Среднее время на ход ≈ 10s (раньше упирается в `nodes`/`depth`, реже в `time=30s`). Партия ≈ 35 ply × 10s ≈ 350 vCPU-сек.

| Объём | На 1 vCPU | На 4 vCPU (1 task pool=5) |
|---|---|---|
| 100 партий | ~10 ч | ~2.5 ч |
| 1000 партий | ~100 ч (≈ 4 суток) | ~25 ч (≈ 1 сутки) |
| 10000 партий | ~40 суток | ~10 суток |

Это **на порядок дороже** прежней оценки (где cтояли произвольные `depth=18`). MVP по-прежнему реалистичен: 100 партий за ~2.5 часа на одном task — достаточно для §5.2 sample-test. Daily-incremental в 500 партий — ~12 часов на 4 vCPU, что укладывается в night-window, но впритык; если не помещается — снижаем `time` до 15s (lichess `time=30s` — потолок, не среднее).

**Открытый вопрос калибровки:** реальное среднее `pair_limit`-расчёта измеряется в §5.2. Если получится сильно меньше 10s — пересчитаем. Если больше — снижаем `time`, фиксируем компромисс отдельным апдейтом ADR.

### 3.5 Хранение

**Решение:** не плодить новую таблицу. Использовать существующий `Puzzle` с `source='generated'`. Все нужные поля уже есть.

Что обязательно проставляем при генерации:
- `id`: UUID;
- `fen`, `moves` (UCI через пробел, без setup-move);
- `source = 'generated'`;
- `sourceType = 'archive_game'` (на будущее: `'user_game'`);
- `sourceId = archive_games.id`;
- `sourceMoveNum`: ply, с которого взята позиция;
- `gap`: `cp(bestScore) − cp(secondScore)` стороны на ходу — для UI «насколько чисто решение», совместимо с Lichess-puzzle gaps. Для отбора и решения «принять / drop» используются WC-условия §2 (`spreadWC ≥ 0.7`); gap здесь только для отображения/UX-фильтрации;
- `depth`: `50` (как у lichess `pair_limit`);
- `themes`: см. §4 (через пробел);
- `rating`: начальное по §3.6;
- `ratingDev`: 350 (стандартный default — Glicko ещё не уверен);
- `isPublic`: `true` для MVP. Если потом введём ручную модерацию — выставлять `false` до approve.
- `sourceMetadata` (JSON): `{ "trigger": "advantage" | "mate", "scoreCp": …, "prevScoreCp": …, "wcDeltaTrigger": …, "spreadWC": …, "lineLength": …, "tier": 3, "engine": "stockfish-XX", "engineVersion": "…", "generatedAt": "…" }`. Поля соответствуют lichess-условиям §2.2; нужны для отладки и для пост-анализа калибровки (§5.2).

### 3.6 Начальный рейтинг

```
avgPlayerRating = round(avg(whiteElo, blackElo, default 1500))
lengthAdj = (lineLength − 5) × 75         // 5 полуходов = 0, 7 = +150, 9 = +300
gapAdj   = spreadWC > 0.85 ? −100 : 0     // линия совсем «явная» — снижаем
trigAdj  = trigger == "mate" ? +100 : 0   // mate-puzzle обычно сложнее
rating = clamp(600, 2800, avgPlayerRating + lengthAdj + gapAdj + trigAdj)
```

Формула привязана к нечётной длине (advantage стартует от 5 полуходов, см. §2.4). Glicko на attempts далее скорректирует. Прежняя формула KS-1408 опиралась на «2..6 полуходов» и `gap` в cp — обе предпосылки в новой модели не действуют, поэтому формула пересмотрена.

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

Все — из lichess-puzzler `analyze_position` / `is_valid_attack` / `cook_advantage`:

- **Триггер позиции (advantage):** `score >= Cp(200) AND WC(score) > WC(prev_score) + 0.6`.
- **Hard drop conditions:** `prev_score > Cp(300) and score < mate_soon`; `is_up_in_material(winner)`; `score >= Mate(1) and tier < 3`.
- **Доп. drop в advantage:** `score < Cp(400) and material_diff(winner) > -1`.
- **Триггер mate:** `score > Mate(15)` (`mate_soon`).
- **Spread в линии (advantage):** `WC(best) > WC(second) + 0.7` на каждом нашем ходу.
- **Условие продолжения линии (advantage):** `pair.best.score >= Cp(200)` от лица winner.
- **Длина (tier=3):** advantage — нечётная, ≥ 5 полуходов; mate — ≥ 5 полуходов (mate-в-1, mate-в-2 отсеиваются).

### 5.2 Sample-test через chess-expert

После первого batch'а 100 партий (~ожидаемо 30–80 сгенерированных puzzle'ов; lichess-триггер строже cp-зевка, поэтому количество ниже прежнего прогноза):
1. Architect / координатор передают chess-expert'у сэмпл: 20 случайных + 5 с минимальной длиной (5 полуходов) + 5 mate-puzzle.
2. Chess-expert по каждому: «учебный / проходной / drop». Цель — оценить % шумных позиций.
3. Параллельно фиксируем эмпирическое среднее `pair_limit`-расчёта (для уточнения §3.4).
4. Если шум > 10% — обсуждаем причину. Пороги lichess трогаем только при явном системном дефекте; вероятнее, проблема в отборе партий (§2.3) или в нашем тегировании (§4).

### 5.3 Постмодерация

- `isPublic=false` для всех первых N puzzle'ов до явной модерации (опц. ручная или авто-через-attempts: после 10 attempts с accuracy ≥ 30% → `isPublic=true`).
- Подтверждённый шум (accuracy < 5% за 50 attempts) → `isPublic=false` обратно.

В MVP: `isPublic=true` сразу, без модерации; sample-test закрывает риск.

### 5.4 Что считается «хорошим» puzzle'ом (рамка)

| Признак | Хороший | Плохой |
|---|---|---|
| Длина | 5–9 полуходов (нечётная для advantage) | < 5 (отсеивается), чётная (отсеивается) |
| Spread (WC) на нашем ходу | ≥ 0.7 (есть единственный явный путь) | < 0.7 (отсеивается `is_valid_attack`) |
| Триггер | переход `WC(score) > WC(prev) + 0.6 ∧ score ≥ +200cp` | hard-drop условия §2.2.1 |
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
- **[chess-expert] Калибровка под пользовательские партии** — у любителей шум выше, может потребоваться смягчить триггер (`WC(score) − WC(prev) > 0.5` вместо `0.6`) и/или снизить `min-rating`. Решение принимаем по итогам sample-test'а на партиях пользователей.

Этап 3 — после явного зелёного света по юридике и качеству batch'а.

---

## 7. Связь с drill-системой (ADR-035)

Drill и puzzle в Kingside — два дополняющих, не пересекающихся режима:

| | Drill (ADR-035) | Puzzle (ADR-041 + текущая Lichess-выдача) |
|---|---|---|
| Что тренирует | Зрение / распознавание паттерна за 1–2 секунды | Расчёт форсированного варианта на 5+ полуходов |
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
