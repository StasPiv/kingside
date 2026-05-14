# ADR-066. Классификация ходов (best/good/inaccuracy/mistake/blunder) на базе WDL-loss

Статус: предложен (KS-3019).
Дата: 2026-05-14.
Связано: ADR-056 §2.5 / §3.2 (текущая cp-loss-классификация), ADR-065 (precision-score, WDL-based, §2.1/§3.3/§4.3), KS-2754 (per-move WDL в БД), `packages/shared/src/utils/move-classification.ts` (текущая реализация).

## 1. Контекст

### 1.1. Что есть сейчас

Две независимые шкалы оценки качества хода:

| | Метрика | Шкала | Где |
|---|---|---|---|
| **Classification** (NAG) | cp-loss (centipawn-loss) | 5 категорий | `move-classification.ts:103`, ADR-056 §2.5 |
| **Precision-score** | WDL-loss (expected score) | 1-5★ | ADR-065 §2 |

Classification:
- `best`: cpLoss ≤ 0 (или `isBestMove === true`).
- `good`: cpLoss ≤ 30.
- `inaccuracy`: cpLoss ≤ 90.
- `mistake`: cpLoss ≤ 220.
- `blunder`: cpLoss > 220.

Precision-score (ADR-065):
- `loss_E = max(0, E_before − E_after)`, где `E = (w + d/2) / 1000`.
- `accuracy_move = 103.1668 * exp(-0.04354 * loss_E*100) − 3.1669`.
- Композит mean+min → cap по worst-class → 1..5★.

### 1.2. UX-противоречие

Сценарий, который репортит пользователь (KS-3019 description):

> Позиция: `100/0/0` для игрока. Ход юзера → позиция остаётся `100/0/0` (тот же expected score). Но cp-оценка сменилась с `+1500` на `+1300` (или mate-distance стал длиннее) — cp-loss = 200, classification = `mistake` → ход помечен `?` в разборе. При этом WDL не упал → precision-score = 5★ «Идеальное решение».

Пользователь видит «★★★★★ Идеальное решение» одновременно с ходами помеченными `?` — внутренний conflict дизайна.

Корень: cp и WDL — две **разные** функции стоимости. В выигранной (теоретически проигранной) позиции cp может «прыгать» на сотни пунктов между ходами, при том что вероятность исхода не меняется (всё ещё `100/0/0`). Stockfish в таких позициях ищет «ускорение мата», cp реагирует на это; WDL — нет, он уже в углу. Lichess «move accuracy» с самого начала строилась на WDL (точнее, на win%) именно по этой причине.

### 1.3. Цель

Унифицировать классификацию ходов на WDL-loss, ту же скалярную метрику, которую использует precision-score. Достичь свойств:

1. **Монотонность classification ↔ accuracy_move**: `best ≥ good ≥ inaccuracy ≥ mistake ≥ blunder` строго в одной шкале.
2. **Решение UX-bug'а**: при `loss_E = 0` (WDL не меняется) ход всегда `best`, никаких `?`/`?!`.
3. **Согласованность с ADR-065 §3.3 cap'ами**: пороги классификации калиброваны так, чтобы NAG-метки в разборе и итоговое количество звёзд интерпретировались согласованно (см. §4).
4. **Backward compat**: legacy attempt'ы с cp-only можно пересчитать через единую WDL-шкалу с fallback `cp → winPercent → loss_E` (Lichess-formula из ADR-065 §2.4.1).

Не входит:
- Изменение формулы precision-score (ADR-065) — она остаётся как есть.
- Изменение accuracy_move-формулы (Lichess) — без изменений.
- Изменение схемы БД — поле `precision_attempt_moves.classification String` остаётся; меняется только алгоритм его заполнения.
- Возврат к cp-loss для precision-score — категорически нет, ADR-065 закрыт.

## 2. Новая метрика per-move classification

### 2.1. Базовая формула

Та же, что в ADR-065 §2.1:

```
E_before = (wdl_before.w + wdl_before.d / 2) / 1000     # POV сделавшего ход
E_after  = (wdl_after.w  + wdl_after.d  / 2) / 1000     # POV того же игрока
loss_E   = max(0, E_before − E_after)                    # [0..1]
```

Где `wdl_before` / `wdl_after` — per-mille (0..1000), POV игрока, делающего ход. Хранятся в `precision_attempt_moves.wdl_before_w/d/l` и `wdl_after_w/d/l` (см. ADR-056 §3.2).

`loss_E` — потеря «expected score» за один ход, в диапазоне [0..1]. 0 = идеальный ход (или улучшение позиции, занулено по §2.2 ADR-065), 1 = катастрофа (полный переход от победы к поражению).

### 2.2. Override: точное совпадение с PV1

Если `playedUci === bestUci` (ход юзера = первое предложение движка) → classification = `best` **независимо** от вычисленного loss_E.

Обоснование (полностью наследуется из ADR-056 §2.5):
- PV1 — это объективно лучший ход в позиции по версии движка с конкретным depth/movetime.
- Иногда WDL-loss формально > 0 из-за numerical jitter Stockfish'а между depths — это шум, не качественная оценка.
- Игрок сыграл «как Stockfish» — пометить его ход как `inaccuracy` бессмысленно.

Это та же логика, что в `precisionVerdict.ts` (KS-2955) — `shouldFinishLose` не ставит lose если playedUci === bestUci.

### 2.3. Mate-катастрофа: специальный случай

Если ход подставил игрока под мат (`wdl_after.l > 950` per-mille — почти гарантированный проигрыш):
- classification = `blunder`, независимо от loss_E.

Если ход даёт мат сопернику (`wdl_after.w > 950`):
- classification = `best`, если иначе.

Обоснование: на границе мата WDL уже близок к [0,0,1000] или [1000,0,0], формула `accuracy_move` теряет точность (она калибрована на нормальные позиции). Mate-edge — это явный «outcome», ему соответствует чёткая классификация.

Аналог `move-classification.ts:113-118` в текущей cp-логике, переведённый на WDL.

## 3. Пороги WDL-loss

### 3.1. Точный расчёт через Lichess accuracy-формулу

Lichess формула: `accuracy_move = 103.1668 * exp(-0.04354 * loss_pct) − 3.1669`, где `loss_pct = loss_E * 100`.

Обратное преобразование: `loss_pct = -ln((accuracy + 3.1669) / 103.1668) / 0.04354`.

Точные значения для контрольных границ (расчёт через Python, см. §3.2):

| accuracy_move | loss_pct | loss_E |
|---|---|---|
| 99 | 0.22 | 0.0022 |
| 95 | 1.14 | 0.0114 |
| 90 | 2.34 | 0.0234 |
| 85 | 3.61 | 0.0361 |
| 80 | 4.95 | 0.0495 |
| 70 | 7.89 | 0.0789 |
| 60 | 11.27 | 0.1127 |
| 50 | 15.23 | 0.1523 |
| 40 | 20.01 | 0.2001 |
| 30 | 26.06 | 0.2606 |

### 3.2. Принятые пороги

```
best:        loss_E ≤ 0.02   (или playedUci === bestUci, или wdl_after.w > 950)
good:        0.02 < loss_E ≤ 0.05
inaccuracy:  0.05 < loss_E ≤ 0.12
mistake:     0.12 < loss_E ≤ 0.25
blunder:     loss_E > 0.25   (или wdl_after.l > 950)
```

В прямом переводе через формулу Lichess, эти границы дают `accuracy_move` точно:

| loss_E | accuracy_move | граница классификации |
|---|---|---|
| 0.02 | 91.40 | best ↔ good |
| 0.05 | 79.82 | good ↔ inaccuracy |
| 0.12 | 58.02 | inaccuracy ↔ mistake |
| 0.25 | 31.57 | mistake ↔ blunder |

### 3.3. Обоснование каждого порога

**`best`: loss_E ≤ 0.02 ⟺ accuracy_move ≥ 91.4%**

Логика:
- При WDL `100/0/0 → 100/0/0` (нулевая просадка) — это явно best. Покрыто `loss_E = 0 → accuracy = 100`.
- При WDL `90/8/2 → 88/8/4` (E_before=0.94, E_after=0.90, loss_E=0.04) — это уже good. Реально граница «best vs good» интуитивно лежит около «практически не упало», ≤ 2 п.п. в expected score — это «практически нуль».
- Lichess в `move-accuracy` рассматривает loss <2% как «отличный» ход. Наш порог 0.02 соответствует accuracy=91.4, что Lichess называет «very good» (90+).
- Альтернатива: ≤ 0.01 (соответствует accuracy=95.6). Это слишком жёстко: best должно покрывать «не идеальный, но близкий» ход. 0.02 — компромисс.

**`good`: 0.02 < loss_E ≤ 0.05 ⟺ 79.82 ≤ accuracy_move < 91.4**

Логика:
- Соответствует «accuracy 80-90», что Lichess относит к «good play».
- При loss_E = 0.04 (граница inaccuracy в координаторском расчёте) — accuracy = 83. Это middle club-уровень.
- ADR-065 §4 даёт диапазон 4★ = 85-94. Хороший ход (`good`) должен быть совместим с 4★, что и достигается этой границей: ход loss_E=0.04 — это accuracy ≈ 83.6, в одиночку 3★; в составе линии «5 best + 1 good» — итог 4★ (см. §5 контрольные кейсы).

**`inaccuracy`: 0.05 < loss_E ≤ 0.12 ⟺ 58.02 ≤ accuracy_move < 79.82**

Логика:
- Lichess `inaccuracy = ?!` примерно соответствует loss 5-10% — мы берём 5-12% для совместимости с нашими композитами.
- ADR-065 §4 диапазон 3★ = 70-84. Один inaccuracy на фоне идеальной игры даёт композит в этом диапазоне (см. §5 кейс 3).

**`mistake`: 0.12 < loss_E ≤ 0.25 ⟺ 31.57 ≤ accuracy_move < 58.02**

Логика:
- Lichess `mistake = ?` — loss 10-25%, мы берём 12-25%.
- ADR-065 §3.3 cap для mistake = 80% (max 3★). При loss_E=0.20 (середина mistake), один такой ход в линии «5 best + 1 mistake» даёт composite 75 (см. §5 кейс 5) → 3★, что соответствует cap'у.

**`blunder`: loss_E > 0.25 ⟺ accuracy_move < 31.57**

Логика:
- Lichess `blunder = ??` — loss > 25%. Прямой перенос.
- ADR-065 §3.3 cap для blunder = 60% (max 2★). При loss_E=0.30 в линии «5 best + 1 blunder» composite = 68 → cap → 60 → 2★ (см. §5 кейс 6).

### 3.4. Сравнение с cp-loss-порогами (информативно)

Текущие пороги cp-loss (`CP_LOSS_THRESHOLDS` в `move-classification.ts`): 0/30/90/220. Через Lichess `winPercent_cp` (ADR-065 §2.4.1) cp-loss переводится в loss_E:

```
winPercent_cp(cp) = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) − 1)
loss_E_approx ≈ |winPercent_cp(cpAfter) - winPercent_cp(cpBefore)| / 100
```

Для типичной стартовой позиции (`E_before ≈ 0.5`, нейтрально):

| cpLoss | соответствующий loss_E | старая категория | новая категория |
|---|---|---|---|
| 30 | ~0.05 (на границе) | good | good (граница) |
| 90 | ~0.15 | inaccuracy | mistake (!) |
| 220 | ~0.30 | mistake | blunder |

В нейтральных позициях новая шкала **жёстче** старой: ход с cpLoss=90 раньше был `inaccuracy`, теперь `mistake`. Это **намеренно** — Lichess использует именно эту шкалу WDL, и она сложнее (короче категории) на нейтральных позициях.

Однако: на крайних позициях (E ≈ 0 или E ≈ 1) новая шкала **мягче** (UX-bug решается):

| WDL_before → WDL_after | cpLoss approx | старая категория | новая категория |
|---|---|---|---|
| 100/0/0 → 100/0/0 | 200 (mate distance изменился) | mistake | **best** (loss_E=0) |
| 95/5/0 → 90/8/2 | 100 | inaccuracy | good (loss_E=0.04) |

Это и есть суть фикса.

## 4. Согласование с ADR-065 §3.3 caps

Каждой классификации соответствует диапазон `accuracy_move`, и через каждый класс — потенциальный звёздный исход:

| Classification | loss_E | accuracy_move | Одиночный ход на линии 5 best + 1 X → итог |
|---|---|---|---|
| best | ≤ 0.02 | ≥ 91.4 | mean=98.6, min=91.4, composite=96.4 → **★★★★★** |
| good | 0.02-0.05 | 79.8-91.4 | mean=97.0, min=83.6, composite=92.95 → **★★★★** |
| inaccuracy | 0.05-0.12 | 58.0-79.8 | mean=94.0, min=64.0, composite=85.0 → **★★★★** (граница) или **★★★** для худшего inacc |
| mistake | 0.12-0.25 | 31.6-58.0 | mean=90.6, min=43.0, composite=76.3 → **★★★** (cap 80 не активируется) |
| blunder | > 0.25 | < 31.6 | mean=87.5, min=24.8, composite=68.7 → cap=60 → **★★** |

Линейность сохраняется:
- best → 5★
- good → 4★ (с возможностью «вытянуть в 5★» если все ходы такие же)
- inaccuracy → 3-4★ (зависит от глубины)
- mistake → 3★ (cap гарантирует ≤ 3★ из-за §3.3 ADR-065)
- blunder → 2★ (cap гарантирует ≤ 2★)

Если все 6 ходов в линии — одной категории, итог:
- 6 best (accuracy=100) → composite=100 → 5★
- 6 good (loss_E=0.04, accuracy=83.6) → composite=83.6 → 3★ (граница к 4★ = 85)
- 6 inaccuracy (loss_E=0.08, accuracy=69.7) → composite=69.7 → 2★ (граница к 3★ = 70)
- 6 mistake (loss_E=0.20, accuracy=40) → composite=40, cap=80 не активируется → 1★
- 6 blunder (loss_E=0.30, accuracy=24.8) → composite=24.8, cap=60 не активируется → 1★

Это согласовано с интуицией: «6 inaccuracy подряд = плохая игра ≈ 2★»; «6 mistake = очень плохо = 1★».

## 5. Контрольные кейсы (обновление ADR-065 §4.3)

Кейсы из ADR-065 §4.3 пересчитаны под новые WDL-входы. Кейс 0 — repro UX-bug'а из задачи KS-3019:

| # | Сценарий | loss_E inputs | accuracies | classifications | mean | min | composite | cap | итог | звёзды |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | UX-bug repro: 6 best, WDL не меняется (100/0/0 → 100/0/0) | [0×6] | [100×6] | [best×6] | 100 | 100 | 100 | — | 100 | **★★★★★** |
| 1 | 6 best (точно PV1) | [0×6] | [100×6] | [best×6] | 100 | 100 | 100 | — | 100 | ★★★★★ |
| 2 | 5 best + 1 good (loss_E=0.03) | [0×5, 0.03] | [100×5, 87.37] | [best×5, good] | 97.9 | 87.37 | 94.74 | — | 94.74 | ★★★★ |
| 3 | 5 best + 1 mid-inaccuracy (loss_E=0.08) | [0×5, 0.08] | [100×5, 69.66] | [best×5, inacc] | 95.0 | 69.66 | 87.4 | — | 87.4 | ★★★★ |
| 3b | 5 best + 1 worst-inaccuracy (loss_E=0.12) | [0×5, 0.12] | [100×5, 58.02] | [best×5, inacc] | 93.0 | 58.02 | 82.5 | — | 82.5 | ★★★ |
| 4 | 4 best + 2 mid-inaccuracy | [0×4, 0.08, 0.08] | [100×4, 69.66×2] | [best×4, inacc×2] | 89.9 | 69.66 | 83.8 | — | 83.8 | ★★★ |
| 5 | 5 best + 1 mistake (loss_E=0.20) | [0×5, 0.20] | [100×5, 40.02] | [best×5, mistake] | 90.0 | 40.02 | 75.0 | min(., 80)=75.0 | 75.0 | ★★★ |
| 6 | 5 best + 1 blunder (loss_E=0.30) | [0×5, 0.30] | [100×5, 24.78] | [best×5, blunder] | 87.5 | 24.78 | 68.7 | min(., 60)=60 | 60 | ★★ |
| 7 | 9 best + 1 blunder | [0×9, 0.30] | [100×9, 24.78] | [best×9, blunder] | 92.5 | 24.78 | 72.2 | min(., 60)=60 | 60 | ★★ |
| 8 | 2 best + 2 blunder + 2 best | [0,0,0.30,0.30,0,0] | [100,100,24.78,24.78,100,100] | [best×2, blund×2, best×2] | 74.9 | 24.78 | 59.9 | min(., 60)=59.9 | 59.9 | ★★ |
| 9 | Длинная идеальная (12 best) | [0×12] | [100×12] | [best×12] | 100 | 100 | 100 | — | 100 | ★★★★★ |

### 5.1. Изменения от ADR-065 §4.3

Сравнение синтетических кейсов «до/после» унификации:

| # | ADR-065 (cp-based) кейс | ADR-066 (WDL-based) кейс | Дельта |
|---|---|---|---|
| 0 | (новый — repro) | **★★★★★** + classifications=[best×6] | **UX-bug решён** |
| 3 | 5 best + 1 inaccuracy → ★★★ | 5 best + 1 inaccuracy (loss_E=0.08) → ★★★★ | +1★ (т.к. accuracy=70 > старого «60») |
| 5 | 5 best + 1 mistake → ★★ | 5 best + 1 mistake (loss_E=0.20) → ★★★ | +1★ (т.к. accuracy=40 > старого «25») |
| 8 | 2 best + 2 blunder + 2 best → ★ | то же → ★★ (composite=59.9 в верхней зоне 2★) | +1★ |

Прочие кейсы (1, 2, 4, 6, 7, 9) — звёзды не изменились.

**Почему дельты не считаются регрессией:** в ADR-065 §4.3 кейсы использовали «приближённые» accuracy-значения (60 для inaccuracy, 25 для mistake, 5 для blunder), не связанные с конкретным loss_E. После унификации все числа точные. Семантическая суть кейсов сохранилась:
- «1 inaccuracy не должен опускать ниже 3★ обычно» — да (3-4★ в зависимости от глубины).
- «1 mistake опускает в 3★ через cap» — да.
- «1 blunder опускает в 2★ через cap» — да.
- «2 blunder + 4 best — серьёзный провал, 1-2★» — да (граничный 2★, что приемлемо).

Координатор и пользователь должны утвердить, что эти сдвиги допустимы.

## 6. Fallback для legacy без WDL

Сценарий: `precision_attempt_moves.wdl_before_w/d/l` или `wdl_after_w/d/l` = NULL.

### 6.1. Если есть cp

Используем формулу Lichess `winPercent_cp`:

```
winPercent_cp(cp) = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) − 1)
loss_E_approx     = max(0, (winPercent_cp(cp_before) − winPercent_cp(cp_after)) / 100)
classification    = classify_by_loss_E(loss_E_approx)
```

Это даёт **единую шкалу** для классификации — независимо от того, есть WDL или только cp. Согласовано с ADR-065 §2.4.1 (та же formula для fallback в score). Решение координатора в KS-3019 правое: единая шкала лучше двух раздельных fallback'ов.

### 6.2. Если нет ни WDL ни cp

Это означает, что движок вообще не вернул анализ. На практике в БД таких записей ~0% (ADR-056 §3.3 server-trust требует, чтобы `bestUci` был, а вместе с ним обычно есть и cp/wdl).

Для таких случаев classification = `good` (нейтральный fallback, не штрафуем игрока за провал движка). Аналог текущего `move-classification.ts:108-110`.

### 6.3. Если playedUci === bestUci

`best` — независимо от наличия WDL или cp. Override §2.2 работает всегда.

## 7. Backward compatibility

### 7.1. Что нужно пересчитать

`precision_attempt_moves.classification` — текст-поле, хранящее категорию. После релиза ADR-066 новые attempt'ы будут получать классификацию по новой шкале. Legacy attempt'ы — со старой (cp-loss).

Это **не приемлемо**: главная цель ADR-066 — устранить UX-противоречие. Если на странице legacy attempt'а юзер видит `?` (старая cp-mistake), но 5★ (старый WDL-score), баг остаётся.

**Делаем backfill** всех `precision_attempt_moves` + пересчёт агрегатов в `precision_attempts`.

### 7.2. Скрипт backfill

`apps/api/src/scripts/backfill-classification-wdl.ts`:

```
SELECT * FROM precision_attempt_moves ORDER BY attempt_id, ply
batch 100:
  для каждой записи:
    loss_E = compute(wdl_before, wdl_after)
              или fallback через cp (§6.1)
              или 'good' (§6.2)
    is_best_move = (playedUci === bestUci)
    new_class = classifyByLossE(loss_E, isBestMove=is_best_move, wdl_after=wdl_after)
    UPDATE precision_attempt_moves SET classification = new_class WHERE ...

  per-attempt aggregate recompute:
    SELECT classification, COUNT(*) FROM precision_attempt_moves WHERE attempt_id = ?
    UPDATE precision_attempts SET
      best_moves_count    = ?,
      good_moves_count    = ?,
      inaccuracies_count  = ?,
      mistakes_count      = ?,
      blunders_count      = ?,
      accuracy_percent    = (best + good) / total * 100,
      first_mistake_ply   = (минимальный ply с mistake|blunder, или NULL)
      WHERE attempt_id = ?
  sleep 100ms
```

Транзакция per-attempt (на 6-12 строк precision_attempt_moves), а не глобальная — иначе блокировки.

`score` / `scorePct` (новые поля из ADR-065 §6.1) пересчитывать не надо — они уже из WDL, классификация попадает в score только через worst-class cap, и пересчёт классификаций может в редких случаях изменить worst-class (например, бывший cp-mistake становится новой good → cap слабее). Скрипт **также пересчитывает score** для гарантии консистентности:

```
score, score_pct = computePrecisionScore(precision_attempt_moves of attempt)
UPDATE precision_attempts SET score = ?, score_pct = ? WHERE attempt_id = ?
```

Ожидаемая длительность: 100K attempts × (10ms per attempt classification + 10ms per attempt aggregate + 10ms per attempt score) = ~50 минут. Запускается через devops в ночное окно.

### 7.3. Влияние на `accuracyPercent` (ADR-056 §2.1)

`accuracyPercent = (best + good) / total * 100`. После backfill значение per-attempt может измениться:

- На нейтральных позициях шкала жёстче → cp-good с loss_E=0.04 теперь good (то же); cp-inaccuracy с loss_E=0.08 теперь inaccuracy (то же); cp-mistake с loss_E=0.15 теперь mistake (то же). Изменений мало.
- На крайних (выигранных) позициях шкала мягче → cp-mistake с loss_E=0 теперь best (повышение!). accuracyPercent **повысится** для таких attempts.

Эффект: на trend-графике `avgAccuracyPercent` (`PrecisionTrendsResponse`) — скачок вверх в день backfill'а. Размер скачка зависит от доли attempts в выигранных позициях; precision-задачи генерируются как «удержание преимущества», их большинство → ожидаем умеренный (5-15 п.п.) рост avgAccuracyPercent.

**UX-mitigation**: на trend-графике на дату backfill'а ставим vertical marker «методика классификации обновлена (ADR-066)». Тултип: «До этой даты ходы классифицировались по cp-loss, сейчас — по WDL-loss. На теоретически выигранных позициях accuracy выросла, поскольку сохранение преимущества теперь не считается ошибкой».

Реализация маркера — отдельный визуальный компонент на trend-графике, отдельный тикет (F1 в §8).

### 7.4. Влияние на `firstMistakePly`

`firstMistakePly` = 1-based ply первого mistake/blunder. После backfill эта позиция может сдвинуться или исчезнуть (cp-mistake на WDL-best). Корректно: пересчёт уже включён в §7.2 (`first_mistake_ply = (минимальный ply с mistake|blunder, или NULL)`).

Карточка «До первой ошибки» (ADR-056 §2.1, ADR-057) показывает `avgPlysToFirstMistake`. Тоже подскочит вверх на дату backfill'а.

## 8. План реализации

### Этап 1. Foundation

**B1. Обновить `move-classification.ts` в @kingside/shared.**
- Файлы: `packages/shared/src/utils/move-classification.ts`, `move-classification.test.ts`.
- Изменения:
  - Новая сигнатура `classifyMove(input)`: добавить поля `wdlBefore?: {w,d,l}`, `wdlAfter?: {w,d,l}` (per-mille). Старые `cpBefore`/`cpAfter`/`isBestMove` остаются.
  - Алгоритм: §2.1-§2.3 (WDL primary, cp fallback через winPercent_cp, override на isBestMove и mate-edge).
  - Новые константы `WDL_LOSS_THRESHOLDS = { best: 0.02, good: 0.05, inaccuracy: 0.12, mistake: 0.25 }`.
  - Старые `CP_LOSS_THRESHOLDS` пометить `@deprecated`, оставить в файле (для других legacy-usages, если найдутся; удаление — отдельный тикет).
- Тесты: §5 контрольные кейсы (11 штук) + edge-cases (mate-edge, both NULL, only cp).
- Acceptance: тесты проходят, типы консистентны.
- Labels: `puzzle`, `precision`, `analysis`, `tests`.

### Этап 2. Backend (← B1)

**B2. Серверный пересчёт classification при создании attempt — обновление.**
- Файлы: `apps/api/src/precision/precision.service.ts` (`createAttempt`-flow), `apps/api/src/puzzle/puzzle.service.ts`.
- Изменения: при формировании моментов передавать WDL в `classifyMove` (которое уже импортируется из shared). Поскольку shared-функция изменилась — backend автоматически переключится на новую логику; в коде precision.service / puzzle.service фактически меняется только сигнатура вызова (добавить wdlBefore/wdlAfter).
- Также: пересчёт агрегатов `bestMovesCount/...` и `accuracyPercent` через ту же функцию — теперь использует новую классификацию.
- Acceptance: snapshot-тесты на новый attempt с разными WDL-сценариями.
- Labels: `precision`, `puzzle`.

**B3. Скрипт бэкфила.**
- Файлы: `apps/api/src/scripts/backfill-classification-wdl.ts`.
- Логика: §7.2.
- Запуск: `npm run backfill:classification-wdl`.
- Acceptance: dry-run в dev-БД (например 100 случайных attempt'ов из staging-копии) даёт ожидаемый результат; SQL `SELECT classification, COUNT(*) FROM precision_attempt_moves GROUP BY classification` показывает новое распределение.
- Labels: `precision`, `puzzle`, `infra`.

**B4. Логи и аудит backfill.**
- Запись в `apps/api/src/scripts/` лог-файла: `backfill-classification-wdl-<date>.log` с метриками «до/после» по классификациям.
- Acceptance: лог содержит summary distribution до и после backfill, и количество affected attempt'ов.
- Labels: `precision`, `infra`.

### Этап 3. Frontend (← B2, B3)

**F1. Marker на trend-графике.**
- Файлы: `apps/web/src/pages/PrecisionTrendsPage.tsx` (или эквивалент после ADR-057).
- Vertical marker на дату backfill'а (передаётся через `MIGRATION_DATE` константу в shared или через API), тултип §7.3.
- Acceptance: marker рендерится, тултип читаем на RU/EN.
- Labels: `precision`, `i18n`.

**F2. i18n RU/EN для нового tooltip/marker и пояснений.**
- Файлы: `apps/web/public/locales/{ru,en}/precision.json`.
- Ключи: `precision.trends.classificationMigration.marker`, `precision.trends.classificationMigration.tooltip`.
- Acceptance: ESLint `i18next/no-literal-string` проходит.
- Labels: `precision`, `i18n`.

### Этап 4. QA (← Этап 3)

**Q1. Проверка UX-bug fix.**
- Сценарий: создать precision-задачу с теоретическим выигрышем (start WDL ~ 100/0/0), сыграть ходы которые сохраняют WDL → все ходы должны быть `best`, итог 5★, никаких NAG-меток `?` в разборе.
- Сценарий 2: создать задачу с loss_E ≈ 0.15 на одном ходе → этот ход помечен `mistake`, итог 3★ (или ниже composite-mean).
- Tests: e2e в `apps/e2e/`.
- Acceptance: оба сценария проходят.
- Labels: `precision`, `tests`.

**Q2. Backward-compat ручной чек.**
- Чек-лист: до backfill — legacy attempt показывает старые NAG; после backfill — те же attempts показывают новые NAG, score-плашка остаётся (потому что score уже на WDL).
- Acceptance: чек-лист пройден на staging.
- Labels: `precision`, `tests`.

**Q3. Backfill smoke на staging.**
- DevOps запускает B3 на staging-БД, проверяет:
  - SQL-distribution до/после.
  - Random sample 10 attempts — classifications соответствуют ожиданиям.
  - `avgAccuracyPercent` в `PrecisionStatsResponse` изменился в ожидаемом диапазоне.
- Acceptance: чек-лист пройден.
- Labels: `precision`, `tests`, `infra`.

### Порядок и параллельность

- Этап 1 (B1) — отдельно, ~0.5 дня.
- Этап 2 (B2, B3, B4) — после Этапа 1, последовательно (B2 → B3 → B4). ~1 день.
- Этап 3 (F1, F2) — параллельно с Этапом 2 после B1, ~0.5 дня.
- Этап 4 (Q1, Q2, Q3) — после Этапа 3 + B3, ~1 день.

Итоговая оценка: **3-4 рабочих дня** одного разработчика + 0.5 дня QA. Низкая сложность: алгоритмическая часть локальная (одна функция в shared), БД-изменений нет (только UPDATE), UI-изменений минимум (один marker).

## 9. Альтернативы

### 9.1. Оставить cp-loss для классификации, WDL для score

Status quo. UX-bug «5★ + NAG `?`» остаётся.

Pro:
- Нулевая работа.

Contra:
- Главная проблема не решена. Координатор явно ставит её как блокирующую.

**Отклонено.**

### 9.2. Гибрид: classification = max(cp-class, wdl-class)

Брать «худшую» из двух классификаций.

Pro:
- Учитывает обе шкалы.
- На крайних позициях cp-mistake не отменяется, если WDL не меняется.

Contra:
- **Не решает UX-bug**: на crash-cases (`100/0/0 → 100/0/0`) cp выдаст mistake, max(mistake, best) = mistake → ход всё ещё помечен `?`, при том что WDL-score = 5★. Так же конфликт.
- Гибрид усложняет код: две функции вместо одной. Поддержка двух шкал.

**Отклонено.**

### 9.3. Гибрид: classification = min(cp-class, wdl-class)

Брать «лучшую».

Pro:
- Решает UX-bug «100/0/0 → 100/0/0 = best».

Contra:
- Слишком прощающе на нейтральных позициях: ход с cp-blunder но мелким WDL-drop (например, в острой позиции 50/40/10 → 30/40/30, loss_E=0.10 → inaccuracy, но cp может улететь на -300 → blunder) станет «inaccuracy» вместо blunder.
- Семантически непонятно, по какой шкале классификация — раздражает аналитиков.

**Отклонено.**

### 9.4. Полный перенос на WDL (выбран)

Описан в §2-§7. Преимущества:
- Решает UX-bug в чистом виде.
- Единая шкала с precision-score.
- Совместимо с Lichess accuracy.
- Простая логика.

**Выбран.**

### 9.5. Динамические пороги (Lichess-style win% ratio)

Lichess в `Accuracy.scala` применяет дополнительный «std-dev weighting» к accuracy_move в зависимости от острых позиций. Можно сделать аналог для классификации: пороги зависят от текущего WDL distribution (в острых позициях — мягче).

Pro:
- Учитывает контекст.

Contra:
- Сложно реализовать, сложно тестировать.
- Для precision-задач (короткие, генерируются как «удержание») std-dev контекст слабо релевантен.
- Lichess weighted-avg для коротких партий вырождается (см. ADR-065 §3.1 отказ от Lichess weighted-avg).

**Отклонено как преждевременная оптимизация.** Может вернуться отдельным ADR, если фиксированные пороги не справятся (риск №2 §10).

### 9.6. Накат backfill «лениво» (при первом просмотре attempt'а)

Не делать массовый backfill — пересчитывать classification on-the-fly при чтении legacy attempt.

Pro:
- Нулевое окно backfill.

Contra:
- Двойные данные в БД (новая логика в коде, старые числа в БД) — каша.
- Trend-графики и агрегаты (`PrecisionStatsResponse._avg.accuracyPercent`) считаются прямо из `precision_attempts.accuracy_percent` — без пересчёта они показывают старые значения. Лень-расчёт не решает.
- Усложняет логику отображения.

**Отклонено**, делаем массовый backfill.

## 10. Риски

| # | Риск | Вероятность | Импакт | Mitigation |
|---|---|---|---|---|
| 1 | Backfill даёт распределение, которое не соответствует ожиданиям (например, 80% ходов становятся `best`, потому что precision-задачи генерируются из выигранных позиций, и WDL мало меняется) | средне | средне | Логи B4 фиксируют distribution до и после. Если итоговое «80% best» — координатор/архитектор пересматривает пороги §3.2 в одном следующем коммите; constants выделены в `WDL_LOSS_THRESHOLDS` для лёгкой правки |
| 2 | Пороги 0.02/0.05/0.12/0.25 калиброваны через Lichess, но Lichess-распределение — на live-партиях, не precision-задачах. Реальные precision-задачи могут перекосить распределение | средне | низко | Аналогично риску 1: после backfill анализируем фактическое распределение; пороги хранятся как именованные константы, легко скорректировать без миграций |
| 3 | На trend-графике скачок `avgAccuracyPercent` в день backfill — пользователь может подумать «приложение глючит» | высоко (системно) | низко | Marker §7.3 + тултип; в коммит-message + в i18n явное упоминание ADR-066 |
| 4 | Скрипт backfill (B3) падает посреди обработки → часть attempt'ов пересчитана, часть нет → каша | средне | средне | Транзакция per-attempt (§7.2), idempotent (повторный запуск пересчитает уже пересчитанное идентично); поле `migrated_at` (или просто компарирование старой/новой классификации) — отдельный тикет если понадобится для аудита |
| 5 | На странице конкретного legacy attempt'а после backfill `wdlLeakSum`, `firstMistakePly` могут не сойтись с UI («4-й ход — mistake», но `wdlLeakSum=0.5` слишком мало для mistake) | низко (т.к. оба пересчитываются) | низко | B3 пересчитывает агрегаты вместе с classifications, консистентность гарантирована скриптом |
| 6 | Migrate-day backfill длится 50 минут — пользовательские записи в это время не пишутся? | низко | низко | UPDATE атомарны, не блокирует чтение. INSERT/UPDATE новых attempt'ов идут параллельно — они уже используют новую логику (B2). Не блокирует runtime |
| 7 | Sync между shared-кодом (новые пороги) и БД (старые классификации до backfill) даёт inconsistency в окне «B2 задеплоен, B3 не выполнен» | средне | низко | Деплой-порядок: B2 (новый код) → немедленно B3 (backfill); окно — минуты. Альтернатива: запустить B3 до B2-деплоя на staging-копии, прогнать smoke (Q3), потом синхронно деплоить B2 + запускать B3 на проде |
| 8 | Контрольные кейсы §5 показывают расхождения с ADR-065 §4.3 (кейсы 3, 5, 8). Кому-то может не понравиться | низко | низко | §5.1 явно объясняет, почему расхождения — это починка приближённых чисел из ADR-065, не регрессия. Пользователь видит ADR на ревью |
| 9 | Логика classification для legacy записей без WDL и без cp (§6.2 = `good`) даёт «средне-хорошо» там, где реально нет данных. Юзер думает, что играл хорошо | очень низко (~0% записей) | низко | Только legacy, статистически невидимо. Текст-интерпретация attempt-страницы (ADR-065 §5.1.1) не учитывает classification — показывает score; classifications видны только в разборе ходов |
| 10 | После backfill пересчёт `score` (§7.2 финальный шаг) может в редких случаях понизить звезду существующему attempt (если бывший cp-best оказался WDL-mistake → новый cap=80 активируется → score падает с 5★ до 3★) | низко | средне | Скрипт логирует «attempts с изменением score» отдельно; пользователь увидит маркер ADR-066 на дату backfill и связь с потенциальным изменением; обратной совместимости в плане «фиксированный score forever» — нет, это методологический uplift |

## 11. Не входит в этот ADR

- Реализация (отдельные тикеты §8).
- Изменение формулы precision-score (ADR-065 остаётся).
- Динамические пороги (отдельный ADR при необходимости, см. §9.5).
- Перенос classifyMove на другие домены (analysis-сервис, etc.) — отдельный аудит и тикеты.
- UI-плашки на странице attempt'а «методика изменена» — только marker на trend, не на каждом attempt'е.
- Финальная калибровка порогов после анализа реального распределения — Этап 5 ADR-065 (A1) уже это покрывает, можно расширить scope A1.

## 12. Follow-up задачи

Координатор создаёт по этому ADR:

**Backend / shared:**
1. `puzzle`, `precision`, `analysis`, `tests` — обновить `move-classification.ts` в shared с новыми WDL-порогами и тестами (B1).
2. `precision`, `puzzle` — server-side compute использует новый shared, передаёт WDL в classifyMove (B2).
3. `precision`, `puzzle`, `infra` — backfill-скрипт classifications + aggregates + score (B3).
4. `precision`, `infra` — лог-файл с distribution до/после (B4).

**Frontend:**
5. `precision`, `i18n` — marker на trend-графике на дату backfill (F1).
6. `precision`, `i18n` — RU/EN ключи для marker (F2).

**QA:**
7. `precision`, `tests` — e2e на UX-bug fix (Q1).
8. `precision`, `tests` — backward-compat чек (Q2).
9. `precision`, `tests`, `infra` — staging backfill smoke (Q3).

Итого **9 follow-up задач**. Все зависимости — см. §8 «Порядок и параллельность».

## 13. Связь с другими ADR

- **ADR-056** §2.5 (cp-loss классификация) — этот ADR-066 **переопределяет** алгоритм. Старый текст ADR-056 не правится (исторический документ), но §2.5 фактически заменяется. В будущем при ссылке на ADR-056 §2.5 нужно сразу читать ADR-066.
- **ADR-065** §2.4.2 (classification-fallback таблица 5/25/55/80/95) — эта таблица для precision-score остаётся, потому что используется только когда нет ВООБЩЕ ничего (ни WDL ни cp ни нашего classifyMove). Кейс <0.01%.
- **ADR-065** §4.3 контрольные кейсы — формально остаются (synthetic numbers с точки зрения precision-score), но кейсы §5 этого ADR-066 — авторитетнее, потому что используют точные accuracy_move выведенные из WDL.
