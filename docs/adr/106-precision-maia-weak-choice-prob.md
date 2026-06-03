# ADR-106 — Precision-Maia v2: суммарная вероятность слабых ходов из Maia top-K

Статус: предложен (KS-3638).
Дата: 2026-06-03.
**Заменяет: ADR-104 (KS-3630, top-1 метрика отменена в реализации).**
Связано: ADR-066 (classify-WDL), ADR-104 (предшественник), KS-3380 (паттерн `searchmoves` + WDL).

## 1. Контекст

ADR-104 предлагал отсев Precision-пазлов по `policy[firstMovePV1]` (вероятность Maia top-1 угадать SF-best). На практике метрика провалилась (KS-3630):

- При нескольких равно-сильных по SF ходах Maia может с высокой вероятностью играть «не тот» сильный ход — пазл помечается как нетипичный, хотя человек уровня X найдёт правильный с высокой суммарной вероятностью.
- Top-1 — одна точка из распределения Maia; не отражает «насколько вероятно сыграть плохо».

Запрос пользователя — мерить именно «вероятность ошибки», т.е. суммарную вероятность слабых ходов.

## 2. Решение

### 2.1. Алгоритм

```
1. Maia(fen, elo).policy → отсортировать по убыванию.
2. maiaTopK = { m | policy[m] > 0.10 } ∩ топ-K_max,  K_max = 8.
3. searchmoves = unique([firstMovePV1, ...maiaTopK])   // N ≤ 9
4. SF.analyzePositionWdl(fen, depth=15, multiPV=N, searchMoves=searchmoves)
     → wdl_i для каждого i ∈ searchmoves (POV side-to-move)
5. best_wdl = arg-max по expectedScoreFromWdl(wdl_i)
6. weak_set = { m ∈ maiaTopK | expectedScoreFromWdl(best_wdl)
                              − expectedScoreFromWdl(wdl(m)) > 0.02 }
7. maiaWeakChoiceProb = Σ policy[m] для m ∈ weak_set
```

Порог `loss_E > 0.02` = граница категории `best` по ADR-066. Ход с `loss_E ≤ 0.02` считается равно-сильным и не входит в weak_set.

### 2.2. Источник кандидатов — Maia, а не Stockfish MultiPV=10

Maia концентрирует вероятностную массу на 3–5 ходах. SF MultiPV=10 на тихой позиции (эндшпиль, выжидательный ход) даёт большое равно-сильное множество, метрика раздувается. Maia top-K с порогом `policy > 0.10` автоматически фокусируется на реалистично играемых ходах.

### 2.3. Эталон сильного хода

`firstMovePV1` уже лежит в `Puzzle.sourceMetadata` для всех play-vs-engine пазлов (см. `apps/tactic-worker/src/puzzle-generator/generator-pipeline.ts:367`). Добавляется в `searchmoves` как опорная точка — отдельный SF-вызов на «лучший ход» не нужен.

### 2.4. Один SF-вызов с searchmoves

Stockfish UCI: `go depth N searchmoves m1 m2 … mN` ограничивает корень поиска заданными ходами. MultiPV=N возвращает оценку каждого. Время сопоставимо с одним обычным MultiPV-вызовом (~0.5–1 с при depth=15), так как ветвление в корне жёстко ограничено N ≤ 9.

Текущая сигнатура `StockfishService.analyzePositionWdl` (`apps/tactic-worker/src/stockfish/stockfish.service.ts:212`) не принимает `searchMoves` и ограничивает MultiPV до 5. Расширение в задаче T2:

```ts
async analyzePositionWdl(
  fen: string,
  limit: AnalysisLimit,
  multiPV: number,
  label?: string,
  earlyStop?: (...) => boolean,
  searchMoves?: string[],   // NEW
): Promise<MultiPvLine[]>
```

Лимит `Math.min(5, multiPV)` поднять до `Math.min(10, multiPV)`. При непустом `searchMoves` команде `go` добавляется `searchmoves m1 m2 …`.

### 2.5. Поле БД

| Действие | Поле |
|---|---|
| Переименовать | `maia_top1_prob` → `maia_weak_choice_prob` |
| Сохранить | `maia_top1_elo` (поле аудита — тот же ENV `PRECISION_MAIA_ANNOTATION_ELO`) |
| Добавить | `maia_metric_version: Int` (default 1) — инкрементировать при смене формулы (K_max / порог policy / порог loss_E) |
| Переименовать индекс | `(solution_mode, maia_weak_choice_prob)` |

Миграция = `ALTER TABLE … RENAME COLUMN` + `ADD COLUMN`. Старые значения после rename несовместимы по смыслу — требуется полный пересчёт через `--force`.

### 2.6. Порог фильтрации (фронт)

`PRECISION_MAIA_DEFAULT_THRESHOLD = 0.3`. Смысл инвертирован: пазл проходит, если `maia_weak_choice_prob >= threshold` (вероятность сыграть плохо ≥ 30%).

```ts
function isPuzzleEligible(p, threshold = 0.3) {
  if (p.maiaWeakChoiceProb == null) return true;     // NULL → safe pass
  return p.maiaWeakChoiceProb >= threshold;
}
```

Калибровка — после первого прогона по гистограмме (CLI `--report`). Подозреваемое смещение: гистограмма может оказаться сдвинута влево (низкие weak-prob), потому что в precision-каталоге уже отобраны «явные» зевки.

## 3. Стоимость

- **Maia inference**: ~50–200 мс (как и раньше).
- **SF-вызов с searchmoves**, depth=15, MultiPV=N≤9: ~0.5–1 с.
- **На пазл**: ~1 с.
- **Разовая досыпка** 12k precision-пазлов: ~3.5 ч CPU на одной машине. Параллельно 4 рабочих процесса — ~1 ч.
- **Непрерывная аннотация** (tactic-worker, depth=18): ~2 с на новый пазл (некритично).

## 4. Воздействие на код

| Файл | Изменение |
|---|---|
| `apps/tactic-worker/src/stockfish/stockfish.service.ts` | Параметр `searchMoves?: string[]` в `analyzePositionWdl`; MultiPV cap 5 → 10. |
| `apps/tactic-worker/src/maia/maia-annotation.service.ts` | Принять `StockfishService` через конструктор; переписать `annotate()` под §2.1; graceful если SF-вызов упал → NULL. |
| `tools/maia-puzzle-annotation/src/index.ts` | Spawn `/usr/games/stockfish` (либо переиспользовать `StockfishService` из tactic-worker, если получится без cycle-зависимости). Алгоритм §2.1, `--force` обязателен. |
| `tools/maia-puzzle-annotation/src/index.ts` (report) | Адаптировать гистограмму и пороги (≥ 0.3 / ≥ 0.5 / ≥ 0.7). |
| `packages/db/prisma/schema.prisma` | Rename `maiaTop1Prob` → `maiaWeakChoiceProb`; add `maiaMetricVersion`; rename index. |
| `packages/db/prisma/migrations/...` | Новая миграция (rename + add). |
| `packages/shared/src/...` | Тип поля + константа `PRECISION_MAIA_DEFAULT_THRESHOLD = 0.3`. |
| `apps/web/src/...` | Чтение нового имени; инверсия логики фильтра (`>=`). |

## 5. Идемпотентность

`WHERE` для `--resume`:
```
solutionMode = $mode
AND (maiaWeakChoiceProb IS NULL
     OR maiaTop1Elo != $elo
     OR maiaMetricVersion != 1)
```

`--force` — игнорирует условие, перепрогоняет всё. Обязателен сразу после миграции (старые значения не имеют смысла под новой формулой).

## 6. Декомпозиция

**B1 — backend, ~0.5 дня. Миграция БД + типы.**
- Prisma миграция: rename + `maia_metric_version` + индекс.
- `packages/db` regenerate.
- DTO precision-пазлов: переименование поля.
- Метки: `puzzle`, `prisma`.

**T2 — backend (tactic-worker), ~0.5 дня. Непрерывная аннотация v2 + расширение SF-сервиса.**
- `analyzePositionWdl(..., searchMoves?: string[])`, MultiPV cap 10.
- `MaiaAnnotationService.annotate()` по §2.1, инжект `StockfishService`.
- Graceful: SF-вызов упал → возвращаем NULL (без kill-switch на одной ошибке inference).
- Unit-тесты на алгоритм (моки SF + Maia), интеграционный тест на одну позицию.
- Метки: `puzzle`.

**T1 — tools, ~1 день. CLI v2 + разовая досыпка.**
- Stockfish-сессия в CLI (spawn `/usr/games/stockfish` либо реюз `StockfishService`).
- Алгоритм §2.1, `--force` обязательный для первого прогона, поддержка `--report`.
- Прогон по precision-каталогу, отчёт по гистограмме в комментарий KS-3638.
- Метки: `puzzle`, `analysis`.

**F1 — frontend, ~0.5 дня. Переименование + инверсия фильтра.**
- `packages/shared` константа.
- Логика фильтра: `>=` вместо `<=`, NULL → pass.
- Тесты.
- Метки: `puzzle`.

### Зависимости

```
B1 ──┬─> T2 ──┐
     ├─> T1 ──┼─> A1 (отчёт по гистограмме в KS-3638)
     └─> F1 ──┘
```

B1 — стартует первым (миграция блокирует остальное). T1/T2/F1 — параллельно после B1.

### Прогноз

~2 рабочих дня с распараллеливанием. Разовая досыпка разметки в T1 — последний этап перед калибровкой порога.

## 7. Известные минусы (зафиксированы)

- **Шум top-K на спорных позициях.** Динамический K + `policy > 0.10` снижает, не убирает полностью.
- **ELO-зависимость.** Общая для всех Maia-based подходов; смена `PRECISION_MAIA_ANNOTATION_ELO` требует перерасчёта.
- **Хвост `policy < 0.10` теряется.** Обычно ≤ 5% массы; в шумных позициях может быть выше.
- **Старые значения `maiaTop1Prob` после rename несовместимы по смыслу** — миграция требует `--force` пересчёт.

## 8. Откат

- `PRECISION_MAIA_DEFAULT_THRESHOLD = 0.0` на фронте → все размеченные проходят.
- Данные в БД остаются.
- `PRECISION_MAIA_ANNOTATION_ENABLED=false` в tactic-worker → новые пазлы с NULL, фронт их пропустит (NULL = pass).

## 9. Резюме

Метрика — `Σ policy[m]` по слабым ходам из Maia top-K (динамический K по порогу `policy > 0.10`, K_max=8). Слабый = `loss_E > 0.02` относительно лучшего из множества `{firstMovePV1} ∪ maiaTopK`. Один Maia + один SF-вызов с searchmoves на пазл. Стоимость разовой досыпки — ~1 час CPU при параллели 4. Поле `maiaWeakChoiceProb` (REAL) в `Puzzle`, фронт пропускает пазлы с `>= 0.3` (откат — порог 0.0).
