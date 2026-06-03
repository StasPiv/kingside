# ADR-104. Фильтрация Precision-пазлов по предсказанию Maia

Статус: **заменён ADR-106 (KS-3638)**. Историческая версия — top-1 метрика отменена в реализации, т.к. при нескольких равно-сильных по Stockfish ходах Maia может присваивать «решающему» ходу низкую вероятность, а высокую — другому равно-сильному; top-1 вероятность одного выбранного хода ≠ мера лёгкости позиции для человека.
Дата: 2026-06-03.
Связано: ADR-048 (Precision section), ADR-066 (classify-WDL), ADR-079 (precision scopes), ADR-080 (precision theme filters), KS-3577 (Maia-3 simplified on client), ADR-106 (заменяющая метрика).

## 1. Контекст

В разделе «Точность» (Precision) выдаются `puzzles WHERE solution_mode='play-vs-engine'` (см. `PrecisionService.pickNext`). Часть пазлов слишком очевидна для человека — Maia предсказывает правильный ход с высокой вероятностью. Такие пазлы не дают тренировочной ценности и должны вычёркиваться.

Критерий: вероятность правильного хода по Maia > `N`. Начальный порог `N=0.5`, должен меняться без редеплоя.

## 2. Принятые решения

1. **Источник вероятности — Maia 3** (та же модель что на клиенте, `apps/web/public/maia3/maia3_simplified.onnx`, 44 МБ). Maia-3 принимает ELO как input, одна модель покрывает все уровни.
2. **Где считается** — backend, **offline-разметка**. На фронте — только чтение поля + клиентский фильтр.
3. **ELO разметки** — параметр, ENV `PRECISION_MAIA_ANNOTATION_ELO`, default `1500`. При смене ENV пазлы перерасчитываются (см. §6).
4. **Колонки** — две новые в `Puzzle`:
   - `maiaTop1Prob: Float?` (`maia_top1_prob`) — вероятность правильного хода по Maia.
   - `maiaTop1Elo: Int?` (`maia_top1_elo`) — ELO которым прогнали (для воспроизводимости и корректного reuse при смене ENV).
5. **Runner** — admin-CLI `tools/maia-puzzle-annotation/` на Node.js + `onnxruntime-node`. Переиспользует pure-логику из `apps/web/src/lib/maia/` (FEN→tokens, postprocess softmax), session-создание — node-провайдер.
6. **Continuous-annotation** — tactic-worker (`apps/tactic-worker`) после создания нового пазла прогоняет тот же annotation-flow. Новые пазлы попадают в каталог уже размеченными.
7. **NULL-обработка** — фронт по умолчанию ВКЛЮЧАЕТ пазлы с `maiaTop1Prob IS NULL` в выдачу. Это безопасный fallback на время бэкфилла и для пазлов которые ещё не успели прогнаться через annotation.
8. **REST** — поля `maiaTop1Prob` и `maiaTop1Elo` добавляются в существующие precision-DTO. Контракт-совместимое расширение.
9. **Порог** — клиентский. Константа `PRECISION_MAIA_DEFAULT_THRESHOLD = 0.5` в `@kingside/shared`. Локальная override в localStorage (`precision.maiaThreshold`). UI-slider в фильтрах Precision — отдельный enhancement, не блокер MVP.
10. **Откат** — порог `N >= 1.0` (или `Infinity`) → фильтр выключен (`maiaTop1Prob > 1.0` всегда false), поведение прежнее. Никаких ENV-флагов на бэке для отключения — не нужны, поле просто перестаёт использоваться фронтом.

## 3. Схема БД (миграция)

```prisma
model Puzzle {
  // ... существующие поля ...

  /// KS-3630 / ADR-104. Maia-3 top-1 вероятность правильного хода
  /// под `maiaTop1Elo`. Заполняется admin-CLI или tactic-worker'ом
  /// при создании нового пазла. NULL — ещё не размечен.
  maiaTop1Prob Float? @map("maia_top1_prob")

  /// KS-3630 / ADR-104. ELO под которым прогоняли Maia. Хранится
  /// для воспроизводимости и для проверки актуальности значения
  /// при смене ENV `PRECISION_MAIA_ANNOTATION_ELO`.
  maiaTop1Elo  Int?   @map("maia_top1_elo")

  // ... индексы ...

  /// KS-3630: фильтр precision-выборки по maia_top1_prob. Composite
  /// с solution_mode чтобы покрыть основной precision-запрос.
  @@index([solutionMode, maiaTop1Prob])
}
```

Миграция: `ALTER TABLE puzzles ADD COLUMN maia_top1_prob REAL, ADD COLUMN maia_top1_elo INT4;` + `CREATE INDEX puzzles_solution_mode_maia_top1_prob_idx ON puzzles (solution_mode, maia_top1_prob);`.

Размер на 6M строк: REAL 4 B × 6M = 24 МБ + INT4 4 B × 6M = 24 МБ + index. Принимаемо.

## 4. Runner — `tools/maia-puzzle-annotation/`

### 4.1. Структура

```
tools/maia-puzzle-annotation/
  package.json           — отдельный workspace, deps: onnxruntime-node, chess.js, @prisma/client
  src/
    index.ts             — CLI entry, argv parsing, batch loop
    maia-node.ts         — Node-провайдер для Maia engine: onnxruntime-node + переиспользование apps/web/src/lib/maia/{engine,tensor}.ts
    db.ts                — Prisma-обёртка: fetch batch, update batch
  README.md              — как запускать, требования, troubleshooting
```

Pure-логика переиспользуется из `apps/web/src/lib/maia/` (FEN→tensor, postprocess softmax) — она не зависит от Web API. Только `InferenceSession.create` отличается между -web и -node, поэтому ядро engine.ts принимает provider-абстракцию (уже сейчас — см. `apps/web/src/lib/maia/index.ts:34-50`, `provider: { Tensor, createSession }`). Node-runner подсовывает свой provider.

Модель грузится по абсолютному пути: ENV `PRECISION_MAIA_MODEL_PATH` (default — `apps/web/public/maia3/maia3_simplified.onnx`).

### 4.2. CLI

```
node tools/maia-puzzle-annotation/dist/index.js \
  --elo 1500 \
  --batch-size 1000 \
  --resume \
  [--solution-mode play-vs-engine] \
  [--force]
```

- `--elo` (default из ENV `PRECISION_MAIA_ANNOTATION_ELO`, иначе 1500) — eloSelf и eloOpponent.
- `--batch-size` (default 1000) — сколько пазлов в одной транзакции `UPDATE`.
- `--resume` (default true) — пропускать строки с уже заполненным `maiaTop1Prob` и `maiaTop1Elo = текущий ELO`.
- `--force` — перепрогнать всё (использовать при смене ELO глобально либо при апгрейде модели).
- `--solution-mode` (default `play-vs-engine`) — фильтр по типу пазла. По умолчанию размечаем только precision-каталог.

### 4.3. Идемпотентность

`WHERE solution_mode = $1 AND (maia_top1_prob IS NULL OR maia_top1_elo != $2)`. При `--resume` (default) — повторный запуск с тем же ELO ничего не делает.

### 4.4. Алгоритм

1. Загрузить Maia-3 ONNX session (один раз).
2. SELECT N (batch) пазлов `WHERE` (см. §4.3) `ORDER BY id` (детерминированный порядок для воспроизводимости).
3. Для каждого:
   - `fen = puzzle.fen`,
   - `correctUci = puzzle.moves.split(' ')[0]` (первый ход в `moves`-строке — правильный ход, см. lichess-puzzle convention; для generated-пазлов тот же контракт).
   - `policy = maia.predictMoves(fen, elo, elo)`,
   - `topProb = policy.find(p => p.move === correctUci)?.probability ?? 0`.
4. Batch UPDATE: `UPDATE puzzles SET maia_top1_prob = ..., maia_top1_elo = ... WHERE id = ...`.
5. Лог `[annotation] batch K/N — processed: X, skipped: Y, elapsed: Z s`.
6. Если ошибка на конкретной строке — лог + продолжать (puzzle получит `maiaTop1Prob = NULL` от старта).
7. Цикл до пустого batch'а.

### 4.5. Производительность

- Maia-3 один inference ~50–200 мс на CPU (зависит от железа).
- 6M пазлов × 100 мс ≈ 600k секунд ≈ 7 суток CPU. Только precision-каталог (по grep — порядок единиц тысяч строк, см. precision.service.ts комменты «1595 puzzles» в getThemeCounts audit) — десятки минут.
- Точная оценка отсева на N=50% доступна только после прогона. Закладываю ожидание ~15–30% по аналогии с lichess puzzle-difficulty studies, но цифра — на статистику после первой разметки. Фиксируем в комментарии тикета T1.

## 5. Continuous annotation в tactic-worker

`apps/tactic-worker` создаёт новые precision-пазлы (см. ADR-041, ADR-083). После сохранения нового `Puzzle` — вызвать тот же annotation-flow на этом одном пазле (single inference) и записать `maiaTop1Prob` / `maiaTop1Elo` в той же транзакции. Engine session — singleton в воркере (как у клиента), грузится при первом пазле.

Это снимает необходимость периодически перезапускать admin-CLI: новые пазлы становятся размечены сразу. Admin-CLI остаётся только для:
- разового бэкфилла существующих пазлов;
- массового перерасчёта при смене ELO глобально (`--force --elo NEW`).

## 6. Смена ELO глобально

`PRECISION_MAIA_ANNOTATION_ELO` меняется → нужно пересчитать пазлы под новый ELO:
1. devops меняет ENV в tactic-worker (для новых пазлов).
2. admin запускает `tools/maia-puzzle-annotation/ --force --elo NEW` (для существующих).

Колонка `maiaTop1Elo` позволяет идемпотентно отличить «уже размечен под текущим ELO» от «нужно перерасчитать».

## 7. Поведение фронта

В precision-DTO (типы в `packages/shared/src/...`) добавляются:

```ts
type PrecisionPuzzle = {
  // ... как сейчас ...
  maiaTop1Prob: number | null;   // KS-3630 / ADR-104
  maiaTop1Elo: number | null;    // KS-3630 / ADR-104
};
```

Фильтр на клиенте:

```ts
import { PRECISION_MAIA_DEFAULT_THRESHOLD } from '@kingside/shared';

function isPuzzleEligible(p: PrecisionPuzzle, threshold = PRECISION_MAIA_DEFAULT_THRESHOLD): boolean {
  if (p.maiaTop1Prob == null) return true;   // NULL → не размечен, не отсеиваем
  return p.maiaTop1Prob <= threshold;
}
```

Порог берётся из localStorage `precision.maiaThreshold`, иначе константа. UI для перенастройки — опциональный F2 (не блокер MVP).

### 7.1. Где применяется фильтр на фронте

В `pickNext`-flow фронт делает запрос на бэк, получает один пазл. Если backend пришёл с `maiaTop1Prob > threshold` — фронт **повторяет запрос** (исключая этот puzzleId через локальный set «skipped due to maia threshold»). Цикл с лимитом 5 повторов (защита от пустых выборок).

Для browse-страниц (если есть) — список фильтруется на месте.

### 7.2. Опциональное: фильтр на бэке

Можно дополнительно прокинуть `maiaThreshold` в query-param на `/api/precision/next` и применить в `WHERE` уже на стороне backend. Это упростит фронт (не нужны повторы) и снизит overhead. Принимаю как enhancement B2, не блокер MVP.

## 8. Декомпозиция

### B1 (backend, ~0.5 дня) — миграция БД + DTO

- Prisma миграция: добавить `maiaTop1Prob`/`maiaTop1Elo` в `Puzzle` + composite-индекс.
- DTO-слой: добавить эти поля во все REST-ответы precision-пазлов (одиночный puzzle, list, browse).
- `packages/shared/src/...` — обновить типы `PrecisionPuzzle` / `PuzzleDto`.
- Тесты на DTO-сериализацию.
- Метки: `puzzle`, `precision`, `prisma`.

### T1 (backend / tools, ~1.5 дня) — annotation runner + бэкфилл

- `tools/maia-puzzle-annotation/` — Node-CLI, переиспользует Maia engine из `apps/web/src/lib/maia/` через provider-абстракцию + onnxruntime-node.
- ENV: `PRECISION_MAIA_ANNOTATION_ELO=1500`, `PRECISION_MAIA_MODEL_PATH=apps/web/public/maia3/maia3_simplified.onnx`.
- Идемпотентный, batch UPDATE, log progress, `--resume`/`--force`.
- README с инструкцией.
- Запустить разовый бэкфилл по precision-каталогу. В комментарий KS-3630 положить: сколько строк размечено, средняя prob, распределение, **% отсева при N=0.5** (фактическая цифра, которую просит пользователь).
- Метки: `puzzle`, `precision`, `analysis`.

### T2 (backend, ~0.5 дня) — continuous annotation в tactic-worker

- В `apps/tactic-worker` после создания нового precision-пазла — вызов maia annotation (single inference) на этом пазле, заполнение `maiaTop1Prob` / `maiaTop1Elo` в той же транзакции.
- Engine session — singleton в воркере, грузится при первом пазле.
- Graceful: если ONNX session не поднялась — лог WARN, пазл сохраняется с `maiaTop1Prob = NULL`, фронт его не отсеет (NULL = pass).
- Метки: `puzzle`, `precision`.

### F1 (frontend, ~0.5 дня) — клиентский фильтр + константа

- `packages/shared/src/...` — экспорт `PRECISION_MAIA_DEFAULT_THRESHOLD = 0.5` (см. ADR §2.9).
- В precision-flow на фронте (где вызывается `pickNext` и где приходит ответ) — проверка `maiaTop1Prob <= threshold`, при превышении — повтор запроса с `excludeIds`. Макс 5 попыток.
- Чтение `threshold` из localStorage `precision.maiaThreshold`, дефолт — константа.
- Тесты на фильтр-функцию (NULL пропускается, превышение — отсеивается, retry-лимит).
- Метки: `puzzle`, `precision`.

### B2 (backend, опциональный enhancement) — server-side maia-фильтр в pickNext

- Прокинуть `maiaThreshold` (query-param) в `PrecisionService.pickNext`, добавить `WHERE (maia_top1_prob IS NULL OR maia_top1_prob <= $threshold)`.
- Снижает overhead (фронт не повторяет запрос), но усложняет API.
- Не блокер MVP; делать если F1-retry окажется заметным в логах.

### F2 (frontend, опциональный enhancement) — UI slider для порога

- Slider в фильтрах Precision (chips-bar или Settings) для подбора `threshold` (0.30…1.00, шаг 0.05).
- Сохранение в localStorage `precision.maiaThreshold`.
- Не блокер MVP.

### Зависимости

```
B1 ──┬─> F1 ──> (готовый MVP с разовым бэкфиллом T1)
     │
     └─> T1, T2 (могут параллельно)

опционально: B2 (после F1, если retry-нагрузка заметна)
            F2 (после F1)
```

B1 — стартует первым (миграция). F1 ждёт B1 (для типов в shared). T1/T2 — параллельно с F1 (используют ту же миграцию).

### Прогноз

- B1: 0.5 дня.
- T1: 1.5 дня (вкл. бэкфилл).
- T2: 0.5 дня.
- F1: 0.5 дня.
- **Итого до MVP**: ~2 рабочих дня с распараллеливанием B1 → (F1 ∥ T1 ∥ T2).
- B2 / F2 — отдельный этап по результатам мониторинга.

## 9. Откат

- Сменить `PRECISION_MAIA_DEFAULT_THRESHOLD` на 1.0 (или ∞) — фильтр выключен на фронте без редеплоя бэка.
- Сменить localStorage `precision.maiaThreshold` — индивидуально для пользователя.
- Колонки в БД оставляем (data сохраняется, размер незначителен).
- Continuous annotation в tactic-worker можно отключить ENV `PRECISION_MAIA_ANNOTATION_ENABLED=false` (добавляется в T2 как guard).

## 10. Резюме

Backend проставляет каждому precision-пазлу одно поле `maiaTop1Prob` (Float) + audit-поле `maiaTop1Elo` (Int) через offline-разметку Maia-3 simplified ONNX (та же модель что на клиенте). Runner — admin-CLI `tools/maia-puzzle-annotation/` на Node.js + onnxruntime-node, переиспользует pure-логику с фронта. Tactic-worker размечает новые пазлы автоматически.

Фронт получает поле в DTO и фильтрует на клиенте: `maiaTop1Prob > threshold` → пазл пропущен, retry до 5 раз. Порог — константа `PRECISION_MAIA_DEFAULT_THRESHOLD=0.5` в shared, локальный override через localStorage.

NULL → не отсеиваем (safe fallback на время бэкфилла). Откат — порог в 1.0 на фронте, без редеплоя.

Декомпозиция: B1 (миграция + DTO), T1 (CLI + бэкфилл), T2 (continuous в tactic-worker), F1 (клиентский фильтр + константа). Опционально: B2 (server-side фильтр), F2 (UI slider).

Срок до MVP: ~2 рабочих дня с распараллеливанием.
