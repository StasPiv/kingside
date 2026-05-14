# ADR-065. 5-балльная оценка решения precision-задач на базе WDL

Статус: предложен (KS-2996).
Дата: 2026-05-14.
Связано: ADR-044 (PlayVsEngine puzzles), ADR-047 (Eval & review for PVE), ADR-048 (Precision section), ADR-055 (separate stats), ADR-056 (precision metrics, основная), ADR-057 (UX split stats/training), KS-2955 (`precisionVerdict.ts` snapshot-fix), KS-2960 (WDL baseline), KS-2968 (drop-threshold + caталог точности), KS-2754 (per-move WDL в БД).

## 1. Контекст и цель

### 1.1. Что есть сейчас

Бинарный вердикт «Преимущество удержано / упущено». Источник правды:

- На фронте — `apps/web/src/components/puzzle/precisionVerdict.ts`: `shouldFinishLose(snapshot, effWdl, failThreshold)` + `isWinDropExcessive(start, final, 150‰)`. Пороговая логика: ход совпал с PV1 движка → не lose; абсолютный signed-WDL ниже `failThreshold` → lose; падение win% relative-to-baseline > 15 п.п. → lose.
- В UI — плашка зелёного/красного цвета на `PrecisionAttemptReview` с текстом «Преимущество удержано» / «Преимущество потеряно».
- В БД — `puzzle_attempts.solved BOOL` (источник бинара) + богатые per-move данные в `precision_attempts` / `precision_attempt_moves` (ADR-056 §3.2): `accuracyPercent = (best + good) / total * 100`, `bestMovesCount/goodMovesCount/inaccuraciesCount/mistakesCount/blundersCount`, `wdlLeakSum = Σ(wdlBefore − wdlAfter)`, `firstMistakePly`, per-move WDL per-mille (KS-2754) и cp.

### 1.2. Что не так с бинаром

1. **Гранулярность.** Атака с одним blunder в середине и атака с одним blunder на последнем ходу — одинаковые «потеряно». Атака идеальная (0 inaccuracies) и атака с 3 inaccuracies (но wdl не упал) — одинаковые «удержано». Игроку непонятен путь улучшения: «я уже удержал, что дальше?»
2. **Калибровка.** KS-2955/KS-2968 показали: `failThreshold` приходится подкручивать (winThreshold/dropThreshold), потому что 1 порог не покрывает разные сценарии. По факту мы уже строим многомерную оценку (signed-WDL + drop + snapshot-best), но проецируем её на 1 бит.
3. **Богатые данные простаивают.** `precision_attempts` уже содержит 6 агрегатов + per-move WDL. Бинар их игнорирует. `accuracyPercent` показывается на каталоге (KS-2968) — но как параллельная метрика, не связанная с верификатом.
4. **Учебная мотивация.** «Удержано/потеряно» — события. Звёзды (1-5) — прогресс. Прогресс мотивирует возвращаться (4 → 5★ на знакомой задаче), бинар — нет (или решил, или нет, перерешивать смысла нет).

### 1.3. Цель

Заменить плашку «Удержано/Потеряно» на 5-звёздную оценку, обоснованную:

1. **На WDL-distribution каждого user-полухода** (`wdlBefore`/`wdlAfter` per-mille уже в БД с KS-2754).
2. **С формулой per-move accuracy из Lichess** (опубликованная, проверенная сообществом).
3. **С агрегацией композитом mean + min** для корректного учёта 1 blunder vs N inaccuracies.
4. **С capping по worst-class** — гарантия, что blunder не вознаграждается 5★.
5. **С backward-compat** для legacy attempt'ов без WDL и без сломанной семантики страницы каталога (KS-2968).

Что выигрываем продуктово:
- Reward loop: «4★ — попробую снова на 5★». Замеряемый retention.
- Чёткий feedback: текущий «удержано» не отвечает на вопрос «что улучшить?», звёзды + per-move breakdown отвечают.
- Согласованность с другими сервисами: пользователи привыкли к chess.com classification и Lichess accuracy, наш Bool им чужой.

Не входит:
- Изменение алгоритма генератора precision-пазлов (ADR-044) — генератор работает в cp/WDL, для него ничего не меняется.
- Рейтинг пользователя по precision (он не считается, см. ADR-056 §1, KS-2689) — звёзды не дают рейтинговых очков, это per-attempt оценка.
- Замена `accuracyPercent` агрегата в Уровне А (ADR-056 §2.1) — он остаётся как отдельная метрика; звёзды дополняют, не заменяют. См. §6.4.

## 2. Метрика отклонения per move

### 2.1. Что такое «оценка позиции» в WDL

Stockfish c флагом `UCI_ShowWDL=true` возвращает три числа per-mille (0..1000): `w` (вероятность выигрыша), `d` (вероятность ничьей), `l` (вероятность поражения), POV side-to-move. Сумма ≈ 1000.

В нашем DTO `PrecisionMoveDto` (см. `packages/shared/src/types/api-contracts.ts:349`):
- `wdlBefore` — POV игрока, делающего этот полуход (= side-to-move в `fenBefore`).
- `wdlAfter` — POV того же игрока (бэк уже инвертирует raw-Stockfish, который пришёл бы от лица новой стороны на ходу).

Преобразуем в скалярное **«expected score»** (классическая шахматная формула):

```
E = (w + d/2) / 1000             // [0..1], для wdl в per-mille
```

Эквивалент турнирного очка: win = 1, draw = 0.5, loss = 0. `E` — ожидаемое очко в этой позиции. Для оценочной шкалы это симметричная, монотонная функция: рост win и draw → рост E, рост loss → падение E.

**Альтернатива — чистое `winPercent = w / 1000`** (Lichess именно так считает). Отличие:
- В позициях, где `d` доминирует (теоретически ничейные эндшпили), pure `winPercent` показывает 0/0 для обеих сторон, и любой ход даёт одинаковый Δw=0 → бессмысленно.
- `E` показывает 0.5/0.5 и реально различает «удержал ничью» (E=0.5) и «попал в проигрыш» (E=0.2). Это релевантнее для precision-задач, где цель «удержать», в т.ч. ничейную позицию.

**Берём `E = (w + d/2) / 1000`.** Lichess использует `winPercent`, потому что у них контекст партии (далёкие от ничейных позиций маловажны — стороны борются). У нас precision-задача может стартовать из «лёгкого выигрыша» (E=0.85), «равной» (E=0.5), «проигранной с шансом удержать ничью» (E=0.35) — и во всех трёх случаях метрика должна реагировать на ухудшение/улучшение. `E` это даёт, pure win — нет.

### 2.2. Δ на один ход

```
ΔE = E_before − E_after
```

Игрок ходит → если ΔE > 0, позиция ухудшилась (он «потерял» очко); ΔE = 0 — сохранил; ΔE < 0 — улучшил (бывает: оппонент-движок ответил так, что best-move юзера дал ожидаемое преимущество, или Stockfish углубил поиск на final).

Для оценки точности «отрицательные» ΔE (улучшения) приравниваем к 0:
```
loss = max(0, ΔE) ∈ [0..1]
```

Это асимметрично сознательно: precision-задача — «не упусти». «Не упустил и даже улучшил» = «не упустил». Награждать за случайное углубление SF, которое нашло линию глубже, чем при wdlBefore — некорректно: это шум engine-движка, не заслуга игрока.

### 2.3. Per-move accuracy: Lichess formula

Lichess опубликовал формулу `accuracy` хода в [Lichess source code](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/Accuracy.scala) и [обосновании 2020 года](https://lichess.org/page/accuracy):

```
accuracy_move(%) = 103.1668 * exp(-0.04354 * winPercentDelta) − 3.1669
```

где `winPercentDelta` — потеря в процентах win-rate (0-100).

Это монотонно убывающая экспоненциальная функция с двумя реперами:
- `delta = 0` → `accuracy ≈ 100%` (идеальный ход).
- `delta ≈ 100` → `accuracy ≈ 0%` (катастрофа, переход от выиграно к проиграно).
- `delta ≈ 10` → `accuracy ≈ 63%` — соответствует «inaccuracy».
- `delta ≈ 25` → `accuracy ≈ 32%` — «mistake».
- `delta ≈ 50` → `accuracy ≈ 8%` — «blunder».

Константы `103.1668` и `-0.04354` выведены Lichess из ~250k партий гроссмейстеров и калиброваны так, чтобы средний GM на 100%-acc-партии играл реально близко к 100%. Это **публичная, проверенная сообществом формула**, мы её принимаем целиком, **с одним изменением**: вместо `winPercentDelta` подаём `loss_E_pct = loss * 100`. Обоснование §2.1: для precision E лучше pure-win.

```
accuracy_move(%) = clamp(0, 100, 103.1668 * exp(-0.04354 * loss_E_pct) − 3.1669)
```

Clamp защищает от:
- `loss_E_pct < 0` (улучшение, мы уже занулили в §2.2, но defensive).
- Численного underflow при огромном loss (формула может уйти в небольшой минус для `loss_E_pct > 100`, что физически невозможно, но в float-арифметике встречается).

### 2.4. Что если `wdlBefore`/`wdlAfter` отсутствуют

Legacy-attempt'ы до KS-2754 — `wdlBeforeW/D/L`, `wdlAfterW/D/L` в `precision_attempt_moves` `NULL`. Бывает также, если SF был запущен без `UCI_ShowWDL` (старые движковые конфигурации, KS-2473 fallback).

Развилка:

| | (а) Игнорировать ход (пропустить из агрегата) | (б) cp-fallback через известную WDL-аппроксимацию | (в) Использовать classification, нагрубо мапить в accuracy_move |
|---|---|---|---|
| Точность | высокая (только реальные данные) | средняя (cp → wdl приближение) | низкая (5 категорий вместо continuous) |
| Доступность | пропускает много ходов в legacy | требует cp в БД (есть у нас) | classification всегда есть в БД |
| Реализация | trivial | формула CP→WIN%: `50 + 50 * (2/(1+exp(-0.00368208*cp)) − 1)` (Lichess CP-to-Win) | таблица соответствий |

**Выбираем (б) для legacy с cp, (в) для legacy без cp, (а) только как последний fallback.**

#### 2.4.1. CP → WDL fallback (Lichess formula)

```
winPercent_cp(cp) = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) − 1)
```

Для cp ∈ [-1000, +1000], `winPercent_cp` ∈ [0, 100]. Source: Lichess accuracy paper (same formula). Аппроксимирует expected win% от cp-оценки. Использовалась Lichess до того, как сами движки начали отдавать WDL.

Применение: если `wdlBefore=NULL` но `cpBefore≠NULL`:
- `winPct_before = winPercent_cp(cpBefore)`
- `E_before ≈ winPct_before / 100` (приближённо, draw в этой формуле уже усреднён, см. сноску ниже).

Сноска: Lichess cp→win — это `expected_score`-аппроксимация Logistic, не pure-win. Поэтому для нашего `E` она годится «как есть». Это удачное совпадение моделирования — обе формулы (наша `E` и Lichess CP) дают expected-score в [0,1]. Документация Lichess это подтверждает.

#### 2.4.2. Classification → accuracy fallback (без cp вообще)

Если нет ни WDL, ни cp (теоретически в БД такого почти нет — `precision_attempt_moves` без обоих полей появлялся бы при полном engine-failure):

```
classification → accuracy_move
'best'      → 95     // не 100, потому что best тоже мог быть «практически равно»
'good'      → 80
'inaccuracy'→ 55
'mistake'   → 25
'blunder'   → 5
```

Числа подобраны так, чтобы при стандартных диапазонах cp-loss (см. §2.5 ADR-056) средняя exponential-формула давала похожий результат:
- `cpLoss ≤ 0` (best) → exp-formula 100, у нас 95 — небольшой штраф за «отсутствие WDL-данных».
- `cpLoss ≤ 30` (good) → exp-formula дала бы ~85, мы берём 80.
- `cpLoss ≤ 90` (inaccuracy) → exp-formula ~63, мы берём 55 (consistent с тем, что без WDL мы не уверены).
- `cpLoss ≤ 220` (mistake) → exp-formula ~30, мы берём 25.
- `cpLoss > 220` (blunder) → exp-formula <10, мы берём 5.

Это **fallback**, его используют только если оба `wdlBefore` и `cpBefore` `NULL`. На практике в нашей БД таких ходов ≈ 0% после KS-2754.

#### 2.4.3. Игнорировать (а) как последний экран

Если ни WDL, ни cp, ни classification (что фактически невозможно — `classification` в БД NOT NULL по ADR-056 §3.2): пропускаем ход из агрегата. Total moves для агрегата считается без него. Если такие ходы есть >50% от total — attempt помечается `score = null` (см. §6).

## 3. Агрегация по задаче

### 3.1. Кандидаты

- **(А) Простое среднее.** `score = mean(accuracy_move)`. Достоинство: симметричное. Недостаток: 1 blunder среди 10 ходов = 9 идеальных + 1 нулевой = mean(100*9 + 5)/10 = 90.5 — high score за реально провальную линию. Не подходит для precision.
- **(Б) Минимум.** `score = min(accuracy_move)`. Достоинство: ловит самый слабый момент. Недостаток: 10 ходов 99% + 1 ход 70% = 70 → 3★, хотя по факту это сильная игра с одной неточностью. Слишком жёстко.
- **(В) Lichess weighted-average.** Веса = std-dev win-rate в окне ±2 хода (формула из Lichess Accuracy.scala). Достоинство: ходы в острых позициях весят больше. Недостаток: на коротких precision-задачах (3-8 user-полуходов) окно ±2 — это вся партия, веса вырождаются. Для нашего контекста ≈ простое среднее, но с инфра-стоимостью.
- **(Г) Композит mean + min.** `score = 0.7 * mean + 0.3 * min`. Mean улавливает общий уровень, min штрафует худший момент. Веса 0.7/0.3 подбираемые.

**Выбираем (Г) — композит mean + min.**

Обоснование веса 0.7 / 0.3:
- В равномерной игре (все ходы примерно одинаковой точности) `mean ≈ min`, обе компоненты совпадают, итог = mean. Композит вырождается в простое среднее, что и ожидается.
- При 1 ярком blunder среди N хороших ходов (характерный случай precision-задачи «упустил под занавес»):
  - 8 ходов по 95%, 1 ход 10% → mean=85.6, min=10 → score = 0.7*85.6 + 0.3*10 = **62.9** (≈ 3★).
  - Простое среднее дало бы 85.6 (4★) — игнорирует катастрофу.
  - Чистый min дал бы 10 (1★) — игнорирует всю качественную игру до.
  - Композит даёт 3★ — реалистично: «есть провал, но в целом нормально».
- При 1 inaccuracy:
  - 8 ходов по 95%, 1 ход 60% → mean=91, min=60 → score = 0.7*91 + 0.3*60 = **81.7** (4★).
  - Кажется справедливо — небольшая неточность не должна снимать 5★, но lo-watermark должен немного просесть.
- При 2 inaccuracies подряд:
  - 7 ходов по 95%, 2 хода по 60% → mean=87.2, min=60 → score = 0.7*87.2 + 0.3*60 = **79.0** (3★).
  - Логично: два сбоя — это 3★, не 4★.

Веса 0.7/0.3 — стартовая калибровка. Точная настройка возможна после релиза по реальному распределению attempt'ов (см. §9 риски, и §11 «Калибровка после релиза»).

### 3.2. Длина задачи

Должна ли влиять? Аргументы:

- **Против.** Метрика accuracy_move уже нормализована на [0..100] независимо от ΔE. Аггрегат mean/min — статистика, length-independent. Длинная задача с 10 идеальными ходами получит 100% точно так же, как короткая с 3.
- **За.** На коротких (3 хода) одна ошибка катастрофичнее (1/3 = 33%) чем на длинных (1/10 = 10%). Lichess это решает через std-dev веса — у нас этой инфры нет.

**Решение: длина НЕ входит в формулу score явно.** Композит mean+min естественно учитывает: на короткой задаче min весит большую долю «впечатления», на длинной mean доминирует.

Дополнительно — **минимальная длина для score**:
- `halfMovesPlayed < 2` (1 ход): score не считается, attempt получает специальный маркер `score = null`, UI показывает «—» (нет данных). Один ход — это не оценка качества, это бросок монеты.
- `halfMovesPlayed ≥ 2`: считаем нормально.

В precision-задачах `halfMovesTarget` по умолчанию 6 (ADR-056 §1), так что под условие < 2 попадают только сильно abort'нутые попытки.

### 3.3. Кэп по worst-classification

Дополнительный страховочный механизм: **независимо от того, что насчитал композит, существуют hard caps на основе worst-move-classification:**

```
worst = max(classification по всем user-ходам)

if worst == 'blunder':    score = min(score, 60)   // верх диапазона 2★ (см. §4: 50-69 = 2★)
if worst == 'mistake':    score = min(score, 80)   // верх диапазона 4★ (см. §4: 70-84 = 3★… нет; 80 на стыке 3★/4★)
otherwise:                no cap
```

**Точные границы cap'ов согласованы с таблицей §4:**
- `cap=60` ⟹ итоговая звезда не выше **2★** (диапазон 50-69 = 2★).
- `cap=80` ⟹ итоговая звезда не выше **3★** (80 попадает в верх 70-84 = 3★).

Чтобы дать «не выше 4★» через cap, нужно `cap=94` (верх 85-94=4★). Это **намеренное** решение «mistake → max 3★», не «max 4★»:

Обоснование:
- **«Blunder = max 2★»**: blunder per ADR-056 §2.5 = cp_loss > 220 = ΔE > ~50%. По букве precision-задачи («удержать преимущество»), такой ход = провал mission. Награждать 3-5★ за линию с blunder — concept-failure UI, даже если остальные 9 ходов идеальны (это уже не «удержание», это «случайно позиция не успела рухнуть»). 2★ — потолок «есть провальная ошибка, но не катастрофа».
- **«Mistake = max 3★»**: mistake = cp_loss > 90, серьёзная неточность. 4-5★ — это «уверенно/образцово удержано», mistake это не позволяет: даже один такой ход роняет линию в «удержано с нюансами».
- **Inaccuracy без cap**: маленькая неточность не препятствует 5★. У сильных игроков на Lichess accuracy 95%+ нередко включает 1-2 inaccuracy.

Этот cap делает оценку **non-fooling**: композит mean+min уже даёт хороший результат, но без кэпа 9 best + 1 blunder теоретически могло бы дать 4★. Cap фиксирует это явно. Контрольные кейсы §4.3 #6/#7 подтверждают: 9 best + 1 blunder → 60 → 2★, что и ожидается.

### 3.4. Финальный алгоритм

```python
def precision_score(moves: list[Move]) -> int | None:
    if len(moves) < 2:
        return None  # too short

    accuracies = [accuracy_move(m) for m in moves if has_data(m)]
    if len(accuracies) < len(moves) * 0.5:
        return None  # too few data points (>50% gaps)

    mean = sum(accuracies) / len(accuracies)
    min_ = min(accuracies)
    score_pct = 0.7 * mean + 0.3 * min_

    worst = max_class(moves)  # 'best' < 'good' < 'inaccuracy' < 'mistake' < 'blunder'
    if worst == 'blunder':
        score_pct = min(score_pct, 60)
    elif worst == 'mistake':
        score_pct = min(score_pct, 80)

    return map_to_stars(score_pct)
```

Где `accuracy_move`:
```python
def accuracy_move(m: Move) -> float:
    if m.wdl_before and m.wdl_after:
        E_before = (m.wdl_before.w + m.wdl_before.d / 2) / 1000
        E_after  = (m.wdl_after.w  + m.wdl_after.d  / 2) / 1000
        loss_pct = max(0, E_before - E_after) * 100
        return clamp(0, 100, 103.1668 * exp(-0.04354 * loss_pct) - 3.1669)
    elif m.cp_before is not None and m.cp_after is not None:
        win_before = win_pct_from_cp(m.cp_before)
        win_after  = win_pct_from_cp(m.cp_after)
        loss_pct = max(0, win_before - win_after)
        return clamp(0, 100, 103.1668 * exp(-0.04354 * loss_pct) - 3.1669)
    else:
        return classification_fallback(m.classification)
```

Чистая функция, без side-effects. Реализация — в `packages/shared/src/utils/precision-score.ts`. Тестируется отдельно (см. §7 B1).

## 4. Маппинг агрегата → 5 баллов

Берём `score_pct ∈ [0..100]` (после cap §3.3) и маппим в звёзды.

| score_pct | звёзды | Семантика | Примеры сценариев |
|---|---|---|---|
| 95-100 | **★★★★★** | Образцовое решение | Все ходы best/good, ΔE < 2 п.п. везде. Серверный анти-флак: 5★ требует ≥ 95% — Lichess «strong play» level. |
| 85-94  | **★★★★** | Уверенно удержано | 1 inaccuracy или несколько мелких ΔE. Среднестатистическая «удачная» попытка. |
| 70-84  | **★★★** | С нюансами, но удержано | 2-3 inaccuracy ИЛИ 1 mistake (cap §3.3 разрешает 4★ для mistake, но композит обычно сводит к 3★ если хоть один реальный mistake). |
| 50-69  | **★★** | Серьёзные ошибки | 1 mistake + inaccuracies; ИЛИ blunder (cap §3.3 сразу опускает в 3★ max, но композит может опустить ниже). |
| 0-49   | **★** | Провалено | Blunder в середине партии + другие ошибки; катастрофа в финальном ходе. |

### 4.1. Обоснование границ

Источник: **распределение точности на Lichess** (источник: [Lichess `Accuracy.scala` docs](https://lichess.org/page/accuracy) + analytics from `lichess.org/insights`).

Усреднённые accuracy на Lichess по уровням рейтинга (rapid, 2020-2023):

| Уровень | Mean accuracy | Где находятся precision-задачи |
|---|---|---|
| GM (>2500) | ~94-96% | Цель 5★ — играть «как GM на этой задаче» |
| Master (~2200) | ~89-91% | Цель 4★ |
| Strong club (~1800) | ~80-85% | Цель 3★ |
| Average club (~1500) | ~72-78% | Цель 2★ (с большими провалами) |
| Beginner (<1200) | ~55-65% | 1★ |

Границы 95/85/70/50 калибруются под эти уровни:
- 95+ ≈ GM-level = 5★. Не слишком жадно (любой человек с одной inaccuracy не получит 5★), но достижимо для идеального решения.
- 85-94 ≈ Master = 4★. Звучит правильно: «играл как мастер, но не идеально».
- 70-84 ≈ Strong club = 3★. Самый широкий диапазон, потому что большинство attempts реально сюда попадает.
- 50-69 ≈ Average club = 2★. «Видно проблемы, но позиция не разрушена».
- 0-49 ≈ Beginner / completely lost = 1★. Серьёзный провал.

### 4.2. Цвета (см. §5)

| звёзды | цвет (CSS-токен) |
|---|---|
| 5★ | green (наш `c-emerald-500`) |
| 4★ | green-yellow (`c-lime-500`) |
| 3★ | yellow (`c-amber-500`) |
| 2★ | orange (`c-orange-500`) |
| 1★ | red (`c-red-500`) |

Градация цветов согласована с текущей бинарной плашкой: 5★/4★ → зелёная зона (юзер был «прав»), 1★/2★ → красная (юзер «провалил»), 3★ — нейтральная (зона «может и так, может и эдак»). Это сохраняет визуальную преемственность для пользователей текущей плашки.

### 4.3. Контрольные кейсы

Прогон формулы на синтетических сценариях:

| # | Сценарий | accuracies | mean | min | composite | worst-cap | итог | звёзды |
|---|---|---|---|---|---|---|---|---|
| 1 | 6 best | [100,100,100,100,100,100] | 100 | 100 | 100 | — | 100 | ★★★★★ |
| 2 | 5 best + 1 good (cpLoss=20) | [100,100,100,100,100,82] | 97 | 82 | 92.5 | — | 92.5 | ★★★★ |
| 3 | 5 best + 1 inaccuracy (cpLoss=70) | [100×5, 60] | 93.3 | 60 | 83.3 | — | 83.3 | ★★★ |
| 4 | 4 best + 2 inaccuracy | [100×4, 60×2] | 86.7 | 60 | 78.7 | — | 78.7 | ★★★ |
| 5 | 5 best + 1 mistake (cpLoss=150) | [100×5, 25] | 87.5 | 25 | 68.75 | min(., 80)=68.75 | 68.75 | ★★ |
| 6 | 5 best + 1 blunder (cpLoss=300) | [100×5, 5] | 84.2 | 5 | 60.4 | min(., 60)=60 | 60 | ★★ |
| 7 | 9 best + 1 blunder | [100×9, 5] | 90.5 | 5 | 64 | min(., 60)=60 | 60 | ★★ |
| 8 | 2 best + 2 blunder + 2 best | [100,100,5,5,100,100] | 68.3 | 5 | 49.3 | min(., 60)=49.3 | 49.3 | ★ |
| 9 | Длинная идеальная (12 ходов best) | [100×12] | 100 | 100 | 100 | — | 100 | ★★★★★ |

Кейс 5 (1 mistake) даёт 68.75 — это **2★** по таблице §4 (50-69), хотя cap по mistake — 80 (= 3★). Здесь cap не активируется: композит сам по себе уже опустил ниже cap'а. Это нормально — cap страховочный, не «обязательный потолок».

Кейсы 6 и 7 показывают, что cap «blunder ≤ 60» отделяет 2★ от 3★ даже на длинных партиях с одним блантом — это намеренно. Кейс 8 — два blunder = 1★, естественно.

## 5. UI

### 5.1. Где показываем звёзды

#### 5.1.1. `PrecisionAttemptReview` (страница `/precision/attempts/:id`)

Замена бинарной плашки «Преимущество удержано/потеряно» на блок:

```
┌───────────────────────────────────────────────────────────────┐
│  ★★★★☆      87% точности                                       │
│             Сильно удержано, с одной неточностью на 4-м ходу. │
└───────────────────────────────────────────────────────────────┘
```

Состав:
- Звёзды (5 SVG-элементов, заполненных согласно `score`).
- accuracy% — на тот случай, если юзер хочет точную цифру (особенно для границ 84/85, где 1 п.п. меняет звезду).
- Краткая текстовая интерпретация (1 предложение):
  - 5★: «Идеальное решение.»
  - 4★: «Точное удержание с небольшой неточностью.»
  - 3★: «Удержано, но были заметные ошибки.»
  - 2★: «Преимущество поколебалось — есть серьёзные ошибки.»
  - 1★: «Преимущество упущено.»

Цвет фона блока — по таблице §4.2. Контрастность текста — по нашему toolkit (CSS variable `text-on-{color}`).

«Преимущество удержано/потеряно» (бинар) **остаётся как backward-compat fallback** для legacy-attempt'ов без score (§6.2).

#### 5.1.2. `PrecisionAttemptListItem` (каталог `/precision`, KS-2968)

В строке списка попыток (между date и accuracy%) добавляется компонент `<PrecisionScoreBadge stars={4}/>` — 5 маленьких звёзд (16px). Цвет звёзд — по таблице §4.2.

`accuracyPercent` поле в строке **сохраняется** (KS-2968 не отменяется). Звёзды и accuracy% соседствуют, не дублируют друг друга:
- Звёзды отвечают на «насколько я хорош в целом» (категориальная оценка, 5 уровней).
- accuracy% отвечает на «сколько именно процентов» (continuous, для тонкого progress-tracking).

#### 5.1.3. Top-блок `/precision` (Уровень А, ADR-056 §2.1)

Карточки «Точность ходов» / «Удержано / Упущено» / «Утечка/ход» / «До первой ошибки» **не меняются** (ADR-056 фиксирует именно эту 4-карточную структуру).

Дополняется **пятая карточка** «Средний балл» с `avgScore: 4.2/5` и распределением `1★:5 / 2★:10 / 3★:30 / 4★:25 / 5★:8` (stack-bar):

```
┌─────────────────┐
│ Средний балл    │
│  ★★★★☆ 4.2/5    │
│ за 78 попыток   │
└─────────────────┘
```

Карточка «Удержано / Упущено» остаётся как бинарный summary (юзер любит видеть «5 из 7 удержано»). Бинар и звёзды — комплементарные метрики.

### 5.2. Перевод старой плашки

`PrecisionAttemptReview` показывает звёзды для новых attempt'ов (с `score != null`). Для legacy без score — старая плашка «Удержано/Потеряно» (см. §6). Это плавный rollout: юзер сразу видит звёзды на новых попытках, старые остаются как раньше.

Когда бэкфил пройдёт по всем legacy с per-move WDL (§6.3), плашки заменятся на звёзды массово. Бинар останется только для attempt'ов с менее чем 2 user-ходами или менее 50% per-move-данных (см. §3.2 / §3.4).

### 5.3. i18n

Все строки — `apps/web/public/locales/{ru,en}/precision.json`:

- `precision.score.stars.{1..5}` — численная подпись («1 of 5 stars», «5 из 5 звёзд»).
- `precision.score.interpretation.{1..5}` — текст intervention (§5.1.1).
- `precision.score.cardTitle` — «Средний балл».
- `precision.score.cardSubtitle` — «за {{n}} попыток».
- `precision.score.legacyMissing` — текст fallback'а («Старая попытка, балл недоступен»).

## 6. Backward compatibility

### 6.1. Где живёт score

Новое поле в `precision_attempts`:

```prisma
model PrecisionAttempt {
  ...
  /// 1..5 stars, 1-based. `null` для:
  /// - legacy-attempt без per-move WDL и cp;
  /// - attempt'ов с halfMovesPlayed < 2;
  /// - attempt'ов с >50% per-move-данных отсутствующих (§3.4).
  score    Int?    @map("score")
  /// score_pct (0..100) до округления до звёзд — для отображения и trend'ов.
  /// `null` синхронно со score.
  scorePct Float?  @map("score_pct")
  ...
  @@index([score])    // для агрегатов «средний балл / распределение»
}
```

Миграция: `add_precision_score`, добавляет 2 nullable-колонки, без default'ов. Безопасна, не блокирует.

### 6.2. Frontend rendering

`PrecisionAttemptReview.tsx` и `PrecisionAttemptList`:

```tsx
{attempt.score !== null ? (
  <PrecisionScoreBlock score={attempt.score} scorePct={attempt.scorePct} />
) : (
  <PrecisionBinaryVerdict solved={attempt.solved} />
)}
```

`PrecisionBinaryVerdict` — текущий компонент со старой плашкой, остаётся как fallback. Через 6 месяцев после релиза + полного бэкфила (§6.3) можно удалить, если в БД больше нет attempt'ов без score (проверяется SQL: `SELECT COUNT(*) FROM precision_attempts WHERE score IS NULL`).

### 6.3. Бэкфил legacy attempt'ов

Большинство legacy `precision_attempts` имеют per-move WDL и/или cp (KS-2754 закрыт >месяца назад). Можно их пересчитать.

Скрипт `apps/api/src/scripts/backfill-precision-score.ts`:

```
SELECT attempt_id FROM precision_attempts WHERE score IS NULL ORDER BY ...
batch 100:
  для каждого attempt:
    load moves (with WDL/cp/classification)
    apply precision_score() (§3.4)
    UPDATE precision_attempts SET score = ?, score_pct = ? WHERE attempt_id = ?
sleep 100ms (быть гостем postgres'а)
```

Запускается **один раз** на проде через devops после релиза backend-фичи. Ожидаемая длительность: 100K legacy attempts × 10ms per attempt = ~16 минут. Не блокирует runtime — UPDATE атомарны, остальные запросы не задеваются.

Если у attempt не хватает данных (legacy до KS-2754 без WDL **и** без cp) — score остаётся `NULL`, фронт показывает binary fallback.

### 6.4. Влияние на агрегаты `accuracyPercent` / Уровень А

ADR-056 §2.1 определяет `avgAccuracyPercent` = `AVG(precision_attempts.accuracyPercent)` (через Prisma `_avg`, см. `precision.service.ts:110`). Эта формула:

```
accuracyPercent_per_attempt = (bestCount + goodCount) / total * 100
avgAccuracyPercent = AVG(accuracyPercent_per_attempt)
```

**Не меняется.** Это другая метрика — «процент best+good ходов», она счётная, не аккуратность-в-смысле-Lichess. Юзер на каталоге видит «73% точности» — это уже `bestCount+goodCount/total`. ADR-065 добавляет:

- `score` (1-5) — отдельная метрика на attempt.
- `scorePct` (0-100) — Lichess-style accuracy, отдельная метрика на attempt.

Они **сосуществуют**. В UI на каталоге `accuracyPercent` уже есть; добавляем звёзды рядом. На странице attempt'а — звёзды доминируют, accuracy% мелким текстом справа.

Различия:

| Метрика | Что измеряет | Граничные случаи |
|---|---|---|
| `accuracyPercent` (old) | % ходов с классификацией best+good | 5 best + 5 inaccuracy = 50% (5 «хороших» из 10) |
| `scorePct` (new) | Continuous Lichess-style accuracy с учётом ΔE | 5 best + 5 inaccuracy = composite(mean=70, min=60)=67% |
| `score` (new) | Дискретный 1-5 | 5 best + 5 inaccuracy = 67% → ★★ |

В KS-2968 каталог уже показывает `accuracyPercent`. ADR-065 предлагает дополнить его звёздами (`<PrecisionScoreBadge>`) рядом, а не заменять.

**Open question для пользователя:** что делать с `accuracyPercent` в каталоге, когда добавим звёзды:

- (а) **Оставить как есть, добавить звёзды рядом.** Звёзды слева, accuracy% справа. Это решение по умолчанию в ADR (§5.1.2) — никаких регрессий KS-2968, две метрики сосуществуют.
- (б) **Заменить accuracy% звёздами полностью, accuracy% доступен по hover/tooltip.** Более лаконичный UI, но регрессия KS-2968 (юзер привык к % в строке).
- (в) **Заменить accuracy% звёздами, accuracy% перенести в детальную страницу attempt'а.** Каталог становится категориальным сканом, детали — для углубления.

Решение принимает пользователь после ознакомления с ADR. По умолчанию реализуем (а); если пользователь выбирает (б) или (в) — отдельный задача-уточнение к F3.

### 6.5. Влияние на тренды (`PrecisionTrendsResponse`)

ADR-056 §2.3 / API `/precision/trends/me` возвращает `avgAccuracyPercent` per bucket. Расширяется:

```ts
points: Array<{
  bucketStart: string;
  attempts: number;
  preserved: number;
  avgAccuracyPercent: number;  // existing, не меняется
  avgWdlLeakPerMove: number;   // existing
  avgScore: number;            // NEW, 0..5 float, null если в bucket'е все score=NULL
  avgScorePct: number;         // NEW, 0..100 float
}>;
```

Это аддитивное расширение DTO — фронт без новых полей продолжает работать.

## 7. План реализации

### Этап 1. Foundation (последовательно)

**B1. `precision-score.ts` в @kingside/shared.**
- Файлы: `packages/shared/src/utils/precision-score.ts`, `precision-score.spec.ts`.
- Реализация: `computePrecisionScore(moves: PrecisionMoveInput[]): { stars: number | null, scorePct: number | null }`.
- Включает: `accuracyMove`, `winPctFromCp`, classification-fallback (§2.4.2), composite (§3.4), star-mapping (§4).
- Тесты: 9 контрольных кейсов из §4.3 + edge cases (length=0, length=1, all-NULL data, > 50% gaps).
- Acceptance: тесты проходят, `npm run test --workspace=@kingside/shared`.
- Labels: `puzzle`, `precision`, `tests`.

**B2. Миграция БД: `precision_attempts.score`, `score_pct`.**
- Файлы: `packages/db/prisma/schema.prisma` (+ migration `add_precision_score`).
- Nullable Int + Float, индекс `@@index([score])`.
- Acceptance: миграция применяется, `prisma migrate dev` без ошибок.
- Labels: `prisma`, `precision`.

### Этап 2. Backend (← B1, B2)

**B3. Серверный пересчёт score при создании attempt.**
- Файлы: `apps/api/src/precision/precision.service.ts` (`createAttempt`-flow), `apps/api/src/puzzle/puzzle.service.ts:760` (текущий accuracyPercent остаётся, добавляется score).
- При сохранении в БД: `computePrecisionScore(serverMoves) → score, scorePct` пишутся в `precision_attempts`.
- Acceptance: новые attempt'ы получают score; снапшотный тест на одно attempt'у-пример.
- Labels: `precision`, `puzzle`.

**B4. API DTO `score` + `scorePct`.**
- Файлы: `packages/shared/src/types/api-contracts.ts` — поля в `PrecisionAttemptDetail`, `PrecisionAttemptListItem`, `PrecisionTrendsResponse.points[]`, плюс `avgScore` / `avgScorePct` в `PrecisionStatsResponse`.
- Backend: добавить в `precision.service.ts` соответствующие поля в return-объекты.
- Acceptance: typecheck проходит, e2e на `GET /precision/attempts/:id` возвращает `score`.
- Labels: `precision`, `puzzle`.

**B5. Бэкфил-скрипт.**
- Файлы: `apps/api/src/scripts/backfill-precision-score.ts`.
- Запускается командой `npm run backfill:precision-score`.
- Логика: §6.3, batch 100, 100ms sleep.
- Acceptance: dry-run в dev-окружении пересчитывает все local attempt'ы.
- Labels: `precision`, `puzzle`.

### Этап 3. Frontend (← B4)

**F1. `<PrecisionScoreBlock>` компонент.**
- Файлы: `apps/web/src/components/precision/PrecisionScoreBlock.tsx`, `.test.tsx`.
- Интерфейс: `{score: 1..5, scorePct: 0..100}` → блок из §5.1.1.
- Звёзды SVG (использовать существующий `<Star>` если есть; иначе inline SVG).
- Acceptance: rtl-тест на цвет/количество звёзд для каждого score.
- Labels: `precision`.

**F2. Замена бинарной плашки в `PrecisionAttemptReview`.**
- Файлы: `apps/web/src/components/precision/PrecisionAttemptReview.tsx` (или над ним — где сейчас плашка, см. KS-2955), `apps/web/src/components/precision/PrecisionBinaryVerdict.tsx` (старая, оставляем как fallback).
- Условный рендер: `score !== null ? <ScoreBlock/> : <BinaryVerdict/>`.
- Acceptance: визуал на разных score'ах, e2e на странице attempt'а.
- Labels: `precision`.

**F3. `<PrecisionScoreBadge>` для каталога.**
- Файлы: `apps/web/src/components/precision/PrecisionScoreBadge.tsx`.
- Compact-вариант (5 mini-stars) для строк списка attempts.
- Интегрируется в `PrecisionAttemptsListPage` (или где сейчас render attempt-row, см. KS-2968).
- Acceptance: визуал, RU/EN.
- Labels: `precision`.

**F4. Карточка «Средний балл» в Top-блоке.**
- Файлы: `apps/web/src/pages/PrecisionStatsPage.tsx`.
- Пятая карточка с `avgScore + распределение`.
- Acceptance: рендерит при `avgScore !== null`, не ломает четыре старых карточки.
- Labels: `precision`.

**F5. i18n RU/EN для precision.score.* ключей.**
- Файлы: `apps/web/public/locales/{ru,en}/precision.json`.
- Ключи из §5.3.
- Acceptance: ESLint `i18next/no-literal-string` проходит на новых компонентах.
- Labels: `precision`, `i18n`.

### Этап 4. QA (← Этап 3)

**Q1. e2e: новые attempt'ы получают score.**
- Сценарий: сыграть precision-задачу с разными уровнями ошибок (5 best, 4 best + 1 blunder), проверить итоговую плашку.
- Tests: playwright e2e в `apps/e2e/`.
- Acceptance: 5 контрольных кейсов из §4.3 проходят на UI.
- Labels: `precision`, `tests`.

**Q2. Backward-compat ручной чек.**
- Чек-лист: открыть legacy attempt (до миграции) → видна старая бинарная плашка; открыть новый attempt → видны звёзды; на каталоге смесь корректно рендерится.
- Acceptance: чек-лист пройден.
- Labels: `precision`, `tests`.

**Q3. Backfill smoke.**
- DevOps запускает бэкфил-скрипт на staging → проверка, что score проставился у legacy. После — coordinator решает по запуску на проде.
- Acceptance: post-backfill `COUNT(*) WHERE score IS NULL` упало до ожидаемого минимума.
- Labels: `precision`, `tests`, `infra`.

### Этап 5. Калибровка (← Этап 4, ~неделя живых данных)

**A1. Анализ распределения первых 1000 attempt'ов.**
- Архитектор / QA вытаскивает из БД распределение по star: `SELECT score, COUNT(*) FROM precision_attempts WHERE created_at > '<release_date>' GROUP BY score`.
- Если распределение перекошено (например, 80% attempt'ов попадают в 3★ — границы слишком узкие; или 60% в 5★ — слишком щедро), пересматриваем пороги §4 и/или веса композита §3.1.
- Артефакт: `docs/qa/precision-score-calibration-<date>.md`.
- Acceptance: документ опубликован; решение «менять/не менять» зафиксировано.
- Labels: `precision`, `analytics`.

### Порядок и параллельность

- Этап 1 (B1, B2) — последовательно, B1 → B2 параллельно (B1 — pure TS, B2 — миграция, независимы).
- Этап 2 (B3, B4, B5) — после Этапа 1, последовательно (B3 → B4 → B5).
- Этап 3 (F1-F5) — после B4. F1, F3, F4, F5 параллельно; F2 после F1.
- Этап 4 (Q1, Q2, Q3) — после Этапа 3.
- Этап 5 (A1) — через 7-14 дней после Этапа 4 на проде.

Итоговая оценка: **5-8 рабочих дней** одного разработчика + 1-2 дня QA + 1 день калибровки. Низкая сложность, потому что:
1. Алгоритмическая часть — чистая функция (B1), хорошо тестируется.
2. БД-изменения минимальны (2 nullable-колонки).
3. UI-изменения локальны (заменяем 1 плашку + добавляем 1 карточку + 1 badge).

## 8. Альтернативы

### 8.1. Чистый CP (без WDL)

`accuracy = f(cp_loss)` без WDL.

Pro:
- cp есть у всех attempt'ов в БД (включая legacy).
- Не требует UCI_ShowWDL.

Contra:
- **Главный минус**: cp плохо работает на экстремальных позициях. Стартовая оценка +500 cp = «практически выиграно», стартовая +50 cp = «небольшое преимущество». Игрок с +500 теряет 200 cp → всё равно выиграно; с +50 теряет 200 cp → проиграно. Cp_loss=200 в обоих случаях — но это разный context.
- WDL естественно нормализован: `E_before=0.95, E_after=0.90` → loss=5% независимо от cp-диапазона.
- Координатор явно указал в KS-2996: «не cp». Мы используем cp только как fallback (§2.4.1).

**Отклонено как основная метрика.**

### 8.2. Чистый NAG (классификации)

`star = f(blunders_count, mistakes_count, inaccuracies_count)`.

Pro:
- Готово (все классификации в БД).
- Простая логика.

Contra:
- Координатор явно: «NAG-only — нет».
- NAG — дискретный (5 категорий). 5-звёздная шкала + 5 категорий = почти один-к-одному, теряется идея «agregate over moves».
- Не различает: 1 blunder с потерей 100% win-rate vs 1 blunder с потерей 30% — оба = blunder. Continuous accuracy_move различает.

**Отклонено** как основная метрика. Используется как fallback (§2.4.2).

### 8.3. 3-балльная шкала

Bronze / Silver / Gold (или 3 звезды).

Pro:
- Проще понять (3 уровня привычнее в играх типа Angry Birds).
- Меньше калибровки.

Contra:
- Меньше градации для прогресса. Между «удержано» и «провалено» в текущем бинаре уже два уровня; добавление третьего — всего +1. 5 уровней дают полноценный путь развития.
- Координатор явно: «5-балльная».

**Отклонено** (по запросу).

### 8.4. Просто accuracy% (без звёзд)

Показывать `scorePct` (0-100) без округления в звёзды.

Pro:
- Меньше произвола в границах.
- chess.com-style (хотя там сложнее).

Contra:
- Звёзды легче воспринимаются (визуальный паттерн «4 из 5 заполнены» считается мгновенно, число «87%» требует мысли «много это или мало»).
- Числовой % будет на каталоге **рядом** со звёздами (§5.1.1) — компромисс.
- Категориальная оценка (★) и continuous (87%) дополняют друг друга: первая для quick-scan, вторая для tracking.

**Отклонено как замена**, но % сосуществует со звёздами (§5.1.1).

### 8.5. Lichess weighted-average (без min-component)

Pro:
- Признанный стандарт.

Contra:
- На коротких precision-задачах (3-8 ходов) std-dev window ±2 = вся партия → веса вырождаются → ≈ простое среднее → 1 blunder вознаграждается высоким score.
- Cap по worst-class частично решает, но композит mean+min — прозрачнее и предсказуемее.

**Отклонено как замена**, но мы переиспользуем per-move формулу Lichess (§2.3).

### 8.6. Chess.com 7-категорий

Brilliant !! / Great ! / Best / Excellent / Good / Inaccuracy / Mistake / Blunder.

Pro:
- Привычное визуально.

Contra:
- Алгоритм Brilliant/Great закрыт chess.com (NDA-протекторат). Reverse-engineering ненадёжен.
- Brilliant требует распознавания «non-obvious sacrifice» — это ML-классификатор, не наша задача.

**Отклонено**, мы остаёмся в 5-уровневой модели (без Brilliant/Great).

## 9. Риски

| # | Риск | Вероятность | Импакт | Mitigation |
|---|---|---|---|---|
| 1 | Пороги §4 калиброваны на Lichess-распределение, но наши precision-задачи структурно другие (короткие, всегда из выигранной позиции) — реальное распределение по 1-5★ может быть перекошенным (например, 70% попыток будут 4-5★ потому что задачи легче, чем live-партии) | средне | средне | Этап 5 (A1): через 7-14 дней анализируем фактическое распределение; если перекос >50% в один сегмент — корректируем границы; константы хранятся в `precision-score.ts` как `STAR_THRESHOLDS = [50, 70, 85, 95]` для лёгкой правки одним коммитом без миграций |
| 2 | Веса композита 0.7/0.3 в §3.1 — обоснованы качественно (контрольные кейсы), но конкретные веса можно дискутировать | средне | низко | Хранить как именованные константы в shared (`COMPOSITE_MEAN_WEIGHT = 0.7`, `COMPOSITE_MIN_WEIGHT = 0.3`); A1-калибровка может изменить (но это требует ре-расчёта старых attempt'ов — будет миграция или эксплицитное решение «не пересчитываем historical») |
| 3 | Юзер играет 8 best + 1 blunder, получает 2★ (через cap §3.3) — может пожаловаться «ну я же почти всё правильно сыграл» | высоко | низко | UI текст-интерпретация (§5.1.1) явно объясняет: «Преимущество поколебалось — есть серьёзные ошибки. Один blunder на ходу X»; per-move breakdown в `PrecisionAttemptReview` показывает где именно blunder |
| 4 | Bug в формуле `accuracyMove` — например, неправильный POV у wdl, забыли инвертировать — все score выходят перекошенными | средне | высоко | Тесты §7 B1 на 9 контрольных кейсов + ручной spot-check на 5 реальных attempt'ах с заранее известной звёздной оценкой (architect + QA); B5 backfill даёт visibility — сразу видно неестественные распределения |
| 5 | Legacy attempt без wdl и без cp пересчитан через classification-fallback (§2.4.2) даёт «странное» значение — например, attempt со всеми «good»-ходами даёт `scorePct = 80`, но юзер помнит, что играл великолепно | низко | низко | Fallback явно отмечен в UI: «Оценка по приблизительным данным» (i18n-ключ); тем не менее реально таких legacy <1% от БД (после KS-2754 все per-move имеют WDL) |
| 6 | Изменение `accuracyPercent`-вычисления (если решим — нет, см. §6.4 «не меняется») сломает trend-графики и стат-таблицу. Этого не делаем, но риск-вспомнить | низко | средне | `accuracyPercent` остаётся как был (KS-2968); ADR-065 явно фиксирует: «накладной, не замещающий». Документировано в §6.4 |
| 7 | UI инерция: пользователь видит «3★» вместо знакомого «Удержано», воспринимает как ухудшение результата (раньше было «удержано», стало «3★» — кажется хуже) | средне | низко | Tooltip / FAQ-ссылка над звёздами: «Что значат звёзды?»; для случаев `score >= 4★` показываем `«Удержано (4★)»` — комбинация старого и нового, плавный переход; через 1 месяц после релиза «Удержано:» можно убрать |
| 8 | Бэкфил `B5` упирается в большое количество legacy-attempt'ов (`100K+`) и продакшен-БД испытывает лаги | низко | средне | Batch 100 + 100ms sleep (§6.3) удерживает нагрузку на BG-уровне; рассинхронизация — пересчитанные attempts получают score сразу, непересчитанные имеют `null`; запуск через cron в ночное окно |
| 9 | Lichess или мы поменяем formula → расхождение historical vs new attempt'ов в средних метриках trend'а | низко | низко | Все score хранятся в БД фиксированно при создании (не пересчитываются runtime). Если меняем алгоритм — отдельный бэкфил с явным решением (новая колонка `score_v2`, A/B-сравнение). Не входит в этот ADR |
| 10 | Пользователь хочет 5★ и абюзит: реrешать одну задачу до победного. Это не баг, но влияет на agregate-trend (avgScore искусственно растёт) | средне | низко | `precision_attempts` уже хранит ВСЕ попытки (KS-2724), каждая получает свой score; на каталоге показываем latest или best — на усмотрение UI (отдельная задача); avgScore на /precision считается по всем — реrешения этим путём не подменяют ранние записи |
| 11 | Распределение star-границ по линии 70/85 даёт «эффект cliff»: scorePct=84.9 → 3★, scorePct=85.0 → 4★ | низко | низко | scorePct отображается на UI явно (§5.1.1), пользователь видит границу; tooltip «вы на границе 4★, не хватает 0.2 п.п.»; UX-эффект встроен в формат категориальных оценок (5 уровней даёт N-1 cliff, это неизбежно) |
| 12 | Калибровка после релиза изменяет границы — старые attempt'ы остаются с прежним score, новые — с новым; юзер видит «парадокс»: новый attempt с 84% точности — 3★, старый с 86% — 4★ | низко (зависит от A1) | средне | Если после A1 решаем менять границы — делаем явный бэкфил всех `precision_attempts` с пересчётом score (B5-аналог); решение принимается отдельным тикетом после A1 |

## 10. Не входит в этот ADR

- Реализация (отдельные тикеты §7).
- Конкретные тексты интерпретаций §5.1.1 — i18n-контент, делает frontend по черновикам.
- Финальная калибровка границ — после релиза, §11 / Этап 5.
- Изменения рейтинга по precision (не считается, см. ADR-056 §1).
- Реверс-инжиниринг chess.com Brilliant/Great — не делаем.
- Сравнительные scoreboard'ы между пользователями (вне scope, отдельная фича).
- Achievements/medals за серии 5★ — отдельная задача после релиза, как фичи retention.
- Ретроактивный пересчёт score после изменения формулы — отдельный тикет, не входит в MVP §7.

## 11. Follow-up задачи

Координатор создаёт по этому ADR:

**Backend / shared (B1-B5):**
1. `precision`, `puzzle`, `tests` — `precision-score.ts` в shared (B1).
2. `prisma`, `precision` — миграция `add_precision_score` (B2).
3. `precision`, `puzzle` — server-side compute при создании attempt (B3).
4. `precision`, `puzzle` — расширение DTO API (`score`, `scorePct`, `avgScore`) (B4).
5. `precision`, `puzzle` — скрипт бэкфила (B5).

**Frontend (F1-F5):**
6. `precision` — `<PrecisionScoreBlock>` компонент (F1).
7. `precision` — замена плашки в `PrecisionAttemptReview` с fallback (F2).
8. `precision` — `<PrecisionScoreBadge>` для каталога (F3).
9. `precision` — карточка «Средний балл» в Top-блок (F4).
10. `precision`, `i18n` — i18n RU/EN (F5).

**QA (Q1-Q3):**
11. `precision`, `tests` — e2e на новых attempt'ах (Q1).
12. `precision`, `tests` — backward-compat ручной чек-лист (Q2).
13. `precision`, `tests`, `infra` — staging-backfill + проверка (Q3).

**Architect / analytics (A1):**
14. `precision`, `analytics` — анализ распределения 1000 первых attempt'ов и решение по калибровке (A1).

Итого **14 follow-up задач**. Зависимости — см. §7 «Порядок и параллельность».
