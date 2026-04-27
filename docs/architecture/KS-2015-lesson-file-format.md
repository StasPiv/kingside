# KS-2015 — Единый файловый формат урока и автоматический импортер

> Статус: предложение, ждёт фиксации пользователем.
> Связанные документы: ADR-024 (lessons-module), KS-1931 (lessons-redesign-concept),
> KS-1962 (system-courses-admin-api), ADR-029 (custom-puzzles).
> Связанные задачи: KS-2010, KS-2012, KS-2013 (три синхронизации текста одной главы — повод для этой работы).

## Контекст

Сейчас уроки попадают в БД через ad-hoc Node-скрипты в `/tmp/courses/<lesson>/*.mjs`,
которые серией POST/PATCH дёргают `/lessons/admin/*`. Параллельно «план урока»
живёт в свободной форме в `/tmp/courses/<lesson>/lesson.md` (markdown с JSON-блоками).
Источник истины раздвоен: что в plan-файле, что в БД — расходится. На §1 Главы 2
Капабланки потребовалось три патч-задачи (KS-2010, KS-2012, KS-2013) подряд только
ради синхронизации текста, диаграмм и PGN-комментариев в одном уроке.

Цель этого ADR — зафиксировать **единый формат файла урока** и **импортер**,
который читает файл и атомарно создаёт/обновляет урок в БД. Файл становится
единственным источником истины, БД — производной.

## Решение (TL;DR)

1. **Формат файла** — **YAML с JSON-Schema-валидацией** (см. §3 для обоснования
   против JSON и Markdown-with-frontmatter).
2. Один файл = один урок: `<course-slug>/<lesson-slug>.lesson.yml`.
3. Метаданные курса — отдельный файл `<course-slug>/course.yml`. Импортер
   принимает либо один lesson-файл, либо директорию с `course.yml + *.lesson.yml`.
4. **Импортер** — CLI в `tools/lesson-import/` + admin-эндпоинт
   `POST /lessons/admin/import` (CLI вызывает endpoint).
5. **Семантика** — upsert по `course.slug + lesson.slug` с заменой полного
   набора шагов внутри одной транзакции Prisma.
6. **Локализация** — Этап 4. v1 — один файл = один язык; для второго языка
   создаётся параллельный курс (`capablanca-primer-en`) с тем же набором уроков,
   ссылками на общие i18n-ключи курсового уровня.

---

## 1. Анализ текущего состояния

### 1.1. Типы шагов в БД (`LessonStepType`)

Источники: `packages/shared/src/types/lessons.ts` (shape) +
`apps/api/src/lessons/dto/step-payload.dto.ts` (class-validator).

| `type` | Поля payload | Стабилизация | Заметки |
|---|---|---|---|
| `text` | `bodyMarkdown?` / `bodyI18nKey?` + `diagrams[]` (FEN + caption + orientation + **arrows[]** + **highlightedSquares[]**) | стабильно (KS-1994) | оба варианта диаграмм — `{{diagram:N}}` placeholder и inline ` ```fen ``` ` блок |
| `puzzle` | `selection.mode` ∈ `ids` \| `filter` \| `custom` | стабильно (ADR-029) | `custom` — самодостаточный (FEN + UCI solutionMoves) |
| `quiz` | `questions[]` (prompt + options + correctOptionIds + опц. `fen` и `explanation`) | стабильно (KS-1982 — inline only, без i18n) | |
| `position` | `fen` + опц. `expectedMoves[]` (UCI) + `orientation` | стабильно (KS-1983) | `expectedMoves` пустой/отсутствует ⇒ read-only |
| `game_review` | XOR `gameId` или `pgn` | стабильно (KS-1811) | PGN валидируется `chess.js#loadPgn`, требует `[FEN ...]`+`[SetUp "1"]` для нестандартных позиций |
| `video` | `url` (whitelist YouTube/Vimeo) + `titleI18nKey?` | стабильно (KS-1796/1808) | |
| `endgame_drill` | `fen` + `playerSide` + `skillLevel` + `winCondition` (mate/promote/reach_position/material_advantage) + опц. `maxMoves` / `hintsAllowed` | стабильно (KS-1815) | |
| `opening_drill` | `pgn` (дерево) + `playerSide` + `onDeviation` + опц. `engineSkillLevel` | стабильно (KS-1816) | |

Все восемь типов имеют рабочую class-validator валидацию; backend проверяет
`type === payload.type`, вложенные поля FEN/PGN/UCI прогоняются через chess.js.

### 1.2. Schema БД

```prisma
model Course      { id, slug @unique, level, titleKey, descriptionKey,
                    title, description, audience, hook, outcome,
                    coverUrl, difficulty, estimatedMinutes, tags[], order, isPublished }
model Lesson      { id, courseId, slug, order, blockKey, kind,
                    titleKey, summaryKey, title, summary, estMinutes, isPublished
                    @@unique([courseId, slug]) }
model LessonStep  { id, lessonId, order, type, payload (JSONB) }
```

Каскад на удаление: `Course → Lesson → LessonStep` плюс
`UserCourseProgress / UserLessonProgress`. Это критично для семантики upsert
(см. §5.2).

### 1.3. Admin API

Есть всё, что нужно для CRUD, но **между сущностями нет транзакции**:

```
POST   /lessons/admin/courses                                       — создать курс
GET    /lessons/admin/courses                                       — список (incl. drafts)
GET    /lessons/admin/courses/:id                                   — курс + lessons[]
PATCH  /lessons/admin/courses/:id                                   — апдейт метаданных
DELETE /lessons/admin/courses/:id                                   — каскадное удаление
POST   /lessons/admin/courses/reorder                               — массовый reorder

POST   /lessons/admin/courses/:courseId/lessons                     — создать урок
POST   /lessons/admin/courses/:courseId/lessons/reorder             — reorder уроков курса
GET    /lessons/admin/lessons/:id                                   — урок + steps[]
PATCH  /lessons/admin/lessons/:id                                   — апдейт
DELETE /lessons/admin/lessons/:id                                   — каскадное удаление

POST   /lessons/admin/lessons/:lessonId/steps                       — создать шаг
POST   /lessons/admin/lessons/:lessonId/steps/reorder               — reorder шагов
PATCH  /lessons/admin/steps/:id                                     — апдейт шага
DELETE /lessons/admin/steps/:id                                     — удаление
```

`reorderCourses/Lessons/Steps` транзакционны (через `prisma.$transaction`), но
отдельные операции — нет. Это значит: текущие seed-скрипты делают **N запросов
без отката**; падение в середине оставляет полу-залитый урок.

### 1.4. Как заливается контент сейчас

Глава 1 (`/tmp/courses/lesson-01/`):

- `seed.mjs` — 12 шагов одним проходом: dev-bypass → создать курс → создать
  урок → 12 раз POST /steps. Если шаг падает — откатить вручную.
- `patch-arrows.mjs` (KS-1997) — патчит `arrows[]`/`highlightedSquares[]` в
  диаграммах: GET шаг, смерджить в `payload.diagrams[N]`, PATCH полным
  payload'ом. Иначе старые поля затрутся (см. §1.5).

§1 Главы 2 (`/tmp/courses/lesson-02-ch2-p1-simple-mates/`):

- `seed.mjs` — создать урок и 13 шагов.
- `patch-pgns.mjs` (KS-2007) — регуляркой выдёргивает 6 PGN-блоков из
  `lesson.md`, PATCH'ит шаги по `order ∈ {3,5,7,9,11,13}`.
- `patch-text-bodies.mjs` (KS-2010) — копирует строки из source-файла в
  `bodyMarkdown` text-шагов по whitelist'у.
- `patch-steps-6-12-from-plan.mjs` (KS-2013) — отдельный скрипт для перезаливки
  bodyMarkdown шагов 6 и 12 из переписанного plan-файла.

Каждый эпизод правки рождает новый скрипт.

### 1.5. Главные проблемы текущего подхода

1. **Расхождение plan-файл ↔ БД.** Plan-файл редактируется одним патчем,
   БД — отдельным скриптом, который вычитывает план регуляркой. Если
   изменился синтаксис — скрипт надо менять. KS-2010/2012/2013 — три
   подряд итерации синхронизации одной главы.
2. **Нет атомарности.** N HTTP-запросов на один урок. При падении в
   середине данных в БД остаются «полу-залитые», а не откатываются.
3. **`payload` — JSONB; PATCH перезатирает.** В `patch-arrows.mjs` пришлось
   делать GET → merge → PATCH полным payload, потому что иначе пропадают
   `bodyMarkdown` и неизменённые диаграммы. Тонкое место — забудешь
   смерджить, потеряешь данные (KS-2013).
4. **Контент-редактор не может работать без программиста.** Каждый новый
   урок требует написать скрипт. Цель проекта по обучающему контенту —
   контент-редактор пишет YAML, программист не нужен.
5. **Нет места под расширение.** Новый тип шага (drill, puzzle author) =
   новый ad-hoc скрипт.

---

## 2. Требования к формату

### 2.1. Должен поддерживать

| Сущность | Что нужно |
|---|---|
| **Метаданные курса** | slug, level, titleKey, descriptionKey, inline title/description/audience/hook/outcome, coverUrl, difficulty (1..3), estimatedMinutes, tags[], order, isPublished |
| **Метаданные урока** | slug, order, blockKey, kind, titleKey, summaryKey, inline title/summary, estMinutes, isPublished |
| **Текстовый шаг** | многострочный markdown + плейсхолдеры `{{diagram:N}}` ИЛИ inline ` ```fen ``` ` блоки (оба варианта уже работают на FE) |
| **Диаграмма** | FEN, caption, orientation, **arrows[]** (`{from, to, color?}`), **highlightedSquares[]** (`{square, color?}`) |
| **Партия с комментариями** | многострочный PGN с inline `{...}`-комментариями и NAG-знаками; опц. стартовый FEN; заголовок (Event/Result) |
| **Quiz** | список вопросов; у каждого — prompt, опц. fen, options[], correctOptionIds[], опц. multi/explanation |
| **Position** | fen + опц. expectedMoves[] (UCI) + orientation |
| **Puzzle** | три режима selection: ids / filter / custom (FEN + UCI solutionMoves + опц. orientation/themes/caption) |
| **Endgame drill** | fen + playerSide + skillLevel + winCondition (4 варианта) + опц. maxMoves / hintsAllowed |
| **Opening drill** | pgn-дерево + playerSide + onDeviation + опц. engineSkillLevel |
| **Video** | url (YouTube/Vimeo) + опц. titleI18nKey |

### 2.2. Должен решать (мета-требования)

- **Diff-friendly.** Изменение одной фразы — одна строка в diff.
- **Многострочный контент** (markdown + PGN) — без бесконечной escape-лестницы.
- **Валидация перед записью.** Schema + бизнес-правила (FEN/PGN/UCI) — ту же
  проверку делает back-end DTO.
- **Идемпотентность.** Повторный импорт того же файла = no-op (никаких
  лишних UPDATE с тем же payload).
- **Расширяемость.** Новый тип шага — новый дискриминатор `step.type` без
  ломки существующих файлов.

### 2.3. Локализация — отдельным этапом

Текст шагов сейчас inline (KS-1982). i18n-ключи остаются только на уровне
метаданных (Course.titleKey, Lesson.titleKey, Course.audienceI18nKey и т. д.).
v1 формата — один файл = один язык. Для второго языка создаётся параллельный
курс (`capablanca-primer-ru`, `capablanca-primer-en`) — это
согласуется с архитектурным решением KS-1982 (контент = локальный текст
конкретного курса). Подробнее — §8 Этап 4.

---

## 3. Сравнение вариантов формата

Три кандидата: JSON, YAML, Markdown с frontmatter + кастомные fenced-блоки.

### 3.1. Критерии

| # | Критерий | Почему важно |
|---|---|---|
| C1 | Читаемость для контент-редактора (не программиста) | Цель — снять необходимость программиста на каждый урок |
| C2 | Многострочный markdown | Тело шага типа text может быть на 3 экрана |
| C3 | Многострочный PGN с `{...}` | Уже сейчас 14-ходовая партия с 4 inline-комментариями |
| C4 | Diff-friendly (git) | Правка одного абзаца — одна строка в diff, не вся |
| C5 | Простота валидации | JSON Schema или эквивалент с готовыми библиотеками |
| C6 | Поддержка инструментами (IDE, превью) | Подсветка, snippet'ы, lint-on-save |
| C7 | Расширяемость (новые типы шагов) | Дискриминированный union без миграции старых файлов |

### 3.2. Сравнение

| Критерий | JSON | YAML | Markdown + frontmatter |
|---|---|---|---|
| **C1 читаемость** | плохо: всё в `"…"`, лестница `}}}` в конце | хорошо: меньше пунктуации, отступы вместо скобок | очень хорошо: тело урока — обычный markdown |
| **C2 markdown** | плохо: `\n` в строке, экранирование `"` | очень хорошо: `body: \|` literal block, перенос строк сохраняется | очень хорошо: markdown — это сам носитель |
| **C3 PGN** | плохо: одна длинная строка с `\"` | очень хорошо: `pgn: \|` literal block, видно структуру | плохо: либо длинная строка во frontmatter, либо кастомный fenced-блок ` ```pgn ``` `, который не входит в стандартный markdown |
| **C4 diff** | средне: длинные строки с `\n` ⇒ изменение одной строки = весь шаг как один diff-блок | хорошо: каждая строка markdown / PGN — отдельная строка YAML, git показывает построчный diff | хорошо для текста, плохо для структуры (отступы JSON-блоков ломают diff) |
| **C5 валидация** | стандарт: JSON Schema + `ajv` | YAML парсится в JS-объект (`js-yaml`), затем тот же JSON Schema + `ajv` (используется уже в проекте — см. seed-lint в `apps/api/src/lessons/seed/lint.ts`) | сложно: frontmatter (YAML) + custom fenced-блоки → нужен свой парсер (remark plugin или regex), отдельная схема для каждого блока |
| **C6 инструменты** | повсеместно, но отсутствие комментариев | подсветка во всех IDE, плагины с auto-complete по schema (Red Hat YAML для VSCode), inline комментарии `#` | подсветка markdown — да, валидация custom-блоков — самописная |
| **C7 расширяемость** | дискриминатор `type` тривиален | дискриминатор `type` тривиален | новый тип = новый кастомный fenced-блок + изменение парсера |

### 3.3. Что не подходит и почему

**JSON отвергается.** Цена — нечитаемый длинный markdown как `"\n"`-строка. Уже
сейчас `lesson.md` Главы 2 имеет JSON-блоки с однострочным PGN на 200+ символов
с экранированными кавычками — именно из этого формата регуляркой выкусываются
PGN в `patch-pgns.mjs` (KS-2007). Вкладывать в это работу контент-редактора
не получится.

**Markdown с frontmatter + кастомные fenced-блоки отвергается.** На вид
привлекательно (markdown — носитель, frontmatter — метаданные), но:

1. Парсер становится нестандартным. Пример — `step-2.md`:
   ```markdown
   ---
   type: text
   order: 2
   ---
   Это вступление.

   ```fen highlights=e4,d5
   8/8/8/3p4/4P3/8/8/8 w - - 0 1
   ```

   Это пояснение после диаграммы.
   ```
   Каждый кастомный блок (`fen`, `pgn`, `quiz`, `puzzle`) — отдельный микро-DSL
   с собственными атрибутами. Это, по сути, **MDX без MDX**, против которого
   прямо сказано в ограничениях задачи.
2. Один шаг = один файл. Урок из 13 шагов — 13 файлов + manifest. Структура
   тяжелее, чем «один файл — один урок».
3. Версионирование: переупорядочивание шагов = переименование 13 файлов,
   `git mv` × 13. В YAML просто меняешь `order:`.
4. Валидация: схема для каждого fenced-блока, отдельный парсер AST. Схема для
   YAML — одна, готовая.

**Стоп: можно ли всё-таки в один markdown-файл.** Вариант
«один markdown-файл с кастомными fenced-блоками внутри» — оставляет ту же
проблему DSL в каждом блоке плюс блокирует переупорядочивание и валидацию
в духе «весь урок одной схемой». Эту схему нет смысла прикручивать к парсеру
remark в обход YAML.

### 3.4. Рекомендация: YAML

**Выбираем YAML.** Обоснование:

1. **Читаемость** — лучше JSON; для контент-редактора, незнакомого с
   программированием, синтаксис ближе к естественному списку.
2. **Многострочный контент** — YAML literal blocks (`|`) сохраняют переносы
   строк и отступы 1-в-1. Markdown и PGN кладутся «как есть» (фрагмент,
   полный пример с правильной вложенностью — в §4.14):
   ```text
   body: |
     При двух ладьях мат достигается весьма просто.

     {{diagram:0}}

   pgn: |
     [Event "K+R vs K, central"]
     [FEN "8/8/8/4k3/8/8/8/4K2R w - - 0 1"]
     [SetUp "1"]

     1. Ke2 {Король идёт к центру.} Kd5 2. Ke3 Kc4 3. Rh5
   ```
3. **Валидация** — `js-yaml` парсит в JS-объект, затем тот же `ajv` + JSON
   Schema, что и в seed-line. Связка проверена в seed-линтере
   (`apps/api/src/lessons/seed/lint.ts`).
4. **Diff** — построчный, потому что markdown/PGN внутри `|`-блока хранятся
   как обычные строки.
5. **Комментарии** (`# ...`) — есть, в JSON нет. Полезно для пометок типа
   «здесь тонкое место», «KS-2012: переписали в SAN».
6. **Расширяемость** — `step.type` дискриминирует payload, новый тип шага
   расширяет схему без миграции существующих файлов.

Минусы YAML, которые мы принимаем:

- Чувствительность к отступам. Лечится IDE-плагином (Red Hat YAML для VSCode
  читает schema, подсвечивает ошибки on-save).
- «Norway problem» (`country: NO` парсится как `false`) — не релевантно,
  у нас нет полей-стран, slug'и и orientation в кавычках.
- Ассоциативные массивы в нотации flow — можно, но в нашем формате не нужны.

### 3.5. Альтернатива на случай отказа от YAML

Если по причинам, не рассмотренным здесь, YAML отклонят (например, требование
строгой типизации без YAML-tag'ов): второй кандидат — **JSON5**. Это не «голый»
JSON — есть многострочные строки, комментарии, висячие запятые. Парсится
стандартной библиотекой `json5`. Для контент-редактора всё равно сложнее
YAML, но лучше JSON.

---

## 4. Спецификация формата

### 4.1. Структура директории

```
content/courses/
  capablanca-primer/
    course.yml                       # метаданные курса
    01-chapter-1.lesson.yml          # урок 1
    02-chapter-2-simple-mates.lesson.yml
    ...
```

Один файл = один урок. Имя файла должно начинаться с двух цифр для
естественной сортировки в файловой системе, но **источник истины
порядка — поле `lesson.order`**, не имя файла.

### 4.2. Версионирование схемы

Каждый файл начинается с указания версии формата и схемы:

```yaml
schemaVersion: 1
```

Импортер падает, если `schemaVersion` отсутствует или больше последней
поддерживаемой. Это страхует от молчаливого импорта несовместимого файла,
сохранённого старым импортером после миграции.

### 4.3. Файл `course.yml`

```yaml
schemaVersion: 1
slug: capablanca-primer
level: beginner            # 'beginner' | 'intermediate' | 'advanced'
order: 1
isPublished: false

# i18n-ключи (обязательные — fallback)
titleKey: lessons.capablanca-primer.title
descriptionKey: lessons.capablanca-primer.description

# Inline-поля (опциональные, приоритет над *Key)
title: 'Учебник Капабланки'
description: 'Первая часть классического учебника Х. Р. Капабланки в переводе И. Майзелиса.'
audience: 'Никогда не играл в шахматы.'
hook: 'Семь параграфов первой главы…'
outcome: 'Знаешь как ходят все фигуры…'

coverUrl: '/static/covers/capablanca.png'
difficulty: 1                # 1=easy, 2=medium, 3=hard
estimatedMinutes: 40
tags:
  - fundamentals
  - rules
  - capablanca
```

### 4.4. Файл `<lesson>.lesson.yml`

```text
schemaVersion: 1
courseSlug: capablanca-primer
slug: chapter-2-p1-simple-mates
order: 2
blockKey: chapter-2
kind: endgame_set            # LessonKind: theory | tactics_set | endgame_set | opening_line | game_review | quiz
isPublished: false

titleKey: lessons.capablanca-primer.ch2.l1.title
summaryKey: lessons.capablanca-primer.ch2.l1.summary
title: '§1. Простые маты'
summary: 'Четыре техники мата: К+Л, К+Ф, К+2С, 2Л.'
estMinutes: 35

steps:
  - <step-1>                # подробности shape — §4.5..§4.13
  - <step-2>
  # ...
```

Поле `order` шага в файле **не указывается** — порядок берётся из
позиции в массиве `steps`. Так нельзя случайно «забыть» обновить `order`
после переупорядочивания. Импортер проставит `order = i + 1` на запись.

### 4.5. Шаг — общие поля + дискриминатор

```yaml
- type: text                 # обязательное; задаёт payload-shape ниже
  # ... type-specific поля
```

`type` ∈ `{text, puzzle, quiz, position, game_review, video, endgame_drill, opening_drill}` (8
текущих).

### 4.6. Step `text`

```yaml
- type: text
  body: |
    При двух ладьях мат достигается весьма просто.

    {{diagram:0}}
  diagrams:
    - fen: '8/8/8/4k3/8/8/8/R3K2R w - - 0 1'
      caption: 'Диаграмма 24. Чёрный король e5, белые король e1, ладьи a1 и h1.'
      orientation: white
      arrows:
        - { from: a1, to: a8, color: '#22c55e' }
        - { from: h1, to: h4 }            # color опционален
      highlightedSquares:
        - { square: e5, color: '#fde047' } # цель — чёрный король
        - { square: a8 }
```

Правила:

- `body` — обязательное (есть либо `body`, либо `bodyI18nKey` — XOR; импортер
  валидирует).
- В `body` плейсхолдеры `{{diagram:N}}` ссылаются на `diagrams[N]` (0-based).
- Альтернативно — inline ` ```fen ``` ` блоки прямо в markdown (KS-1763 / L-08
  поддерживает оба, см. `packages/shared/src/types/lessons.ts`); если автор
  использует inline-форму, `diagrams[]` можно не заполнять.
- `arrows[]` и `highlightedSquares[]` — KS-1994, уже в shape БД и валидаторе.
- `orientation` ∈ `{white, black}`, по умолчанию `white`.
- Поля `square`/`from`/`to` — формат `[a-h][1-8]` (валидируется регуляркой,
  как в DTO).

### 4.7. Step `game_review`

```yaml
- type: game_review
  pgn: |
    [Event "Capablanca primer, ch.2 §1, 2R vs K"]
    [White "?"]
    [Black "?"]
    [Result "1-0"]
    [FEN "8/8/8/4k3/8/8/8/R3K2R w - - 0 1"]
    [SetUp "1"]

    1. Rh4 {По обыкновению чёрного короля оттесняем на край доски.}
    Kf5 2. Ra5+ Kg6 3. Rb4 {Нельзя 3.Rh6+ — чёрный король возьмёт ладью.}
    Kf6 4. Rb6+ Ke7 5. Ra7+ Kd8 6. Rb8# 1-0
```

Правила:

- Ровно одно из `pgn` / `gameId` (XOR — KS-1811).
- PGN валидируется `chess.js#loadPgn`. Скобки `{...}` и `(...)` парные.
- **Нотация ходов — SAN** (`Rh4`, `Bf5`, `Rh5+`, `Ra1#`). Long-algebraic
  (`h1-h5+`) — в импортер передаётся «как есть», но падает на валидаторе PGN.
  Эта проверка существует на бэке (`@IsValidPgn` декоратор) — KS-2012 не
  повторится.
- Inline-комментарии `{...}` — дословный текст источника без
  сокращений (KS-2023). Длина значения не имеет.
- Стартовая позиция нестандартная ⇒ обязателен `[FEN ...] [SetUp "1"]`.

### 4.8. Step `position`

```yaml
- type: position
  fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
  orientation: white
  expectedMoves:                      # UCI; принимается любой ход из списка
    - 'e1g1'                          # короткая рокировка
    - 'd2d3'                          # альтернатива
```

`expectedMoves` опциональны (KS-1983) — без них шаг read-only диаграмма с
интерактивностью вокруг.

### 4.9. Step `quiz`

```yaml
- type: quiz
  passThreshold: 0.7
  questions:
    - id: q1
      prompt: 'Какая фигура контролирует наибольшее число полей?'
      options:
        - { id: q1-a, label: 'Ферзь' }
        - { id: q1-b, label: 'Ладья' }
        - { id: q1-c, label: 'Конь' }
      correctOptionIds: [q1-a]
      explanation: 'Ферзь — слон + ладья.'
```

`prompt` / `label` / `explanation` — inline-текст (KS-1982: i18n-ключи в
quiz не используются).

### 4.10. Step `puzzle`

```yaml
# Вариант 1: ids из системной puzzle-БД (Lichess)
- type: puzzle
  selection:
    mode: ids
    puzzleIds:
      - '00sHx'
      - '00sJ9'

# Вариант 2: filter
- type: puzzle
  selection:
    mode: filter
    themes: [fork, pin]
    ratingMin: 1000
    ratingMax: 1400
    limit: 5

# Вариант 3: custom (ADR-029) — авторские задачи прямо в файле
- type: puzzle
  selection:
    mode: custom
    customPuzzles:
      - fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'
        solutionMoves: ['d1d8']    # UCI; первый ход — ход ученика
        orientation: white
        themes: ['back_rank']
        caption: 'Мат в 1.'
```

### 4.11. Step `endgame_drill`

```yaml
- type: endgame_drill
  fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1'
  playerSide: white
  skillLevel: 5                  # 0..20
  winCondition:
    kind: promote                # mate | promote | reach_position | material_advantage
  maxMoves: 30
  hintsAllowed: false
```

Альтернативные значения `winCondition` (показаны как варианты,
не повторение одного ключа):

```text
winCondition: { kind: mate }
winCondition: { kind: reach_position, fen: '8/8/8/8/8/8/8/4K2k w - - 0 1' }
winCondition: { kind: material_advantage, amount: 5 }   # в пешках
```

### 4.12. Step `opening_drill`

```yaml
- type: opening_drill
  pgn: |
    1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5) a6 4. Ba4 Nf6 5. O-O
  playerSide: white
  onDeviation: show_correction   # show_correction | engine_punish
  engineSkillLevel: 5
```

### 4.13. Step `video`

```yaml
- type: video
  url: 'https://www.youtube.com/watch?v=...'
  titleI18nKey: lessons.capablanca.intro.video.title
```

Whitelist хостов — `ALLOWED_VIDEO_HOSTS` в shared (KS-1808).

### 4.14. Полный мини-пример урока

Текстовый шаг с диаграммой (highlights + arrows) + game_review + custom puzzle:

```yaml
schemaVersion: 1
courseSlug: capablanca-primer
slug: ch2-p1-mini
order: 99
blockKey: chapter-2
kind: endgame_set
isPublished: false

titleKey: lessons.capablanca.ch2.demo.title
summaryKey: lessons.capablanca.ch2.demo.summary
title: 'Демонстрация формата'
summary: 'Один text-шаг + один game_review + одна custom-puzzle.'
estMinutes: 5

steps:
  - type: text
    body: |
      Рассмотрим стандартную позицию мата двумя ладьями.

      {{diagram:0}}

      Стрелки показывают, куда уйдут ладьи. Жёлтым подсвечен король,
      которого оттесняем.
    diagrams:
      - fen: '8/8/8/4k3/8/8/8/R3K2R w - - 0 1'
        caption: 'Диаграмма 24. К+2Л против чёрного короля e5.'
        orientation: white
        arrows:
          - { from: h1, to: h4 }
          - { from: a1, to: a5 }
        highlightedSquares:
          - { square: e5, color: '#fde047' }

  - type: game_review
    pgn: |
      [Event "K+2R vs K"]
      [Result "1-0"]
      [FEN "8/8/8/4k3/8/8/8/R3K2R w - - 0 1"]
      [SetUp "1"]

      1. Rh4 {Оттесняем короля.} Kf5 2. Ra5+ Kg6 3. Rb4 Kf6
      4. Rb6+ Ke7 5. Ra7+ Kd8 6. Rb8# 1-0

  - type: puzzle
    selection:
      mode: custom
      customPuzzles:
        - fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'
          solutionMoves: ['d1d8']
          orientation: white
          caption: 'Мат на последней горизонтали в 1 ход.'
          themes: [back_rank]
```

### 4.15. JSON Schema (фрагменты)

Полная схема — отдельный файл `tools/lesson-import/schema/lesson.schema.json`
(пишется в Этапе 1 backend-задачей). Здесь — ключевые куски:

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "LessonFile",
  "type": "object",
  "required": ["schemaVersion", "courseSlug", "slug", "order", "blockKey",
               "kind", "titleKey", "summaryKey", "steps"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "courseSlug":    { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "slug":          { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "order":         { "type": "integer", "minimum": 0 },
    "blockKey":      { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "kind":          { "enum": ["theory","tactics_set","endgame_set",
                                "opening_line","game_review","quiz"] },
    "isPublished":   { "type": "boolean", "default": false },
    "titleKey":      { "type": "string" },
    "summaryKey":    { "type": "string" },
    "title":         { "type": ["string", "null"] },
    "summary":       { "type": ["string", "null"] },
    "estMinutes":    { "type": "integer", "minimum": 1, "default": 10 },
    "steps": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/Step" }
    }
  },
  "$defs": {
    "Square": { "type": "string", "pattern": "^[a-h][1-8]$" },
    "Arrow":  { "type": "object",
                "required": ["from","to"],
                "properties": {
                  "from": { "$ref": "#/$defs/Square" },
                  "to":   { "$ref": "#/$defs/Square" },
                  "color":{ "type": "string", "maxLength": 40 }
                }, "additionalProperties": false },
    "Highlight": { "type": "object",
                   "required": ["square"],
                   "properties": {
                     "square": { "$ref": "#/$defs/Square" },
                     "color":  { "type": "string", "maxLength": 40 }
                   }, "additionalProperties": false },
    "Diagram": { "type": "object",
                 "required": ["fen"],
                 "properties": {
                   "fen":         { "type": "string" },
                   "caption":     { "type": "string" },
                   "orientation": { "enum": ["white","black"], "default": "white" },
                   "arrows":      { "type": "array", "maxItems": 64,
                                    "items": { "$ref": "#/$defs/Arrow" } },
                   "highlightedSquares": { "type": "array", "maxItems": 64,
                                           "items": { "$ref": "#/$defs/Highlight" } }
                 }, "additionalProperties": false },
    "Step": {
      "oneOf": [
        { "$ref": "#/$defs/StepText" },
        { "$ref": "#/$defs/StepGameReview" },
        { "$ref": "#/$defs/StepPosition" },
        { "$ref": "#/$defs/StepQuiz" },
        { "$ref": "#/$defs/StepPuzzle" },
        { "$ref": "#/$defs/StepEndgameDrill" },
        { "$ref": "#/$defs/StepOpeningDrill" },
        { "$ref": "#/$defs/StepVideo" }
      ]
    },
    "StepText": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type":     { "const": "text" },
        "body":     { "type": "string" },
        "bodyI18nKey": { "type": "string" },
        "diagrams": { "type": "array", "items": { "$ref": "#/$defs/Diagram" } }
      },
      "oneOf": [{ "required": ["body"] }, { "required": ["bodyI18nKey"] }],
      "additionalProperties": false
    }
    // ... остальные StepX
  }
}
```

JSON Schema проверяет только структуру. Бизнес-валидация (FEN валиден,
PGN парсится, UCI ходы легальны от FEN) делается ДОПОЛНИТЕЛЬНО на бэке —
тем же `@IsFen` / `@IsValidPgn` / `@ArePositionMovesLegal`, что уже работают
для класса admin-DTO (см. §6).

### 4.16. Соглашения о нотации

- **Ходы в `pgn`** — стандартная SAN: `Rh4`, `Bxc6+`, `O-O`, `O-O-O`,
  `e8=Q+`, `Rh5#`. Long-algebraic (`h1-h5+`) запрещён — валидатор PGN падает.
- **Ходы в `solutionMoves` / `expectedMoves`** — UCI: `e2e4`, `e7e8q` (с
  промоутом). Без `+`/`#`. Без пробелов.
- **FEN** — стандарт (6 полей, разделённых пробелом). Валидируется chess.js.
- **Клетка для `square`/`from`/`to`** — `[a-h][1-8]` (lowercase).
- **Цвет** для `arrow.color` / `highlight.color` — CSS-строка
  (`#22c55e`, `red`, `rgba(...)`); FE имеет дефолт, если не задан.

---

## 5. Дизайн импортера

### 5.1. Где живёт

**CLI** в `tools/lesson-import/`:

```
tools/lesson-import/
  package.json
  src/
    cli.ts                  # точка входа
    parser.ts               # YAML → объект + JSON Schema валидация (ajv)
    upserter.ts             # отправка в admin API
    diff.ts                 # diff с текущим состоянием БД для report'а
  schema/
    lesson.schema.json
    course.schema.json
  README.md
```

**Admin-эндпоинт** `POST /lessons/admin/import`:

```
POST /api/lessons/admin/import
Content-Type: application/json
Body: {
  course?: <CourseFile>,           # опционально, если только урок
  lesson:  <LessonFile>,           # обязательно
  dryRun?: boolean                 # default false; вернуть diff без записи
}
Response 200: {
  course:     { id, slug, created: bool, updated: bool, fields?: string[] },
  lesson:     { id, slug, created: bool, updated: bool, fields?: string[] },
  steps: [
    { id, order, type, action: 'created'|'updated'|'unchanged'|'deleted' }
  ]
}
```

CLI вызывает endpoint. Дизайн «CLI ↔ HTTP, не прямой Prisma» нужен по двум
причинам:

1. Авторизация и rate-limit — те же гарды (`JwtAuthGuard` + `AdminEmailGuard` +
   `UserRateLimitGuard`), что и у других admin-операций.
2. CLI можно запустить с любого ноутбука против dev/prod, не имея локально
   `DATABASE_URL`.

### 5.2. Семантика upsert (атомарная транзакция)

Псевдокод сервиса:

```ts
async function importLesson(file: LessonFile, dryRun: boolean) {
  return prisma.$transaction(async (tx) => {
    // 1. Курс — upsert по slug (если course-файл передан вместе с lesson).
    const course = await tx.course.upsert({
      where: { slug: file.courseSlug },
      update: { /* только переданные поля */ },
      create: { /* required + defaults */ },
    });

    // 2. Урок — upsert по (courseId, slug).
    const lesson = await tx.lesson.upsert({
      where: { courseId_slug: { courseId: course.id, slug: file.slug } },
      update: { /* meta */ },
      create: { /* meta + courseId */ },
    });

    // 3. Шаги — replace всей коллекции:
    //    а) удалить шаги, которых нет в файле (по сравнению old vs new);
    //    б) создать новые;
    //    в) изменить существующие (по совпадающему order + type).
    //    Опционально матчим по «структурному» хешу payload, чтобы не
    //    записывать UPDATE с тем же payload (идемпотентность).

    const existing = await tx.lessonStep.findMany({
      where: { lessonId: lesson.id },
      orderBy: { order: 'asc' },
    });

    // Стратегия: «полная замена шагов».
    //   - Совпадение по индексу позиции; если type/payload отличаются — UPDATE.
    //   - Лишние существующие шаги (existing.length > new.length) — DELETE.
    //   - Не хватает (new.length > existing.length) — CREATE.
    // Order проставляется по позиции массива (1..N).

    for (let i = 0; i < file.steps.length; i++) {
      const incoming = file.steps[i];
      const ex = existing[i];
      if (!ex) {
        await tx.lessonStep.create({ /* lessonId, order=i+1, type, payload */ });
      } else if (
        ex.type !== incoming.type ||
        !deepEqualPayload(ex.payload, incoming.payload) ||
        ex.order !== i + 1
      ) {
        await tx.lessonStep.update({
          where: { id: ex.id },
          data: { type: incoming.type, payload: incoming.payload, order: i + 1 },
        });
      } // else — без изменений (идемпотентность)
    }
    for (let i = file.steps.length; i < existing.length; i++) {
      await tx.lessonStep.delete({ where: { id: existing[i].id } });
    }

    if (dryRun) throw new RollbackSignal(); // прервать транзакцию
    return /* report */;
  });
}
```

Ключевые свойства:

- **Атомарность.** Всё внутри одной `prisma.$transaction`. Если упало — БД
  откатывается к состоянию до импорта.
- **Идемпотентность.** Если payload не изменился — UPDATE не выполняется
  (`deepEqualPayload`). dryRun возвращает diff и кидает `RollbackSignal`,
  чтобы транзакция откатилась.
- **Удаление пропавших шагов.** Если в файле осталось 10 шагов вместо 13 —
  3 лишних DELETE'нутся каскадно вместе с относящимися к ним
  `UserLessonProgress.stepsState`.
- **Order.** Импортер всегда ставит `order = i + 1` (1-based, как в текущих
  скриптах). Поле `order` в файле игнорируется на запись — порядок берётся
  из позиции массива.

### 5.3. Валидация (двухслойная)

1. **Schema-слой.** YAML → объект → AJV против JSON Schema. Падает при
   нарушении формы (нет обязательного поля, неизвестный `type`, FEN не строка).
2. **Бизнес-слой.** То же, что DTO admin API:
   - `@IsFen` — chess.js валидирует строку FEN.
   - `@IsValidPgn` — chess.js#loadPgn парсит PGN, скобки парные.
   - `@ArePositionMovesLegal('fen')` — каждый UCI-ход легален от FEN.
   - `@IsVideoUrl` — host из whitelist'а.
   - `@IsCustomPuzzlesArray` — пошаговая прогонка `solutionMoves`.
   - `@IsEndgameWinCondition` / `@IsDrillPgn` — discriminated unions.

Импортер должен использовать те же декораторы (re-use `STEP_PAYLOAD_SUBTYPES`),
не дублировать их вручную. Это страхует от расхождения «schema-валидатор
говорит ОК, а DTO потом отвергает».

### 5.4. Идемпотентность

`deepEqualPayload(a, b)` — структурное сравнение JSON-объектов. Особенности:

- Порядок ключей в объекте не важен (JSONB.normalize).
- Массивы сравниваются по индексу (позиции значимы — diagrams[0] vs diagrams[1]).
- Строки сравниваются строго (включая trailing `\n`).

Если все три — `course`, `lesson`, `steps[*]` — не изменились, импортер
возвращает `{ ..., changes: 0 }` и не делает ни одного UPDATE. Полезно для
CI/CD, который повторно прогоняет импорт.

### 5.5. Diff-отчёт (CLI output)

```
$ tools/lesson-import import content/courses/capablanca-primer/02-chapter-2.lesson.yml

→ Validating schema...                 OK (0 errors)
→ Validating business rules...         OK (8 FEN, 6 PGN, 0 UCI)
→ Connecting to API at http://localhost:3001...
→ Authenticating as @staspivovartsev (admin email match)...
→ Loading current state from DB...

Course «capablanca-primer»:           unchanged
Lesson «chapter-2-p1-simple-mates»:   updated (fields: title, summary)

Steps (13 → 13):
  #1  text         unchanged
  #2  text         unchanged
  #3  game_review  updated  (payload diff: pgn line 4)
  #4  text         unchanged
  ...
  #12 text         updated  (payload diff: bodyMarkdown shortened by 2 lines)
  #13 game_review  unchanged

Summary: 0 created, 2 updated, 11 unchanged, 0 deleted.

Apply changes? [y/N]
```

Перед записью CLI спрашивает подтверждение, если есть изменения. С флагом
`--yes` подтверждение пропускается (для CI).

### 5.6. Ошибки и откаты

| Ситуация | Поведение |
|---|---|
| Schema-валидация упала | Не идёт в API, печатает path к ошибке (`steps[3].pgn: must be string`) |
| Бизнес-валидация упала на бэке | API возвращает 400 с детальным сообщением (chess.js error), импортер печатает |
| API упал в середине транзакции | Транзакция откатывается, БД остаётся в прежнем состоянии |
| Файл невалидный YAML | Печатает строка/колонка из `js-yaml` |
| `slug` курса/урока конфликтует | 409 Conflict от admin-сервиса (уже есть проверка) |

---

## 6. Поддержка существующих типов в БД

### 6.1. Что уже есть

Все поля формата §4 имеют 1-в-1 соответствие в БД и DTO:

- `text.body` ↔ `TextStepPayload.bodyMarkdown` ✓
- `text.diagrams[].arrows / .highlightedSquares` ↔ KS-1994 ✓ (в DTO с
  валидацией клеток в формате `[a-h][1-8]`)
- `game_review.pgn` ↔ `GameReviewStepPayload.pgn` ✓
- `puzzle.selection.{ids,filter,custom}` ↔ ADR-029 ✓
- `quiz` / `position` / `endgame_drill` / `opening_drill` / `video` — все
  payload-shape'ы стабилизированы.

**Миграции Prisma не требуются.** Это важный вывод: формат покрывает
весь существующий функционал без новых полей в БД.

### 6.2. Чего не хватает для импорта/upsert

Есть **один пробел в API** — нет admin-эндпоинта для пакетной записи.

Решение: добавить `POST /lessons/admin/import` (новый контроллер
`apps/api/src/lessons/admin/lessons-admin-import.controller.ts`). Его
сервис использует те же DTO, что текущий admin-CRUD, и единая
`prisma.$transaction` для всех операций.

Это — **отдельная backend-задача после утверждения ADR**. Архитектурно
ничего нового не вводится; новая ручка реиспользует существующие DTO и
валидаторы.

### 6.3. `course.slug` для upsert

В `Course.slug` уже стоит `@unique`, в `Lesson` — `@@unique([courseId, slug])`.
Этого достаточно для семантики upsert по slug'у (см. §5.2). Дополнительных
индексов не нужно.

### 6.4. Атомарная замена шагов и cascade

При `LessonStep.delete` каскадно удаляется:

- Сам шаг.
- Записи `UserLessonProgress.stepsState[stepId]` (это JSON-агрегат, не
  отдельная таблица — UPDATE на стороне приложения, если меняется состав
  шагов; в текущих скриптах это **не учитывается**, поэтому при перезаливе
  у пользователей в `stepsState` остаются битые ID).

Решение: импортер дополнительно обновляет
`UserLessonProgress.stepsState`, удаляя ключи отсутствующих шагов. Это
делается в той же транзакции после удаления шагов. **Это новое поведение,
которого в существующих скриптах нет** — ещё один аргумент за централизованный
импортер.

---

## 7. Миграция существующих уроков

Сейчас в БД залиты:

- `capablanca-primer` (курс) — KS-1985 / KS-1988.
  - Глава 1 — урок `ch1-game-pieces-moves-goal` (12 шагов).
  - §1 Главы 2 — урок `chapter-2-p1-simple-mates` (13 шагов).

Шаги для миграции:

1. **Backend пишет export-команду** в том же импортере (`tools/lesson-import
   export <course-slug>/<lesson-slug>`). Запрашивает `GET /lessons/admin/lessons/:id`,
   формирует YAML по схеме §4, печатает в stdout или пишет в файл.
2. **Архитектор / контент-редактор** копирует выгруженные YAML в
   `content/courses/capablanca-primer/`, проходит глазом, при необходимости
   правит (например, нотация, переформулировки).
3. **Прогон импортера** на этих же файлах:
   ```
   tools/lesson-import import content/courses/capablanca-primer/01-chapter-1.lesson.yml
   tools/lesson-import import content/courses/capablanca-primer/02-chapter-2-simple-mates.lesson.yml
   ```
4. **Удаление ad-hoc скриптов.** `/tmp/courses/lesson-01/seed.mjs`,
   `patch-arrows.mjs`, `lesson-02-ch2-p1-simple-mates/*.mjs` — больше не
   нужны.
5. **Источник истины переезжает** в `content/courses/` (commit'ится в
   репо). `/tmp/courses/parsed/primer/` (распаршенный FB2) остаётся как
   сырой материал, не для импорта.

Время миграции: ~1 час на урок (читать выгрузку, поправить мелкие косяки
типа `Учебник Капабланки` vs `Учебник шахматной игры` в caption'ах).

---

## 8. Roadmap

Декомпозиция по этапам — каждый этап = одна-две backend-задачи:

### Этап 1 — формат + импортер (text, game_review)

**Цель:** покрыть §2..§4 Главы 2 Капабланки, заменив ad-hoc скрипты.

- **B-1.** `tools/lesson-import` package — js-yaml + ajv + node fetch.
  CLI-команды `import` / `export` / `validate` / `dry-run`.
- **B-2.** JSON Schema `lesson.schema.json` + `course.schema.json`. Покрывает
  типы `text`, `game_review`, `quiz`, `position`, `puzzle`, `endgame_drill`,
  `opening_drill`, `video` — то есть **все 8** уже существующих shape'ов.
- **B-3.** Admin endpoint `POST /lessons/admin/import` + сервис
  `LessonsAdminImportService` с `prisma.$transaction`. Re-use существующих
  DTO для валидации payload'ов.
- **B-4.** Миграция Главы 1 и §1 Главы 2 в `content/courses/`. Удаление
  старых ad-hoc скриптов.

**DoD Этапа 1:** новый урок (§2 Главы 2 — «Преимущество в материале»)
заливается одной командой `tools/lesson-import import …` без программиста.

### Этап 2 — расширенные диаграммы

Уже поддержаны (KS-1994). Этого этапа фактически **нет** — это перенесено
из требования задачи в Этап 1. Документ по этому пункту корректирует
ожидание из описания задачи: миграции БД не нужны, всё уже есть.

### Этап 3 — `puzzle` author-mode

`puzzle.selection.mode = custom` уже работает (ADR-029). Импортер
поддерживает с Этапа 1. Дополнительной работы не требуется.

### Этап 4 — локализация (en/ru одной командой)

**Цель:** одной командой залить русскую и английскую версию одного и того
же урока, без дублирования контента, который не переводится (FEN, PGN,
структура диаграмм).

Варианты, к которым подойдём отдельной задачей:

- **A.** Один файл — две локали. Помечается полем `locale: ru` или
  `locales: [ru, en]`. Каждый текст становится `{ ru: '...', en: '...' }`.
  Минус: усложнение схемы для всех файлов сразу.
- **B.** Один курс — одна локаль (текущий подход). Параллельные курсы
  `capablanca-primer-ru` / `capablanca-primer-en`. Структура и FEN/PGN
  дублируются. Плюс: совместимо с текущей схемой БД без миграций. Это
  **рекомендуемый стартовый вариант** до появления второго языка
  (KS-1982 уже принял такое архитектурное решение для quiz).
- **C.** Раздельные файлы `xxx.ru.lesson.yml` / `xxx.en.lesson.yml`,
  объединённые `course.yml`-манифестом. Промежуточный путь между A и B.

Решение по локализации — **отдельный ADR** после того, как появится первый
англоязычный курс. До этого момента — Вариант B (один файл = один язык).

### Этап 5 — UI-редактор поверх формата

Долгосрочно: admin-UI в `apps/web/src/pages/admin/lessons/`, который
открывает YAML, рендерит превью, сохраняет файл и дёргает импортер. Это
выходит за рамки текущего ADR — отдельный документ после Этапа 1.

---

## Изменения в этом документе

- v1 (2026-04-27) — первый драфт, KS-2015. Описаны 8 разделов: анализ
  текущего состояния, требования, сравнение JSON/YAML/Markdown, спецификация,
  дизайн импортера, поддержка БД, миграция, roadmap.

## Что должен сделать пользователь по этому ADR

1. Утвердить рекомендацию по формату (YAML vs JSON5).
2. Утвердить решение «1 файл = 1 локаль» на v1 формата (Этап 4 → отдельный
   ADR позже).
3. Утвердить расположение `content/courses/<course-slug>/<lesson>.lesson.yml`
   и `course.yml`. Эта директория **commit**'ится в репо (в отличие от
   `/tmp/courses/`, который локальный).

После утверждения координатор заводит четыре backend-задачи (B-1..B-4)
по Этапу 1.
