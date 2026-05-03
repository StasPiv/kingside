# Гайд: drill-step в курсах

Документ для контент-инженеров и авторов курсов. Описывает, как и когда использовать `LessonStep.kind='drill'` в lesson-курсах.

Связанные документы:
- ADR-035 (Tactical pattern drills) — общая архитектура drill-инфраструктуры.
- ADR-024 (Lessons module) — структура курсов и step'ов.
- `docs/architecture/tactical-drills-methodology.md` — методика 8 drill-типов, формула сложности, локализация.

## 1. Что такое drill-step

`drill-step` — тип шага курса, в котором ученик решает одну или несколько drill-задач (тактический паттерн на одну позицию: `find-fork`, `find-pin`, `find-hanging-piece` и т. д.). Это альтернатива классическому `puzzle` (одна задача с длинным форсированным вариантом) и `text` (теоретический материал).

Главное отличие drill-step от puzzle-step:
- **drill** — короткая задача на одно действие (один ход / одна клетка / число), задача узнавания паттерна. Время на решение — секунды;
- **puzzle** — задача с расчётом нескольких ходов, требует анализа форсированного варианта. Время — десятки секунд или минуты.

Drill — для **тренировки навыка**, puzzle — для **тренировки расчёта**.

## 2. Когда использовать drill-step

| Сценарий | Drill-step | Альтернатива |
|---|---|---|
| Закрепить паттерн сразу после теории («Что такое вилка?» → 5 вилок подряд) | ✅ да | text-step + puzzle-step (медленнее, утомительнее) |
| Проверить узнаваемость темы перед переходом дальше («умеешь ли ты видеть связку?») | ✅ да | exam-step (если есть в проекте) |
| Разогреться в начале урока (3 быстрых задачи на обзор) | ✅ да | — |
| Длинный комбинационный пример (жертва ферзя за мат в 3) | ❌ нет | puzzle-step |
| Этюд / эндшпильная техника на 4–8 ходов | ❌ нет | endgame_drill / puzzle-step |
| Дебютная теория, варианты, идеи | ❌ нет | text-step + puzzle-step |
| Свободная партия с компьютером | ❌ нет | game-step (если есть) |

**Правило:** drill — это «увидеть и нажать», 1 действие, 1 секунда. Если задача требует расчёта — это не drill.

## 3. Контракт `DrillStepPayload`

Источник истины — `packages/shared/src/types/lessons.ts` (commit 3e56e089). TypeScript:

```ts
interface DrillStepPayload {
  type: 'drill';
  drillType: TacticDrillType;       // один из 8
  drillId?: string;                 // UUID конкретного drill'а
  difficultyBucket?: 'easy' | 'medium' | 'hard';
  count?: number;                   // 1..10, default 1
  minSolved?: number;               // 1..count, default = count
}

type DrillDifficultyBucket = 'easy' | 'medium' | 'hard';
```

`TacticDrillType` (один из 8, см. methodology-doc):

```
'find-hanging-piece' | 'find-loose-piece' | 'find-pin' | 'find-fork'
| 'find-all-checks' | 'find-mate-in-one-square' | 'count-attackers'
| 'find-undefended-attack'
```

### Поля

| Поле | Обязательное | Описание |
|---|---|---|
| `type` | ✅ | литерал `'drill'`. Discriminator. |
| `drillType` | ✅ | какой тип drill решать. Один из 8. |
| `drillId` | ❌ | UUID конкретного drill'а из `tactic_drills`. Если задан — backend всегда отдаёт ту же позицию. |
| `difficultyBucket` | ❌ | `'easy'` (drill 1–2) / `'medium'` (3) / `'hard'` (4–5). Используется только в random-режиме (когда `drillId` не задан). |
| `count` | ❌ | 1..10. Сколько drill'ов в шаге подряд. Default = 1. |
| `minSolved` | ❌ | 1..count. Сколько правильно решённых нужно для зачёта шага. Default = count (все). |

### Поведение по комбинациям

| `drillId` | `difficultyBucket` | `count` | Поведение |
|---|---|---|---|
| задан | — | 1 | Конкретный drill, 1 раз |
| задан | (игнорируется) | 1 | То же — `difficultyBucket` игнорируется при наличии `drillId` |
| задан | — | >1 | Тот же drill повторяется N раз (странный сценарий, обычно не нужно) |
| не задан | задан | N | N случайных drill'ов из bucket |
| не задан | не задан | N | N случайных drill'ов любой сложности (НЕ рекомендуется — может быть слишком сложно для слабых учеников) |

### Маппинг bucket → numeric difficulty

Реализуется на бэкенде в момент выборки (см. backend-комментарий в KS-2249):

| Bucket | Numeric difficulty (1..5) |
|---|---|
| `easy` | 1, 2 |
| `medium` | 3 |
| `hard` | 4, 5 |

Содержимое контента переживёт изменения методики — bucket-название не привязано к numeric, маппинг могут двигать на бэкенде.

## 4. Шаблоны использования

### 4.1. Закрепление новой темы

Сценарий: только что объяснили вилку (text-step), хотим сразу 5 простых вилок подряд для запоминания паттерна.

```yaml
- type: drill
  payload:
    type: drill
    drillType: find-fork
    difficultyBucket: easy
    count: 5
    minSolved: 3
```

Почему так:
- `count: 5` — серия для закрепления, не разовая проверка;
- `minSolved: 3` — не наказываем за 2 ошибки в новой теме (учится), но требуем большинство;
- `easy` — первая встреча с темой, нельзя задавать сложные позиции.

### 4.2. Проверка узнаваемости перед переходом

Сценарий: блок «Базовые тактические паттерны» завершён, перед переходом к комбинациям проверяем, что ученик действительно видит связки.

```yaml
- type: drill
  payload:
    type: drill
    drillType: find-pin
    difficultyBucket: medium
    count: 3
    minSolved: 3
```

Почему так:
- `count: 3` — короткая проверка, не тренировка;
- `minSolved: 3` (= count) — все три должны быть правильно (это контроль, не обучение);
- `medium` — не самые лёгкие, чтобы зачёт был осмысленным.

### 4.3. Разогрев / warm-up

Сценарий: начало урока, 3 быстрые задачи на обзор перед основным материалом.

```yaml
- type: drill
  payload:
    type: drill
    drillType: count-attackers
    difficultyBucket: easy
    count: 3
    minSolved: 2
```

Почему так:
- `count-attackers` — самый «лёгкий» drill, идеален для разогрева;
- `minSolved: 2` (из 3) — не блокируем урок если ученик с утра тупит на 1 задаче;
- `easy` — разогрев не должен быть стрессом.

### 4.4. Конкретный пример из теории

Сценарий: в text-step разобрана конкретная позиция (например, классическая вилка из партии Морфи), хотим следом дать **именно эту позицию** ученику.

```yaml
- type: drill
  payload:
    type: drill
    drillType: find-fork
    drillId: "01234567-89ab-cdef-0123-456789abcdef"
    count: 1
    minSolved: 1
```

Почему так:
- `drillId` фиксирован — backend отдаст именно ту позицию, которую ты разобрал;
- `count: 1` — это «попробуй то, что только что показал», одна попытка достаточна;
- При повторном прохождении курса ученик увидит ту же позицию (рейтинг-fading работает по правилам KS-2311).

### 4.5. Контрольная серия из смешанных типов

Сценарий: финальный блок раздела «Тактика», нужна интегральная проверка по всем темам сразу.

Вариант — несколько drill-step подряд в одном lesson:

```yaml
- type: drill
  payload:
    type: drill
    drillType: find-hanging-piece
    difficultyBucket: medium
    count: 2
    minSolved: 2

- type: drill
  payload:
    type: drill
    drillType: find-fork
    difficultyBucket: medium
    count: 2
    minSolved: 2

- type: drill
  payload:
    type: drill
    drillType: find-pin
    difficultyBucket: medium
    count: 2
    minSolved: 2
```

Почему так:
- Один drill-step = один тип. Чтобы проверить несколько типов — последовательность шагов;
- Каждый шаг короткий (2 задачи), не утомляет;
- `minSolved: 2` (из 2) — контроль, без права на ошибку.

## 5. Рекомендации по сложности

### 5.1. Соответствие difficulty уровню курса

| Уровень курса | Рекомендуемый bucket |
|---|---|
| «Шахматы для начинающих» (≤1000 ELO) | `easy` |
| «Базовая тактика» (1000–1300) | `easy` для введения, `medium` для проверки |
| «Тактика среднего уровня» (1300–1600) | `medium` для введения, `hard` для проверки |
| «Тактика для продвинутых» (1600+) | `medium` / `hard` |

Не рекомендуется давать `hard` в курсах для начинающих — drop-off rate резко вырастет.

### 5.2. Подбор `count` и `minSolved`

| Цель | `count` | `minSolved` |
|---|---|---|
| Закрепление новой темы (можно ошибаться) | 4–6 | `count - 2` |
| Тренировка (среднее напряжение) | 3–5 | `count - 1` |
| Контроль (без права на ошибку) | 2–3 | `count` |
| Серия повторения (warm-up) | 2–3 | `count - 1` |

`count > 7` редко имеет смысл — длинные серии утомляют, ученик начинает кликать наугад.

`count = 1` подходит только для конкретного `drillId` — для random-режима один drill — слишком случайный (может попасть лёгкий или тяжёлый, неконтролируемо).

### 5.3. Прогрессия в рамках курса

В курсе из нескольких уроков на одну тему (например, «Связки»):

| Урок | Bucket | count | minSolved |
|---|---|---|---|
| 1. Что такое связка (введение) | `easy` | 5 | 3 |
| 2. Виды связок (теория + практика) | `easy` → `medium` | 5 | 4 |
| 3. Связки в игре | `medium` | 5 | 4 |
| 4. Контрольная по теме | `medium` → `hard` | 3 | 3 |

Постепенный рост сложности и planks. Не прыгай с `easy` сразу на `hard`.

## 6. Anti-patterns — чего не делать

1. **❌ count=1 в random-режиме без drillId.**
   ```yaml
   # ПЛОХО — единственный drill, который случайно может оказаться очень сложным
   drillType: find-fork
   difficultyBucket: easy
   count: 1
   ```
   Минимум 2–3 drill'а в random-режиме, иначе сложность непредсказуема.

2. **❌ count=10 без перерывов.**
   ```yaml
   # ПЛОХО — 10 подряд утомительно, ученик начинает гадать
   drillType: find-hanging-piece
   count: 10
   minSolved: 8
   ```
   Лучше 2 шага по 5 с text-step между ними (короткое объяснение / разбор).

3. **❌ minSolved = count в обучающих сценариях.**
   ```yaml
   # ПЛОХО для обучения — наказывает за любую ошибку, демотивирует
   drillType: find-fork
   difficultyBucket: medium
   count: 5
   minSolved: 5
   ```
   `minSolved = count` подходит для **контроля**, не для **обучения**. В обучении дай право на ошибки.

4. **❌ Случайный hard в курсе для начинающих.**
   ```yaml
   # ПЛОХО — ученик ≤1000 ELO не пройдёт hard, drop-off
   drillType: find-mate-in-one-square
   difficultyBucket: hard
   count: 3
   ```
   Для слабых учеников `hard` — стена, не вызов. Используй `easy`/`medium`.

5. **❌ Несколько типов drill в одном шаге.** Контракт этого не позволяет (`drillType` — единственный, не массив). Если нужно несколько типов — несколько шагов подряд (см. шаблон 4.5).

6. **❌ drillId без проверки drill'а на существование в БД.** Если автор курса указал `drillId`, которого нет в `tactic_drills`, backend вернёт ошибку при рендере шага. Проверяй UUID через линтер `npm run seed:lessons:lint` перед коммитом.

7. **❌ Drill-step как замена puzzle.** Если в позиции расчёт многоходовой комбинации — это puzzle-step, не drill. Drill = одно действие.

## 7. Линтинг и валидация перед commit

Перед commit'ом нового lesson.yml с drill-step:

```bash
# Линтер lesson-фикстур (проверяет валидность всех step'ов, включая drill)
npm run seed:lessons:lint

# Импорт в локальную БД (если нужно проверить рендер)
npm run seed:lessons:import -- path/to/your/lesson.yml
```

Линтер проверяет:
- `drillType` — один из 8 валидных;
- `drillId` (если задан) — формат UUID;
- `difficultyBucket` (если задан) — `easy`/`medium`/`hard`;
- `count` в [1, 10];
- `minSolved` в [1, count];
- Cross-field: `minSolved <= count`.

## 8. Полный YAML-пример lesson с drill-step'ами

```yaml
slug: tactic-forks-intro
title: Знакомство с вилкой
sortOrder: 10
steps:
  - type: text
    payload:
      type: text
      content: |
        Вилка — это атака одной фигурой одновременно на две и более ценных
        фигур противника. Чаще всего вилку делает конь, но бывает и слоном,
        ферзём и даже пешкой.

  - type: drill
    payload:
      type: drill
      drillType: find-fork
      difficultyBucket: easy
      count: 5
      minSolved: 3

  - type: text
    payload:
      type: text
      content: |
        Замечательно. Теперь рассмотрим конкретный пример из партии
        Морфи — Дюк, 1858 год.

  - type: drill
    payload:
      type: drill
      drillType: find-fork
      drillId: "01234567-89ab-cdef-0123-456789abcdef"
      count: 1
      minSolved: 1

  - type: text
    payload:
      type: text
      content: |
        Отлично. На следующем уроке мы рассмотрим более сложные вилки
        и разберём, как готовить вилку через тихий ход.

  - type: drill
    payload:
      type: drill
      drillType: find-fork
      difficultyBucket: easy
      count: 3
      minSolved: 3
```

Структура: text → drill → text → конкретный drill → text → контрольный drill. Это типичный паттерн «теория → закрепление → пример → контроль».

## 9. Связанные drill-типы по темам

При составлении курса полезно знать, какие drill-типы покрывают какие темы:

| Тема курса | Подходящие drill-типы |
|---|---|
| Тактическое зрение, обзор доски | `count-attackers`, `find-loose-piece`, `find-hanging-piece` |
| Шахи и форсированные ходы | `find-all-checks`, `find-mate-in-one-square` |
| Тактические мотивы | `find-pin`, `find-fork` |
| Активная игра, создание угроз | `find-undefended-attack` |

Подробное описание каждого drill-типа — в `docs/architecture/tactical-drills-methodology.md` §2.

## 10. Чек-лист автору курса

Перед коммитом lesson.yml с drill-step:

- [ ] `drillType` соответствует теме урока?
- [ ] `count` подходит под тип шага (обучение/контроль/warm-up)?
- [ ] `minSolved` оставляет право на ошибку в обучении или нет, осознанно?
- [ ] `difficultyBucket` соответствует уровню курса?
- [ ] Если `drillId` задан — проверен через линтер?
- [ ] Между блоками drill есть text-step с объяснением?
- [ ] Не нарушены anti-patterns из §6?
- [ ] `npm run seed:lessons:lint` прошёл?
