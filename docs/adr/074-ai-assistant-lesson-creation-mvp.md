# ADR-074. AI-ассистент создаёт уроки — MVP

Статус: предложен (2026-05-21)
Связано: KS-3204 (этот ADR), ADR-061 (MCP API auto-discovery),
ADR-063 (Assistant knowledge source), ADR-026 (User Courses),
ADR-049 (Feature parity), ADR-072 (тип шага «Партия»).

## 1. Контекст

В проекте есть AI-чат (`apps/api/src/ai-chat/`, провайдер Anthropic
Claude, модель `claude-sonnet-4-20250514`, стрим через SSE). На фронте —
`apps/web/src/components/ChatWidget.tsx`. Текущая реализация — **text-only**:
модель отвечает свободным текстом, **tool-use не задействован** в
`streamResponse()` (см. срез по коду — функционал не подключён, хотя
SDK Anthropic его поддерживает).

Параллельно ADR-061 даёт каталог MCP-инструментов через декораторы
`@McpModule` / `@McpTool` и discovery-endpoint `GET /_mcp/tools`
(80+ tools уже размечены). ADR-063 — слой knowledge-tools для
ассистента (поиск/чтение whitelisted-файлов).

User-courses API готов: `POST /api/lessons/courses` (создание курса),
`POST /api/lessons/courses/:id/lessons` (урок), `POST
/api/lessons/lessons/:id/steps` (шаг). Авторизация — `JwtAuthGuard`
+ `UserCourseOwnerGuard`. Лимиты — `coursesPerUser: 20`,
`lessonsPerCourse: 30`, `stepsPerLesson: 50` (см.
`user-courses-limits.ts`). Разрешённые типы шагов: `text`, `puzzle`,
`endgame_drill`, `quiz`, `game` (ADR-026, расширено ADR-049/072).

Запрос: научить ассистента создавать уроки по сценарию «пользователь
формулирует тему → ассистент строит план → пользователь подтверждает
→ ассистент создаёт курс/урок/шаги через tools».

## 2. Решение (контур MVP)

1. Подключить **tool-use Anthropic API** в `ChatAssistantService` —
   универсальный механизм для всех будущих агентских сценариев,
   не только уроков.
2. Помечать tools, безопасные для пользователя, новой меткой
   `@McpToolForAssistant` (whitelist). Из 80+ tools ассистенту дать
   доступ к 4: 3 для создания (course/lesson/step) + 1 для финального
   URL.
3. UX подтверждения — **текстовое** («да / создать / отмена»), без
   кастомных интерактивных компонентов в чат-сообщении. Это
   стандартный паттерн агента и не требует переписывать рендерер
   сообщений. Кнопки — отдельный enhancement M2.
4. Содержимое шагов в MVP: `text` и `quiz` — ассистент генерирует
   контент сам; `puzzle`, `game`, `endgame_drill` — НЕ генерирует,
   создаёт вместо них `text`-плейсхолдер с инструкцией автору
   («Здесь автор должен выбрать задачу / партию вручную»). Это
   честный UX — ассистент строит скелет и пишет лекционный/тестовый
   контент, остальное — за человеком.
5. Audit и лимиты: отдельная таблица `ai_lesson_generations` +
   per-user rate-limit «5 успешных созданий в час».
6. Никаких новых backend-endpoint'ов для уроков — используем
   существующие (`POST /api/lessons/courses`, `…/lessons`,
   `…/steps`); MCP-tools исполняются через них с JWT текущего
   пользователя (owner-check работает out-of-the-box).

## 3. UX в чате

### 3.1 Этапы диалога

```
User:  Сделай мне урок про защиту Каро-Канн для новичков, 5 шагов.

AI:    Готов сделать. Вот план:

       **Курс**: «Защита Каро-Канн — основы»
       **Урок**: «Основные идеи 1.e4 c6»
       **Шаги**:
       1. [Лекция] Идея дебюта и ключевые поля c5/d5/e4
       2. [Лекция] Главная линия 2.d4 d5 — обзор разветвлений
       3. [Тест] 3 вопроса на понимание идей
       4. [Партия — плейсхолдер] Автор выбирает классический пример
       5. [Лекция] Типичные ошибки новичков

       Создаю? Напишите «да» для подтверждения или скажите, что
       поправить.

User:  да

AI:    Создаю курс…
       [tool_use: create_user_course → courseId=…]
       Создаю урок…
       [tool_use: create_user_lesson → lessonId=…]
       Добавляю шаги…
       [tool_use: create_user_lesson_step ×5]

       Готово. Курс создан: [«Защита Каро-Канн — основы»](/lessons/
       my/zashchita-karo-kann-osnovy/edit)

       4-й шаг — плейсхолдер, добавьте туда партию вручную через
       редактор.
```

### 3.2 Принципы

- **Никаких кастомных UI-кнопок** в чат-сообщении на MVP.
  Подтверждение — словом. Рендерер сообщений остаётся прежним
  (markdown).
- **Tool-use события** в стриме показываем в UI компактной строкой
  «Создаю …» (один tool = одна строка), без вывода JSON-полей. Если
  tool упал — показываем ошибку, отменяем дальнейшие вызовы, просим
  пользователя повторить.
- **Ссылка на созданный курс** — обычная markdown-ссылка в финальном
  ответе. Уводит в редактор пользовательских курсов
  (`/lessons/my/:slug/edit`, см. `App.tsx:473`).
- **Cancel-команды**: «отмена», «не надо», «cancel», «передумал» —
  ассистент НЕ вызывает tools. Простая инструкция в system-prompt'е,
  без отдельного state-machine.

### 3.3 Где встраивать

Универсальный `ChatWidget`, без отдельной кнопки «Создать урок».
Триггер — намерение пользователя в тексте. Это правильнее, чем
дублировать UI: один диалог — много сценариев. Кнопка в редакторе
курсов («Помочь с уроком через AI») — это уже M2-усиление, не MVP.

## 4. Tool-use в ассистенте

### 4.1 Anthropic tool-use loop

Anthropic SDK поддерживает tool-use через параметр `tools: [...]` в
`messages.create()`. Ответ модели может содержать блок
`stop_reason: 'tool_use'`. Клиент исполняет tool и шлёт обратно
`tool_result`. Цикл повторяется до `stop_reason: 'end_turn'`.

В `ChatAssistantService.streamResponse()` добавляется loop:

```ts
let messages = [{ role: 'user', content: userMessage }];
const tools = await mcpAssistantToolsRegistry.list(); // см. §4.2

for (let i = 0; i < MAX_TOOL_TURNS; i++) {
  const stream = await anthropic.messages.stream({
    model: CHAT_MODEL, max_tokens: CHAT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools, messages,
  });

  // 1. Стримим текст пользователю.
  // 2. Собираем tool_use-блоки (id, name, input).
  // 3. При stop_reason='end_turn' — выходим.
  // 4. При stop_reason='tool_use':
  //    - исполняем каждый tool через mcpToolExecutor.invoke(name, input, userJwt)
  //    - формируем tool_result-блоки
  //    - добавляем в messages и продолжаем loop
}
```

`MAX_TOOL_TURNS` = 8 (защита от бесконечного цикла; нормальный
урок-создающий поток укладывается в 2–3 шага tool-use).

### 4.2 Whitelist tools для ассистента

Не все 80+ MCP-tools должны быть доступны ассистенту. Например,
`delete_account`, `block_user`, `admin_*` — нельзя. Решение:

- Добавить опциональный флаг в декоратор `@McpTool({ assistant: true })`
  ИЛИ новый отдельный декоратор `@McpToolForAssistant()` (для
  совместимости с ADR-061, без переписывания существующих).
- `mcpAssistantToolsRegistry` отдаёт только tools с этим флагом, в
  формате Anthropic `tools`-параметра (name, description,
  input_schema = JSON-schema из существующего `DtoToJsonSchema`).

Для MVP помечаем `assistant: true` ровно 4 tool'а в lessons-модуле:

- `create_user_course(input: { title, description? }) → { id, slug, url }`
- `create_user_lesson(input: { courseId, title, estMinutes? }) → { id }`
- `create_user_lesson_step(input: { lessonId, type, payload }) →
  { id }`
- `get_user_course_url(input: { courseId }) → { url }` — derived,
  возвращает `/lessons/my/:slug/edit`.

`knowledge.search`/`knowledge.read` (ADR-063) — отдельный M2-этап
для подбора материалов, в MVP не используется (ассистент пишет
лекции из своих знаний без сорсинга).

### 4.3 Авторизация tool-вызовов

Tools исполняются от имени пользователя чата. В чат-сессии уже есть
JWT (`AuthContext` на фронте, прокинут в Bearer-header на API).
`mcpToolExecutor.invoke(name, input, userJwt)` транслирует это в
внутренний HTTP-вызов соответствующего REST-endpoint'а с тем же JWT.
Owner-check работает прозрачно: `POST /api/lessons/courses` создаст
курс с `ownerId = currentUserId`.

Для production-устойчивости лучше **вызывать сервисы напрямую**
(минуя HTTP-loopback) — через DI обращаться к
`UserCoursesService.create(userId, dto)`. MCP-tool слой получает
`request.user.id` из контекста и пробрасывает его. Это убирает
сетевой круг и упрощает обработку ошибок.

### 4.4 System-prompt — дополнение

Добавляем секцию (≤ 30 строк) поверх существующего system-prompt'а:

```
СОЗДАНИЕ УРОКОВ

Когда пользователь просит создать урок/курс:

1. СНАЧАЛА построй план в markdown:
   - Название курса
   - Название урока
   - Список шагов с типами в квадратных скобках: [Лекция], [Тест],
     [Партия — плейсхолдер], [Задача — плейсхолдер], [Эндшпиль —
     плейсхолдер]
2. Жди ЯВНОГО подтверждения пользователя («да», «создавай»,
   «подтверждаю», «ок, создай»). Если пользователь вместо
   подтверждения попросил поправить — поправь план и снова жди
   подтверждения.
3. ТОЛЬКО ПОСЛЕ подтверждения вызывай tools:
   - create_user_course
   - create_user_lesson
   - create_user_lesson_step (по одному на шаг)
4. Содержимое шагов:
   - text/quiz — пиши контент сам.
   - puzzle/game/endgame_drill — НЕ ВЫЗЫВАЙ соответствующие tools
     с этим типом. Вместо них создавай text-шаг с подписью
     «Здесь автор выбирает <задачу|партию|эндшпиль> вручную через
     редактор».
5. В финальном сообщении дай ссылку на курс
   (get_user_course_url) и кратко перечисли, что осталось доделать
   автору.

Лимиты на одно создание:
- Один курс с одним уроком за раз.
- Не более 10 шагов в уроке.
- Длина text-body ≤ 4000 символов на шаг.
- Quiz: 1–5 вопросов, в каждом 2–4 варианта.

Если пользователь явно НЕ просил создать урок — НЕ вызывай эти
tools, отвечай текстом.
```

### 4.5 Multi-turn vs single-turn

В MVP — multi-turn (план → подтверждение → tools — два хода
пользователя минимум). Single-turn («создай сразу») — добавим
как опцию, если поступит запрос; для MVP его НЕ поддерживаем,
чтобы избежать «случайных» курсов.

## 5. Backend — что нужно поменять

### 5.1 ai-chat: tool-use loop

`ChatAssistantService.streamResponse()` — расширить (см. §4.1).
Передавать `tools` параметр в Anthropic.messages.stream. Парсить
tool_use-блоки в стриме. Цикл с `MAX_TOOL_TURNS = 8`. Streaming в SSE
дополняется новым типом события `tool_call` (компактный JSON
`{name, status: 'running' | 'ok' | 'error'}`) — фронт рендерит
строкой «Создаю курс…».

### 5.2 MCP: пометка assistant-доступных tools

Добавить опцию в существующий декоратор:
`@McpTool({ description: '...', assistant: true })`. Обновить
discovery-сервис, чтобы при формировании каталога для ассистента
включал только tools с `assistant === true`.

Альтернативно — отдельный реестр `McpAssistantRegistry` без правки
существующего `@McpTool`. На совместимость с ADR-061 это легче.
Рекомендую отдельный реестр — изменения в существующем декораторе
тянут пересборку всех 80+ маркеров, лишний риск.

### 5.3 Lessons-модуль: 4 tools

В контроллерах lessons-модуля (где уже стоит `@McpTool` для GET'ов)
явно пометить три POST'а как assistant-tools:

- `LessonCoursesController.createUserCourse` →
  `@McpToolForAssistant({ name: 'create_user_course' })`
- `LessonCoursesController.createUserLesson` →
  `@McpToolForAssistant({ name: 'create_user_lesson' })`
- `LessonStepsController.createUserLessonStep` →
  `@McpToolForAssistant({ name: 'create_user_lesson_step' })`

Плюс derived-tool `get_user_course_url` — лёгкий метод сервиса,
возвращает `/lessons/my/:slug/edit` по `courseId`.

### 5.4 Audit-таблица и rate-limit

Новая таблица `ai_lesson_generations`:

```prisma
model AiLessonGeneration {
  id            String   @id @default(uuid()) @db.Uuid
  userId        String   @map("user_id") @db.Uuid
  conversationId String? @map("conversation_id")
  planJson      Json     @map("plan_json")
  createdCourseId String? @map("created_course_id") @db.Uuid
  status        String   // 'planned' | 'created' | 'failed' | 'cancelled'
  errorMessage  String?  @map("error_message")
  createdAt     DateTime @default(now()) @map("created_at")

  user   User    @relation(fields: [userId], references: [id])
  course Course? @relation(fields: [createdCourseId], references: [id])

  @@index([userId, createdAt])
  @@map("ai_lesson_generations")
}
```

Service пишет одну запись в момент tool_use create_user_course
(plan уже известен из предыдущего ответа модели). После завершения
последнего tool — обновляет `status='created'` и `createdCourseId`.
При сбое — `status='failed'` + `errorMessage`.

Rate-limit: `@UserRateLimit(5, 3600)` на endpoint
`create_user_course` — 5 успешных созданий курса в час на
пользователя. Превышение — tool возвращает ошибку «лимит
превышен», ассистент сообщает в чат.

Существующие лимиты user-courses (`coursesPerUser: 20`) сохраняют
работу — превышение даст 400 с понятным сообщением, ассистент
передаст его в чат.

### 5.5 Хард-лимиты на payload

В DTO `create_user_lesson_step` через class-validator:

- `text.body` ≤ 4000 символов
- `quiz.questions` 1–5, у каждого 2–4 варианта
- Прочие типы — не используются ассистентом (system-prompt
  запрещает). Дополнительно валидируется на уровне сервиса: если
  call от ассистента (есть session-marker), но `type` ∈
  {puzzle, game, endgame_drill} — 400.

## 6. Frontend — что нужно поменять

### 6.1 ChatWidget

- Принимать новый SSE-event-type `tool_call`. Рендерить компактной
  строкой с спиннером:
  «🔧 Создаю курс…», «🔧 Добавляю шаг «Идея дебюта»…», и т.д.
- При финальном ответе модели рендерить markdown как сейчас
  (ссылка на курс — стандартная).
- При ошибке tool'а — показать `errorMessage` в строке tool_call с
  красным индикатором и продолжить ждать ответ модели (она
  скажет «не получилось, попробуйте ещё раз»).

### 6.2 Что НЕ делаем в MVP

- Кнопки confirm/cancel в чат-сообщении.
- Структурированный JSON-превью плана (план — markdown).
- Лазейка «открыть в редакторе» через всплывающую панель.
- Inline-редактирование плана прямо в чате.
- Кнопка «Создать урок с AI» в редакторе курсов.

## 7. Содержимое шагов в MVP

| Тип | Кто заполняет | Как |
|---|---|---|
| `text` | AI | Markdown body 500–4000 символов, лекционный стиль |
| `quiz` | AI | 1–5 вопросов с 2–4 вариантами, поле `explanation` опц. |
| `puzzle` | НЕ создаётся | Вместо — `text`-шаг с инструкцией |
| `game` | НЕ создаётся | Вместо — `text`-шаг с инструкцией |
| `endgame_drill` | НЕ создаётся | Вместо — `text`-шаг с инструкцией |

Плейсхолдерный text-шаг (генерируется ассистентом):

```markdown
**[Требуется ручная настройка]**

Здесь автор должен выбрать <тактическую задачу | партию для
разбора | эндшпильную позицию> и заменить этот шаг через
редактор курса.

Подсказка по теме: <короткая инструкция от AI, какой пример
лучше подобрать — например «найдите задачу с темой `pin` рейтинга
1000–1200» или «выберите классическую партию Капабланки на эту
структуру»>
```

Это даёт автору каркас и понятную задачу «дозаполнить вручную»,
без обмана UX (AI ничего не «выдумывает» вместо реальной задачи
или партии).

## 8. Лимиты и безопасность

- Один диалог = одно создание курса. Если пользователь сразу
  попросит «и ещё один» — модель строит второй план и идёт по тому
  же циклу.
- Лимиты на один курс: 1 урок, до 10 шагов, body ≤ 4000 символов.
- Per-user rate-limit: 5 успешных созданий курса в час.
- Per-user общий лимит курсов: 20 (существующий
  `coursesPerUser`).
- Глобальный chat-rate-limit (10 req/min, 100/day, 1000/day global)
  работает поверх — никаких изменений.
- Audit: каждое AI-создание — запись в `ai_lesson_generations`. По
  ней админ видит, что нагенерил пользователь, и может в случае
  жалоб отследить шаги.
- Tools НЕ дают доступ к: удалению/изменению чужих курсов,
  переводам, паблишингу, изменению админ-флагов. Только `create_*`
  и `get_user_course_url`.
- Tools НЕ исполняются без JWT пользователя — фоновых
  «системных» создателей нет.

## 9. Риски

1. **Модель вызывает tools без подтверждения.** Митигация:
   жёсткая инструкция в system-prompt'е (§4.4) и тестовый набор
   (eval-сценарии): «попросил план — не должен вызывать tools»,
   «попросил создать, потом передумал — не должен вызывать».
2. **Tool-loop не сходится за MAX_TOOL_TURNS.** Принудительно
   выходим, шлём пользователю «не удалось завершить, попробуй ещё
   раз», `status='failed'` в audit.
3. **Длинные tool-цепочки бьют по бюджету.** На один урок в 5
   шагов — 7 tool-вызовов (1 курс + 1 урок + 5 шагов). При
   `claude-sonnet-4` это ≈ +$0.04–0.08 на одно создание. Лимит
   «5 курсов в час» удерживает дневной риск.
4. **Anthropic меняет tool-use API.** Локализуем интеграцию в
   одном файле сервиса, легко обновить.
5. **Owner-check обходится через подмену courseId в input.** Не
   обойдётся: tool вызывается через сервис с `request.user.id`,
   все API-методы lessons проверяют owner. Подмена courseId
   приведёт к 403/404.
6. **Plan-spam.** Пользователь может бесконечно просить новые
   планы без подтверждения. Защита — общий chat-rate-limit (10
   сообщений в минуту, 100 в день). Дополнительно — на 11-й
   неподтверждённый план в диалоге модели можно дать
   инструкцию «сначала подтверди или закрой тему».
7. **i18n.** Модель будет писать на языке пользователя
   (определяется по `i18n.language` или явно в system-prompt'е).
   Заголовки шагов в админке не локализуются — это inline-
   поля (`title`/`bodyMarkdown`), они хранятся в языке автора по
   ADR-026 §2.1.
8. **PII в audit-логе.** `plan_json` хранит публикуемый контент
   урока (заголовок, описание, body). Никаких персональных
   данных там не должно быть, но если пользователь явно
   попросит «вставь мой email в урок» — он туда попадёт.
   Принимаем как риск; admin-доступ к таблице — только
   через прямой SQL.

## 10. Реализация — follow-up задачи

Зависимости: B1 → B2 → B3 (параллельно с B4) → F1. Приоритет: P1
для B1/B2/B3 (фундамент tool-use), P1 для B4 (audit/limits), P2 для
F1 (UI можно временно показывать tool-events сырым текстом).

### KS-3205 (B1) — tool-use loop в `ChatAssistantService`

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Описание:** расширить `streamResponse()` поддержкой Anthropic
tool-use. Передавать `tools` параметр (пустой массив в MVP, если
ничего не помечено), парсить `tool_use`-блоки в стриме, исполнять
их через DI-сервис `McpToolExecutor.invoke(name, input, userId)`,
формировать `tool_result`-блоки, продолжать loop до
`stop_reason: 'end_turn'` или `MAX_TOOL_TURNS=8`. В SSE добавить
новый event-type `tool_call` с полями `{name, status, error?}`.
**Acceptance:**
- При отсутствии tools поведение чата идентично текущему
  (text-only).
- При наличии хотя бы одного assistant-tool: модель может вызвать
  его, executor исполняет, результат возвращается модели, та
  отвечает финалом.
- Лимит `MAX_TOOL_TURNS=8`. Превышение — graceful-exit, audit
  записывает `status='failed'`.
- Юнит-тесты: моки Anthropic SDK, проверка цикла с 1, 2, 3
  tool_use-блоками; сценарий ошибки tool'а.

### KS-3206 (B2) — реестр assistant-tools (MCP whitelist)

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Зависит:** KS-3205.
**Описание:** ввести декоратор `@McpToolForAssistant({name?,
description?})` параллельно существующему `@McpTool` (ADR-061).
Реестр `McpAssistantRegistry` собирает помеченные методы при
старте, формирует Anthropic-совместимый массив
`{name, description, input_schema}`. `ChatAssistantService` читает
из этого реестра. Без затрагивания discovery-endpoint'а
`GET /_mcp/tools`.
**Acceptance:**
- Метод с `@McpToolForAssistant` появляется в выдаче реестра.
- Без декоратора — не появляется.
- JSON-schema input'а корректна (использует существующий
  `DtoToJsonSchema`).
- Тест: реестр содержит только помеченные методы.

### KS-3207 (B3) — 4 lesson-tools для ассистента

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Зависит:** KS-3206.
**Описание:** пометить `@McpToolForAssistant` методы создания
курса/урока/шага user-courses, добавить derived-tool
`get_user_course_url`. Хард-лимиты payload через class-validator
(text.body ≤ 4000, quiz.questions 1–5, options 2–4). Запрет на
`puzzle/game/endgame_drill` при вызове от ассистента (sentinel
в контексте) — 400 с понятным сообщением.
**Acceptance:**
- 4 tools видны в `McpAssistantRegistry`.
- Создание курса/урока/шагов с типом text и quiz работает.
- Попытка создать шаг с типом puzzle/game/endgame_drill через
  ассистента — 400.
- Owner-check работает (попытка передать чужой courseId — 403/404).

### KS-3208 (B4) — audit-таблица + rate-limit AI-генераций

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Зависит:** KS-3207.
**Описание:** миграция Prisma — модель `AiLessonGeneration` (см.
§5.4). Сервис пишет запись `status='planned'` при первом
tool_use create_user_course (с `planJson` из последнего assistant-
сообщения), обновляет до `'created'` или `'failed'` по итогу.
Декоратор `@UserRateLimit(5, 3600)` на tool create_user_course.
**Acceptance:**
- При создании курса появляется запись в `ai_lesson_generations`.
- При 6-м запросе создания в течение часа — 429 от rate-limit;
  ассистент передаёт ошибку в чат, запись status='failed'.
- Юнит-тест на rate-limit guard.

### KS-3209 (B5) — system-prompt дополнение

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Зависит:** KS-3207.
**Описание:** добавить в system-prompt секцию «Создание уроков»
(§4.4). Версионировать prompt через константу `SYSTEM_PROMPT_V2`
(или конфиг), чтобы можно было откатиться.
**Acceptance:**
- При запросе «сделай мне урок по X» ассистент строит markdown-
  план и явно спрашивает подтверждение (текстовое eval-тестирование
  на 5 типовых запросах).
- Без явного «да» / «создай» / «подтверждаю» tools НЕ вызываются
  (5 типовых запросов с уклончивыми ответами — нет tool_use в
  ответе).
- При «да» — tools вызываются.

### KS-3210 (F1) — рендер tool_call-events в `ChatWidget`

**Assignee:** frontend.
**Labels:** `chat`, `lessons`.
**Зависит:** KS-3205.
**Описание:** ChatWidget парсит SSE event-type `tool_call`,
рендерит строкой со спиннером (`🔧 Создаю курс…`), при ошибке —
красным индикатором. После end_turn рендерит финальный markdown
с ссылкой как сейчас.
**Acceptance:**
- При вызове tool'а в чате появляется строка «🔧 …» с состояниями
  running/ok/error.
- Финальная markdown-ссылка на курс кликабельна и ведёт в
  `/lessons/my/:slug/edit`.
- Юнит-тест: моковый SSE-стрим с 3 tool_call events + финал, UI
  отрендерил всё.

## 11. M2 — что отложено

- Кнопки «Создать»/«Отмена» прямо в чат-сообщении (структурный
  rendering плана с интерактивом).
- Генерация puzzle-шага через подбор задач по theme/rating (через
  `knowledge.search` или прямой puzzle-search tool).
- Генерация game-шага через поиск в мастерской (своих/публичных
  анализов).
- Inline-редактирование плана прямо в чате («исправь шаг 3 на
  тест из 5 вопросов»).
- Single-turn (создать без подтверждения по явному
  «сразу создай»).
- Knowledge-tools (ADR-063) для лекций — сейчас не используем,
  ассистент пишет «из головы».

## 12. Откат

- Снять с tools метку `@McpToolForAssistant` — модель перестаёт
  иметь к ним доступ (загружается пустой `tools`-массив).
- Удалить секцию про создание уроков из system-prompt'а — модель
  возвращается к text-only поведению.
- Tool-use loop остаётся в коде как фундамент для других
  агентских сценариев. Удаления не требует.
- Audit-таблица сохраняет историю — это полезный артефакт.
