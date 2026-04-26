# Lessons Admin API — гид для автора курса

> Как загрузить курс в Kingside через API, без написания кода.
> Аудитория: chess-expert, автор курса, ассистент. Знание Git/seed
> не нужно. Достаточно `curl` и текстового редактора.
>
> **Реализация:** KS-1962 (B-1..B-9), pull-request серии. Документ
> отражает API на момент завершения KS-1971 (B-9 e2e). Если backend
> поменяется — обновится этот документ.

---

## 0. TL;DR

1. Получить JWT-токен: `POST /auth/login` или `POST /auth/dev-bypass`
   (в dev). В ответе — `accessToken`.
2. Слать запросы с заголовком `Authorization: Bearer <accessToken>`.
3. Чтобы был доступ — твой email должен быть в ENV
   `LESSON_ADMIN_EMAILS` на бэке (попроси devops добавить).
4. CRUD под `/lessons/admin/*` (15 эндпоинтов): курсы, уроки, шаги.
5. Минимальный flow: создать курс → создать урок в курсе → создать
   шаги в уроке → опубликовать курс (`isPublished=true`).
6. Пилот-референс контента: `docs/courses/beginner/lesson-01-game.md`
   (KS-1961).

---

## 1. Подготовка

### 1.1 Базовый URL

В dev: `http://localhost:3001`. В prod — спросить devops (вероятно
`https://api.kingside.<domain>`).

> Везде в гиде — `$API_URL` как переменная окружения. Установи
> один раз:
>
> ```bash
> export API_URL=http://localhost:3001
> ```

### 1.2 Доступ — email в whitelist

Гарду `AdminEmailGuard` нужен твой email в ENV
`LESSON_ADMIN_EMAILS` (CSV, без пробелов):

```
LESSON_ADMIN_EMAILS=author@kingside.local,coach@kingside.local
```

Без этого любой запрос к `/lessons/admin/*` вернёт **403** с
сообщением `Admin access denied` (даже если токен валидный). Для
dev можно поставить `LESSON_ADMIN_EMAILS=*` — пропустит любого
аутентифицированного. **В prod так не делать.**

### 1.3 Получить JWT-токен

**Способ 1 — обычный логин (есть аккаунт):**

```bash
curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "author@kingside.local",
    "password": "your-password"
  }'
```

Ответ:

```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "eyJhbGciOi...",
  "requiresUsernameSetup": false
}
```

Сохрани `accessToken` в переменную:

```bash
export TOKEN=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"author@kingside.local","password":"your-password"}' \
  | jq -r .accessToken)
```

**Способ 2 — dev-bypass (только в dev-окружении):**

Если в `.env` API задан `DEV_BYPASS_SECRET` — можно получить токен
без пароля:

```bash
export TOKEN=$(curl -s -X POST "$API_URL/auth/dev-bypass" \
  -H "Content-Type: application/json" \
  -d '{"secret":"<value of DEV_BYPASS_SECRET>","user":"author@kingside.local"}' \
  | jq -r .accessToken)
```

`user` — username существующего юзера. Если такого нет, бэк
создаст его (сверяй по docs/окружению).

### 1.4 Проверка токена

```bash
curl -s "$API_URL/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Должен вернуть твой профиль (id, username, email и т. д.).
Если 401 — токен не подходит.

### 1.5 Заголовок для всех admin-запросов

```
Authorization: Bearer $TOKEN
Content-Type: application/json
```

В curl — `-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"`.

### 1.6 Refresh токена

`accessToken` живёт ограниченное время (по умолчанию ~15 минут).
Когда получаешь 401 в середине работы — обнови:

```bash
export TOKEN=$(curl -s -X POST "$API_URL/auth/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}" \
  | jq -r .accessToken)
```

---

## 2. Курсы

Базовый префикс: `/lessons/admin/courses`.

### 2.1 Список курсов

```bash
curl -s "$API_URL/lessons/admin/courses" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Включает и опубликованные, и draft (`isPublished: false`).

**Фильтры (query):**
- `?level=beginner|intermediate|advanced`
- `?published=true|false`

```bash
curl -s "$API_URL/lessons/admin/courses?level=beginner&published=false" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### 2.2 Получить курс по id

```bash
curl -s "$API_URL/lessons/admin/courses/<courseId>" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Возвращает курс + список уроков (без шагов) + счётчики.
`<courseId>` — UUID, не slug.

### 2.3 Создать курс

```bash
curl -s -X POST "$API_URL/lessons/admin/courses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "beginner-01-board-and-notation",
    "level": "beginner",
    "titleKey": "lessons.beginner-01.title",
    "descriptionKey": "lessons.beginner-01.description",
    "title": "Доска и нотация",
    "description": "Первый урок курса для начинающих: устройство доски и базовая запись.",
    "audience": "Никогда не играл в шахматы или знает о них только понаслышке.",
    "hook": "Узнаешь как устроена доска и научишься читать запись клеток (a1–h8) и ходов.",
    "outcome": "Можешь правильно поставить доску, знаешь цель партии (мат), читаешь запись e2-e4 и знаки.",
    "difficulty": 1,
    "estimatedMinutes": 12,
    "tags": ["fundamentals", "rules", "setup", "notation"],
    "order": 1,
    "isPublished": false
  }'
```

**Поля:**

| Поле | Обязательно | Описание |
|---|---|---|
| `slug` | да | kebab-case, уникальный среди курсов. `^[a-z0-9]+(?:-[a-z0-9]+)*$`. |
| `level` | да | `beginner` / `intermediate` / `advanced`. |
| `titleKey`, `descriptionKey` | да | Legacy i18n-ключи (для совместимости с seed). Можно ставить осмысленные, даже если не пользуешь. |
| `title`, `description` | нет | Inline-текст; на фронте имеет приоритет над `*Key`. |
| `audience`, `hook`, `outcome` | нет | Inline-тексты для карточки курса (KS-1931). До 500 символов. |
| `audienceI18nKey`, `hookI18nKey`, `outcomeI18nKey` | нет | i18n-ключи (если использовать переводы вместо inline). |
| `coverUrl` | нет | URL обложки (S3 / static). |
| `difficulty` | нет | 1 / 2 / 3 (default 2). |
| `estimatedMinutes` | нет | Оценка времени на курс. |
| `tags` | нет | До 10 тегов, до 40 символов каждый. |
| `order` | нет | Порядок в каталоге. По умолчанию — `max(order)+1`. |
| `isPublished` | нет | По умолчанию `false`. |

Ответ — полный объект курса с `id` (UUID). Сохрани:

```bash
export COURSE_ID=$(curl -s -X POST "$API_URL/lessons/admin/courses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @course.json \
  | jq -r .id)
```

### 2.4 Изменить курс (PATCH)

Любое поле `Create`-DTO + опционально. Например, опубликовать:

```bash
curl -s -X PATCH "$API_URL/lessons/admin/courses/$COURSE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isPublished": true}'
```

Изменить slug:

```bash
curl -s -X PATCH "$API_URL/lessons/admin/courses/$COURSE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "beginner-01-doska-i-notatsiya"}'
```

> ⚠️ Смена slug не ломает прогресс (он привязан к id), но старые
> ссылки `/lessons/<old-slug>` после публикации вернут 404.

### 2.5 Удалить курс

```bash
curl -s -X DELETE "$API_URL/lessons/admin/courses/$COURSE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -i
```

`HTTP/1.1 204 No Content` при успехе. Удаление **каскадное**:
вместе с курсом исчезают все его уроки, шаги и прогресс
пользователей. Рекомендация — сначала снять `isPublished`, дать
неделю, потом удалять.

### 2.6 Переупорядочить курсы

```bash
curl -s -X POST "$API_URL/lessons/admin/courses/reorder" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ]
  }'
```

`ids` — **полный** список UUID курсов в новом порядке (не подсписок).
Если не покрывает все существующие курсы — 400. Поле `order`
перезапишется значениями `1..N`.

---

## 3. Уроки

Все эндпоинты под `/lessons/admin`. Создание привязано к курсу;
GET/PATCH/DELETE — по id урока.

### 3.1 Создать урок в курсе

```bash
curl -s -X POST "$API_URL/lessons/admin/courses/$COURSE_ID/lessons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "board-and-notation",
    "blockKey": "rules",
    "kind": "theory",
    "titleKey": "lessons.beginner-01.l1.title",
    "summaryKey": "lessons.beginner-01.l1.summary",
    "title": "Доска и нотация",
    "summary": "Устройство доски, расстановка фигур, запись клеток и ходов.",
    "estMinutes": 12,
    "isPublished": false
  }'
```

**Поля:**

| Поле | Обязательно | Описание |
|---|---|---|
| `slug` | да | kebab-case, уникален в рамках курса. |
| `blockKey` | да | Группа уроков (например, `rules`, `basic-mates`). lowercase + `-`/`_`. |
| `kind` | да | `theory` / `tactics_set` / `endgame_set` / `opening_line` / `game_review` / `quiz`. |
| `titleKey`, `summaryKey` | да | Legacy i18n-ключи. |
| `title`, `summary` | нет | Inline-тексты. Приоритет над `*Key` на фронте. |
| `order` | нет | По умолчанию — конец курса. |
| `estMinutes` | нет | Оценка времени на урок (default 10). |
| `isPublished` | нет | По умолчанию `false`. |

Сохрани id:

```bash
export LESSON_ID=$(curl -s -X POST ... | jq -r .id)
```

### 3.2 Получить урок по id

```bash
curl -s "$API_URL/lessons/admin/lessons/$LESSON_ID" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Включает шаги (полный payload).

### 3.3 Изменить урок

```bash
curl -s -X PATCH "$API_URL/lessons/admin/lessons/$LESSON_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isPublished": true, "estMinutes": 14}'
```

### 3.4 Удалить урок

```bash
curl -s -X DELETE "$API_URL/lessons/admin/lessons/$LESSON_ID" \
  -H "Authorization: Bearer $TOKEN" -i
```

`204 No Content`. Каскад: удаляются все шаги, прогресс, повторения SM-2.

### 3.5 Переупорядочить уроки в курсе

```bash
curl -s -X POST "$API_URL/lessons/admin/courses/$COURSE_ID/lessons/reorder" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["<lessonId-1>", "<lessonId-2>", "<lessonId-3>"]
  }'
```

`ids` — полный список уроков курса. `204 No Content`.

---

## 4. Шаги

Под `/lessons/admin`. Создание привязано к уроку; PATCH/DELETE —
по id шага. **Reorder** — внутри урока.

### 4.1 Создать шаг (общая форма)

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "<тип шага>",
    "order": 1,
    "payload": { "type": "<тот же тип>", ...поля по типу }
  }'
```

> Поле `type` дублируется (на верхнем уровне DTO и внутри `payload`) —
> так требует валидатор дискриминированного union'а. Значения должны
> совпадать.

Поддерживаемые типы:
- `text` — TextStep (markdown + опц. диаграммы FEN, рендерятся
  read-only через `{{diagram:N}}` плейсхолдеры).
- `position` — PositionStep (FEN + **обязательный непустой**
  `expectedMoves[]`; интерактивная задача «найди ход»).
- `puzzle` — PuzzleStep (тактика по id'шникам, фильтру тем
  или авторские задачи inline).
- `quiz` — QuizStep (single/multi choice вопросы; `multi:
  boolean` управляет режимом).
- `video` — VideoStep (URL из whitelist'а хостов).
- `game_review` — GameReviewStep (PGN или `gameId`).
- `endgame_drill`, `opening_drill` — специальные drill'ы с
  движком Stockfish.

Ниже — примеры по 4 базовым типам пилота KS-1961.

### 4.2 TextStep

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "order": 1,
    "payload": {
      "type": "text",
      "bodyMarkdown": "Шахматы — игра для двоих. Ты играешь белыми фигурами, соперник — чёрными.\n\n### Доска\n\nШахматная доска — это квадрат из **64 клеток**...",
      "diagrams": []
    }
  }'
```

**Альтернативы:**
- `bodyI18nKey` вместо `bodyMarkdown` — если хочешь хранить текст в
  i18n-файлах. На пилоте KS-1961 рекомендуется inline (`bodyMarkdown`).
- `diagrams: [{ "fen": "...", "caption": "...", "orientation": "white" }]`
  — встроенные FEN-диаграммы внутри markdown'а.

### 4.3 PositionStep

> ⚠️ **Важно:** `PositionStep` — это **интерактивная задача
> «найди ход»**, не «просто показать доску». Поле
> `expectedMoves: string[]` обязательно (`@ArrayNotEmpty +
> @ArePositionMovesLegal`). Поля `caption` в DTO нет.
>
> **Если нужно «просто показать» доску read-only** — используй
> `TextStep` с массивом `diagrams[]` (см. §4.2 и пример Шага 2 в
> §5.4). Диаграммы внутри TextStep рендерятся read-only «из коробки».

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "position",
    "order": 2,
    "payload": {
      "type": "position",
      "fen": "rnbqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
      "expectedMoves": ["d2d3", "e1g1"],
      "orientation": "white"
    }
  }'
```

**Поля:**
- `fen` (обяз.) — стартовая позиция, валидируется как валидный FEN.
- `expectedMoves` (обяз., непустой массив) — допустимые UCI-ходы
  студента (любой из списка засчитывается). Каждый ход проверяется
  на легальность относительно `fen`.
- `orientation` — `'white'` / `'black'` (по умолчанию `white`).

Полный shape — `apps/api/src/lessons/dto/step-payload.dto.ts`
(`PositionStepPayloadDto`).

### 4.4 QuizStep

> ⚠️ **Важно:** в `QuizQuestion` / `QuizOption` поля только
> `*I18nKey` — `promptI18nKey`, `labelI18nKey`,
> `explanationI18nKey`. Полей `*Markdown` (`promptMarkdown` и
> т. п.) **в DTO нет** — валидатор отвергнет.
>
> **Как использовать без настоящих переводов:** клади текст прямо
> в `*I18nKey`-поле строкой. Если на фронте этот ключ не найдётся
> в i18n-словаре, i18next отрендерит само значение ключа как
> fallback — для одиночного языка контента это работает. Когда
> понадобится локализация, заменишь строки на реальные ключи
> вида `lessons.beginner.l1.q1.prompt` и пропишешь переводы в
> i18n-файлах.
>
> Дискриминатор «один/несколько правильных» — поле `multi:
> boolean` (по умолчанию `false`), а **не** `kind: 'single'/'multi'`.

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "quiz",
    "order": 5,
    "payload": {
      "type": "quiz",
      "passThreshold": 0.83,
      "questions": [
        {
          "id": "q1",
          "promptI18nKey": "Сколько клеток на шахматной доске?",
          "options": [
            { "id": "a", "labelI18nKey": "32" },
            { "id": "b", "labelI18nKey": "49" },
            { "id": "c", "labelI18nKey": "64" },
            { "id": "d", "labelI18nKey": "100" }
          ],
          "correctOptionIds": ["c"],
          "explanationI18nKey": "8 рядов по 8 клеток = 64."
        },
        {
          "id": "q2",
          "promptI18nKey": "Кто ходит первым в шахматах?",
          "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          "options": [
            { "id": "a", "labelI18nKey": "Чёрные" },
            { "id": "b", "labelI18nKey": "Белые" },
            { "id": "c", "labelI18nKey": "Тот, кто старше" }
          ],
          "correctOptionIds": ["b"],
          "explanationI18nKey": "Стандарт: первыми ходят белые."
        }
      ]
    }
  }'
```

**Поля вопроса (`QuizQuestion`):**
- `id` (обяз., строка) — стабильный id вопроса.
- `promptI18nKey` (обяз.) — i18n-ключ или fallback-строка вопроса.
- `fen` (опц.) — диаграмма над вопросом.
- `options[]` (обяз., минимум 2) — варианты `{ id, labelI18nKey }`.
- `correctOptionIds[]` (обяз., непустой) — для одиночного выбора
  ровно один id; для множественного — несколько.
- `multi` (опц., default `false`) — `true` если правильных
  ответов несколько.
- `explanationI18nKey` (опц.) — разбор после ответа.

**Поля шага (`QuizStepPayload`):**
- `questions[]` (обяз., непустой).
- `passThreshold` (опц., default 0.7) — доля правильных 0..1
  для зачёта.

**Пример вопроса с несколькими правильными ответами (multi):**

```json
{
  "id": "q-multi",
  "multi": true,
  "promptI18nKey": "Какие фигуры ходят по диагонали?",
  "options": [
    { "id": "a", "labelI18nKey": "Слон" },
    { "id": "b", "labelI18nKey": "Ладья" },
    { "id": "c", "labelI18nKey": "Ферзь" },
    { "id": "d", "labelI18nKey": "Конь" }
  ],
  "correctOptionIds": ["a", "c"],
  "explanationI18nKey": "По диагонали ходят слон и ферзь."
}
```

### 4.5 PuzzleStep

`PuzzleStepPayload` имеет два поля: `selection` (дискриминированный
union по `mode`) + опциональный `minSolved` (сколько задач должен
решить ученик для зачёта; по умолчанию — все).

**Mode 1: фильтр по темам и рейтингу.**

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "puzzle",
    "order": 3,
    "payload": {
      "type": "puzzle",
      "selection": {
        "mode": "filter",
        "themes": ["fork"],
        "ratingMin": 800,
        "ratingMax": 1200,
        "limit": 5
      },
      "minSolved": 3
    }
  }'
```

`limit` обязательный (1..100). `ratingMin`/`ratingMax`
опциональны. `themes` — непустой массив.

**Mode 2: жёсткая привязка к id'шникам задач.**

```json
{
  "type": "puzzle",
  "selection": {
    "mode": "ids",
    "puzzleIds": ["DEV-001", "DEV-002", "DEV-003"]
  }
}
```

**Mode 3: авторские задачи прямо в payload (KS-1908 / ADR-029).**

Не привязывается к системной puzzle-БД, FEN + UCI-решение
описываются inline:

```json
{
  "type": "puzzle",
  "selection": {
    "mode": "custom",
    "customPuzzles": [
      {
        "fen": "8/8/8/8/4k3/8/4K3/4Q3 w - - 0 1",
        "solutionMoves": ["e2e3", "e4d4", "e3d3"],
        "orientation": "white",
        "themes": ["mate", "endgame"],
        "captionI18nKey": "Мат двумя ходами."
      }
    ]
  }
}
```

`customPuzzles` валидируется пошагово через `chess.js`. Лимиты
длины массива и `solutionMoves` — в `USER_COURSES_LIMITS`.

Полный shape всех вариантов — `apps/api/src/lessons/dto/step-payload.dto.ts`
(`PuzzleSelectionIdsDto`, `PuzzleSelectionFilterDto`,
`PuzzleSelectionCustomDto`).

### 4.6 PATCH шага

Изменить порядок:

```bash
curl -s -X PATCH "$API_URL/lessons/admin/steps/$STEP_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"order": 4}'
```

Изменить payload (без смены типа):

```bash
curl -s -X PATCH "$API_URL/lessons/admin/steps/$STEP_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "type": "text",
      "bodyMarkdown": "Обновлённый текст урока..."
    }
  }'
```

Сменить тип — `payload` обязателен (бэк вернёт 400 без него):

```bash
curl -s -X PATCH "$API_URL/lessons/admin/steps/$STEP_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "quiz",
    "payload": { "type": "quiz", "passThreshold": 0.7, "questions": [ ... ] }
  }'
```

### 4.7 Удалить шаг

```bash
curl -s -X DELETE "$API_URL/lessons/admin/steps/$STEP_ID" \
  -H "Authorization: Bearer $TOKEN" -i
```

`204 No Content`. На прогресс пользователей не влияет (запись в
`stepsState` останется как «висящий» stepId — фронт его проигнорирует).

### 4.8 Переупорядочить шаги в уроке

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps/reorder" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["<step-1>", "<step-2>", "<step-3>", "<step-4>", "<step-5>"]
  }'
```

`ids` — **полный** список шагов урока (иначе 400). `204 No Content`.

---

## 5. Полный flow — завести пилот «Доска и нотация»

Ниже — пошаговый сценарий загрузки пилотного урока KS-1961 в БД.
Контент-источник: `docs/courses/beginner/lesson-01-game.md`.

### 5.1 Подготовка

```bash
export API_URL=http://localhost:3001
export TOKEN=$(curl -s -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"author@kingside.local","password":"<pass>"}' \
  | jq -r .accessToken)
```

### 5.2 Создать курс «Beginner»

```bash
export COURSE_ID=$(curl -s -X POST "$API_URL/lessons/admin/courses" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "beginner",
    "level": "beginner",
    "titleKey": "lessons.beginner.title",
    "descriptionKey": "lessons.beginner.description",
    "title": "Beginner",
    "description": "Базовый курс шахмат для новичков.",
    "audience": "Никогда не играл или знает только правила.",
    "hook": "За 12 уроков научишься не зевать фигуры и доводить выигранную позицию.",
    "outcome": "После курса: понимаешь правила и нотацию, видишь базовую тактику, доводишь К+Ф vs К.",
    "difficulty": 1,
    "estimatedMinutes": 240,
    "tags": ["fundamentals", "course"],
    "order": 1,
    "isPublished": false
  }' | jq -r .id)
echo "COURSE_ID=$COURSE_ID"
```

### 5.3 Создать урок 1 в курсе

```bash
export LESSON_ID=$(curl -s -X POST "$API_URL/lessons/admin/courses/$COURSE_ID/lessons" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "board-and-notation",
    "blockKey": "rules",
    "kind": "theory",
    "titleKey": "lessons.beginner.l1.title",
    "summaryKey": "lessons.beginner.l1.summary",
    "title": "Доска и нотация",
    "summary": "Устройство доски, расстановка, запись клеток и ходов.",
    "estMinutes": 12,
    "isPublished": false
  }' | jq -r .id)
echo "LESSON_ID=$LESSON_ID"
```

### 5.4 Создать 5 шагов урока

> Тексты ниже — выжимка из `docs/courses/beginner/lesson-01-game.md`.
> Полные markdown-блоки переноси из исходного документа без сокращений.
>
> ⚠️ **Важно про read-only показ доски:** `PositionStep` требует
> непустой `expectedMoves` (это интерактивная задача, см. §4.3). Для
> «просто показать доску» (Шаги 2 и 4 пилота) используем `TextStep`
> с `diagrams[]` — диаграммы внутри TextStep рендерятся read-only
> «из коробки». Шаги 1 и 2 в исходном `lesson-01-game.md` логически
> объединяются в один TextStep с одной диаграммой; шаги 3 и 4 — в
> другой TextStep с одной диаграммой. Итого получается 3 шага вместо
> 5: Text+diagram → Text+diagram → Quiz.
>
> Альтернатива (если хочется отдельной «полнокадровой» доски без
> текста) — попросить backend добавить read-only вариант
> PositionStep с опциональным `expectedMoves`. Для пилота это не
> сделано; ниже — рабочий вариант через TextStep+diagrams.

**Шаг 1 — TextStep «Что такое шахматы» + начальная позиция:**

```bash
curl -s -X POST "$API_URL/lessons/admin/lessons/$LESSON_ID/steps" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @step-1-text.json
```

`step-1-text.json`:

```json
{
  "type": "text",
  "order": 1,
  "payload": {
    "type": "text",
    "bodyMarkdown": "Шахматы — игра для двоих. Ты играешь белыми фигурами, соперник — чёрными.\n\n### Доска\n\nШахматная доска — это квадрат из **64 клеток**...\n\n(полный текст из docs/courses/beginner/lesson-01-game.md, Шаг 1)\n\n{{diagram:0}}",
    "diagrams": [
      {
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "caption": "Так выглядит позиция в начале каждой партии. Белое угловое поле — справа? Ферзь стоит на своём цвете?",
        "orientation": "white"
      }
    ]
  }
}
```

> Плейсхолдер `{{diagram:0}}` в markdown указывает место отрисовки
> диаграммы из массива `diagrams[]` (индекс 0). См.
> `apps/web/src/components/lessons/steps/TextStep.tsx`.

**Шаг 2 — TextStep «Шахматная нотация» + координатная карта:**

```json
{
  "type": "text",
  "order": 2,
  "payload": {
    "type": "text",
    "bodyMarkdown": "Чтобы говорить о ходах, нужен общий язык...\n\n(полный текст из docs/courses/beginner/lesson-01-game.md, Шаг 3)\n\n{{diagram:0}}",
    "diagrams": [
      {
        "fen": "8/8/8/8/8/8/8/8 w - - 0 1",
        "caption": "Пустая доска с координатной разметкой. Где e4? Где a1? Где h8?",
        "orientation": "white"
      }
    ]
  }
}
```

**Шаг 3 — QuizStep (6 вопросов):**

```json
{
  "type": "quiz",
  "order": 3,
  "payload": {
    "type": "quiz",
    "passThreshold": 0.83,
    "questions": [
      { "id": "q1",
        "promptI18nKey": "Сколько клеток на шахматной доске?",
        "options": [
          { "id": "a", "labelI18nKey": "32" },
          { "id": "b", "labelI18nKey": "49" },
          { "id": "c", "labelI18nKey": "64" },
          { "id": "d", "labelI18nKey": "100" }
        ],
        "correctOptionIds": ["c"],
        "explanationI18nKey": "8 рядов по 8 клеток = 64."
      },
      { "id": "q2",
        "promptI18nKey": "Кто ходит первым в шахматах?",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "options": [
          { "id": "a", "labelI18nKey": "Чёрные" },
          { "id": "b", "labelI18nKey": "Белые" },
          { "id": "c", "labelI18nKey": "Тот, кто старше" },
          { "id": "d", "labelI18nKey": "Тот, кто проиграл прошлую партию" }
        ],
        "correctOptionIds": ["b"],
        "explanationI18nKey": "Стандарт: первыми ходят белые."
      },
      { "id": "q3",
        "promptI18nKey": "Где должно находиться белое угловое поле?",
        "options": [
          { "id": "a", "labelI18nKey": "Слева" },
          { "id": "b", "labelI18nKey": "Справа" },
          { "id": "c", "labelI18nKey": "Прямо перед тобой" },
          { "id": "d", "labelI18nKey": "Не имеет значения" }
        ],
        "correctOptionIds": ["b"],
        "explanationI18nKey": "Доску всегда ставят так, чтобы белое угловое поле было справа."
      },
      { "id": "q4",
        "promptI18nKey": "Какая цель шахматной партии?",
        "options": [
          { "id": "a", "labelI18nKey": "Снять как можно больше фигур" },
          { "id": "b", "labelI18nKey": "Перевести пешку на последний ряд" },
          { "id": "c", "labelI18nKey": "Поставить мат королю соперника" },
          { "id": "d", "labelI18nKey": "Сыграть как можно дольше" }
        ],
        "correctOptionIds": ["c"],
        "explanationI18nKey": "Цель — мат: атаковать короля так, чтобы у соперника не было защиты."
      },
      { "id": "q5",
        "promptI18nKey": "На какой клетке стоит белый король в начальной позиции?",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "options": [
          { "id": "a", "labelI18nKey": "d1" },
          { "id": "b", "labelI18nKey": "e1" },
          { "id": "c", "labelI18nKey": "e8" },
          { "id": "d", "labelI18nKey": "a1" }
        ],
        "correctOptionIds": ["b"],
        "explanationI18nKey": "В начальной позиции белый король стоит на e1."
      },
      { "id": "q6",
        "promptI18nKey": "Что означает запись 0-0 в шахматной партии?",
        "options": [
          { "id": "a", "labelI18nKey": "Партия закончилась 0:0" },
          { "id": "b", "labelI18nKey": "Игрок пропустил ход" },
          { "id": "c", "labelI18nKey": "Игрок сделал короткую рокировку" },
          { "id": "d", "labelI18nKey": "Игрок предложил ничью" }
        ],
        "correctOptionIds": ["c"],
        "explanationI18nKey": "0-0 — короткая рокировка. 0-0-0 — длинная."
      }
    ]
  }
}
```

### 5.5 Опубликовать урок и курс

```bash
# опубликовать урок
curl -s -X PATCH "$API_URL/lessons/admin/lessons/$LESSON_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isPublished": true}'

# опубликовать курс
curl -s -X PATCH "$API_URL/lessons/admin/courses/$COURSE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isPublished": true}'
```

### 5.6 Проверить на фронте

Открой в браузере: `http://localhost:5173/lessons` — курс должен
появиться в списке beginner. Кликни → пройди урок.

---

## 6. Типичные ошибки

| Код | Когда | Что делать |
|---|---|---|
| **401** | Нет/просрочен токен | `POST /auth/refresh` или новый `/auth/login` |
| **403** `Admin access denied` | Email не в `LESSON_ADMIN_EMAILS` | Попроси devops добавить email в ENV и перезапустить API |
| **403** `Admin access disabled` | ENV `LESSON_ADMIN_EMAILS` пустая | DevOps выставит ENV |
| **400** `slug must be kebab-case` | Неправильный slug (CamelCase / underscore / двойной дефис) | Только `[a-z0-9-]+`, без `--` и trailing `-` |
| **409** Conflict | Slug курса уже занят, или slug урока в этом курсе | Возьми другой slug или удали/переименуй существующий |
| **400** на payload шага | Не совпали `type` верхний и в payload, или payload некорректен по форме типа | Перепроверь shape в `apps/api/src/lessons/dto/step-payload.dto.ts` или соответствующих `*-step.dto.ts` |
| **400** `expectedMoves should not be empty` (PositionStep) | Послан PositionStep без `expectedMoves` или с пустым массивом | Это интерактивный тип «найди ход», добавь массив легальных UCI-ходов. Для read-only показа доски — используй TextStep с `diagrams[]` (см. §4.2, §5.4) |
| **400** `property * should not exist` (QuizStep) | В Quiz передаются `*Markdown` поля (`promptMarkdown`, `labelMarkdown`, `explanationMarkdown`) либо `kind: 'single'/'multi'` | DTO принимает только `*I18nKey` поля и `multi: boolean`. См. §4.4 — клади текст прямо в `*I18nKey`-строки (i18next отрендерит fallback'ом) |
| **400** при reorder | `ids` не покрывает все курсы/уроки/шаги | Подгрузи через GET список — передай **полный** массив |
| **400** PATCH шага со сменой type без payload | Бэк требует payload при смене type | Передай и `type`, и `payload` |
| **404** при PATCH/DELETE | Неправильный UUID или ресурс удалён | Проверь GET перед операцией |

---

## 7. Полезные ссылки

- **Концепт** admin API: `docs/architecture/KS-1962-system-courses-admin-api.md`
- **Контент-референс** (markdown пилотного урока):
  `docs/courses/beginner/lesson-01-game.md` (KS-1961)
- **Программа курса** beginner (12 уроков): `docs/architecture/KS-1959-beginner-course-content.md`
- **Поля DTO шагов** (полная справка по типам):
  - `apps/api/src/lessons/dto/step-payload.dto.ts`
  - `apps/api/src/lessons/dto/position-step.dto.ts`
  - `apps/api/src/lessons/dto/video-step.dto.spec.ts` — допустимые хосты для VideoStep
  - `apps/api/src/lessons/dto/game-review-step.dto.spec.ts`
  - `apps/api/src/lessons/dto/endgame-drill-step.dto.spec.ts`
  - `apps/api/src/lessons/dto/opening-drill-step.dto.spec.ts`
- **Контракты** в shared: `packages/shared/src/types/lessons.ts`

## 8. Что НЕ закрывает этот гид

- Загрузка обложки курса (`coverUrl`) — пока ставится строкой URL.
  Upload через API — отдельная задача.
- UI-админка — пока только curl/Postman. Frontend-админка
  (KS-1962 §8.2 F-1..F-6) — отдельная задача.
- Управление i18n-переводами через API — для inline-полей не нужно;
  для seed'а правится JSON в `apps/{api,web}/src/i18n/`.
- Bulk-импорт markdown → курс — отвергнуто на MVP (KS-1962 §7.3).
  Сейчас каждый шаг создаётся отдельным POST'ом.
