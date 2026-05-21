# ADR-075. AI-ассистент: подбор реальных шахматных шагов в уроки (M2)

Статус: предложен (2026-05-21)
Связано: KS-3220 (этот ADR), ADR-074 (MVP AI-ассистента),
ADR-072 (тип шага «Партия»), ADR-026 (User Courses),
ADR-029 (custom puzzles), ADR-035 (tactical drills),
ADR-044 (play-vs-engine objectives), ADR-061 (MCP discovery).

## 1. Контекст

ADR-074 (MVP) дал ассистенту 4 lesson-tools: создание курса/урока,
добавление шагов типа `text` и `quiz`. Остальные типы (`puzzle`,
`game`, `endgame_drill`, `drill`) ассистент создавал как
text-плейсхолдеры с инструкцией автору «выбери вручную».

Обратная связь пользователя:

> Хорошо что он умеет использовать свои знания о шахматах. Но в чистом виде они бесполезны. И шахматы никто не учит по тексту.

Расширение должно подключить **реальные** chess-шаги через
существующие API:

- **Пазлы** — `GET /puzzles` (Lichess-бэнк, ~1M записей, фильтры
  по `themes`/`rating`, `@McpTool('puzzles__find')` уже размечен).
- **Диаграммы** — это НЕ отдельный шаг, а `TextDiagram` внутри
  `TextStep` (`packages/shared/src/types/lessons.ts:201–211`),
  встраивается в markdown через `{{diagram:N}}` или ``` ```fen ```
  блок.
- **Партии** — тип шага `'game'` (ADR-072), есть API
  `GET /analyses` своих анализов (`@McpTool('analyses__list')`).
- **Тактический drill** — тип `'drill'` (ADR-035), bank в
  `TacticDrill`, API `GET /tactic-drill/next`. Контроллер сейчас
  НЕ помечен MCP.
- **Эндшпильный drill** — без bank'а, ручная настройка через FEN +
  winCondition.

Декоратор `@McpToolForAssistant` (ADR-074 §4.2 / KS-3206) и реестр
`McpAssistantRegistry` уже реализованы. Расширение — это в основном
добавление новых tools и обновление system-prompt'а.

## 2. Приоритезация

| # | Тип шага | Приоритет | Зачем сейчас |
|---|---|---|---|
| 1 | `puzzle` (filter) | **P1** | Самый частый шаг тренировочного урока. API готов. Минимум кода. |
| 2 | `text + TextDiagram` | P2 | Лекции с диаграммами — базовая методическая ткань. Нужна валидация FEN, чтобы модель не фантазировала. |
| 3 | `game` (analysis / inline pgn) | P3 | Уже есть тип шага и hydrator (ADR-072). Tools для выбора из мастерской. |
| 4 | `drill` (tactical) | P4 | 7 типов, bank ограничен — но даёт «микро-задачку на узнавание мотива», полезно в начале урока. |
| 5 | `endgame_drill` (classics) | P5 (M3) | Без bank'а — нужен whitelist классических эндшпилей. Откладываем. |

Подтверждаю запрос пользователя: пазлы — первыми.

## 3. Решение

### 3.1 Принципы

1. **AI не выдумывает FEN/PGN/puzzle-id.** Любой FEN, PGN или
   ссылка на пазл — либо из проверенного источника (puzzle-bank,
   user's analyses, drill-bank, KNOWN_ENDGAMES whitelist), либо
   пришёл от пользователя текстом и провалидирован chess.js. Запрет
   на «AI пишет произвольный FEN из головы» жёстко зафиксирован в
   system-prompt'е.
2. **Filter, не ids.** Для `puzzle` и `drill` используем mode `filter`
   (тема + рейтинг + limit) — backend подбирает конкретные позиции
   при прохождении урока. Это:
   - снимает риск «застрявшего» puzzleId (если пазл удалят /
     перекалибруют);
   - снимает round-trip предпросмотра в большинстве случаев;
   - даёт студенту разные задачи при повторном прохождении.
3. **Минимум tool-цепочки в плане.** Ассистент решает темы/рейтинг
   в плане (markdown), пользователь подтверждает план целиком,
   ассистент создаёт шаги. Подтверждать каждый пазл отдельно —
   слишком много раундов.
4. **Превью только по явному запросу.** Tool
   `find_puzzles_preview` ассистент вызывает ТОЛЬКО когда
   пользователь явно просит «покажи примеры», без побочного
   создания шагов.

### 3.2 Tools (все — `@McpToolForAssistant`)

#### 3.2.1 Пазлы (P1)

```
add_puzzle_step_filter({
  lessonId: string,
  themes: PuzzleTheme[],    // 1..3 темы (OR)
  ratingMin?: number,       // 400..3000
  ratingMax?: number,       // 400..3000, >= ratingMin
  limit: number,            // 1..10
  minSolved?: number,       // 1..limit
}) → { stepId: string }
```

Сохраняет `LessonStep` с `PuzzleStepPayload mode='filter'` (см.
`packages/shared/src/types/lessons.ts:81–87`). Backend применяет
существующие user-step ограничения (`stepsPerLesson: 50`),
дополнительный лимит ассистента: `limit ≤ 10`.

```
find_puzzles_preview({
  themes: PuzzleTheme[],   // 1..3 темы
  ratingMin?: number,
  ratingMax?: number,
  limit: number,           // 1..5
}) → [{ puzzleId, fen, themes, rating, firstMoveUci }]
```

Тонкая обёртка над `puzzles__find`. Используется ассистентом ТОЛЬКО
по запросу «покажи примеры», не для добавления шага. Не пишет в БД.

#### 3.2.2 Диаграммы (P2)

```
validate_fen({ fen: string }) →
  { valid: true, sideToMove: 'white'|'black', castling, enPassant?, fenNormalized }
  | { valid: false, error: string }
```

Лёгкая обёртка над `chess.js`. Никаких сторонних эффектов.

Добавление диаграммы — НЕ через отдельный tool. Ассистент
использует существующий `create_user_lesson_step` с
`type='text'` и кладёт `TextDiagram` в `payload.diagrams` + ставит
`{{diagram:0}}` в bodyMarkdown. System-prompt требует
**предварительный вызов `validate_fen` для каждого FEN'а**.

Допустимые источники FEN'а для AI:
- получен от `find_puzzles_preview` (содержит проверенный fen),
- из `list_my_analyses` (опц. — мы добавим поле `startingFen` если
  есть),
- прислан пользователем явно в чате,
- из whitelisted-каталога `KNOWN_POSITIONS` (стартовая,
  типичные дебютные узлы, классические эндшпили) — заводим
  отдельной константой в P5.

Запрет в system-prompt'е: «не сочиняй FEN из головы — типичная
ошибка модели расставить фигуры так, что мат уже стоит на доске».

#### 3.2.3 Партии (P3)

```
list_my_analyses({
  search?: string,        // ILIKE по title/opening/white/black
  limit: number,          // 1..20
}) → [{ analysisId, title, headline, opening, white, black, result, isPublic }]
```

Обёртка над `GET /analyses` (`@McpTool('analyses__list')`).
Возвращает только свои анализы (owner-check автоматический по JWT).
Без PGN — для экономии токенов.

```
add_game_step_from_analysis({
  lessonId: string,
  analysisId: string,
}) → { stepId: string }
```

Создаёт `LessonStep type='game'` с
`source.sourceType='workshop_analysis'`. Backend (ADR-072 §2.3) сам
дотягивает Analysis, проверяет owner, копирует PGN+meta в snapshot.

```
add_game_step_from_pgn({
  lessonId: string,
  pgn: string,            // ≤ 200 KB (ADR-072 §2.7)
  meta?: GameStepMeta,
}) → { stepId: string }
```

Для сценария «вот PGN партии Карпов-Каспаров 1985, добавь её».
PGN валидируется `chess.js` (как в ADR-072 KS-3180).

Поиск чужих публичных анализов — НЕ в M2 (нужен индекс + privacy-
обсуждение). M3.

#### 3.2.4 Тактический drill (P4)

Контроллер `tactic-drill.controller.ts` сейчас НЕ помечен
`@McpModule`. Помечаем + добавляем assistant-tool:

```
add_tactical_drill_step({
  lessonId: string,
  drillType: TacticDrillType,           // 1 из 7
  difficultyBucket: 'easy'|'medium'|'hard',
  count: number,                        // 1..5
  minSolved?: number,                   // 1..count
}) → { stepId: string }
```

Сохраняет `LessonStep type='drill'` с
`DrillStepPayload { drillType, difficultyBucket, count, minSolved }`
(без `drillId` → mode random). При прохождении студентом backend
подбирает drill из bank'а на лету (KS-2315 / ADR-035 §11).

`find_drill_preview` НЕ добавляем — drill подбирается на лету, а
визуально один тип drill'а — это всегда «найди вилку / угрозу /
висящую фигуру». Превью не помогает планированию.

#### 3.2.5 Эндшпильный drill (P5 / M3)

Откладываем. Если делать сейчас — нужен `KNOWN_ENDGAMES` каталог
(Lucena, Philidor, KQ vs K, KR vs K opposition, …) с проверенными
FEN + winCondition. Tool
`add_endgame_drill_step_from_known({ lessonId, knownKey, playerSide,
skillLevel })`. Альтернативно — пользователь даёт FEN текстом,
ассистент валидирует и сохраняет. Решаем после оценки спроса.

### 3.3 UX в чате

Без изменений по сравнению с ADR-074 — план в markdown,
текстовое подтверждение. Расширяется только формат плана:

```
**Курс**: «Атака на короля для начинающих»
**Урок**: «Двойной удар и вилка»

**Шаги**:
1. [Лекция] Что такое двойной удар и вилка (с диаграммой)
2. [Задачи] Тема `fork`, рейтинг 1000–1300, 5 пазлов
3. [Драйл] Тип `find-fork`, бакет `easy`, 3 позиции
4. [Лекция] Типичные ошибки + диаграмма
5. [Партия] Партия Морфи — Дюк (короткая миниатюра, PGN ниже…)

Создаю?
```

После «да» — последовательность tool-вызовов в одном диалоге:

```
[tool_use: validate_fen]   // для каждой диаграммы в шагах 1, 4
[tool_use: create_user_course]
[tool_use: create_user_lesson]
[tool_use: create_user_lesson_step]  // text + diagram
[tool_use: add_puzzle_step_filter]   // pz fork 1000–1300 ×5
[tool_use: add_tactical_drill_step]  // drill find-fork easy ×3
[tool_use: create_user_lesson_step]  // text + diagram
[tool_use: add_game_step_from_pgn]   // Морфи-Дюк PGN
[tool_use: get_user_course_url]
```

Цепочка укладывается в `MAX_TOOL_TURNS = 8` (ADR-074 §4.1), но
с учётом нескольких validate_fen и нескольких add_*_step стоит
поднять лимит до **MAX_TOOL_TURNS = 16** в этом ADR.

Превью-сценарий («покажи 3 задачи на pin рейтинга 1500») — не
требует подтверждения и не пишет в БД. Ассистент вызывает
`find_puzzles_preview` и выводит результат с превью FEN'ов
(можно как inline-блок ```fen ... ``` — фронт уже рендерит
диаграммы в чате через TextStep-механизм; либо просто URL'ом
`/puzzle/:id`).

### 3.4 System-prompt — диффы

Существующая секция «СОЗДАНИЕ УРОКОВ» (ADR-074 §4.4) дополняется
блоком «РЕАЛЬНЫЕ ШАХМАТНЫЕ ШАГИ»:

```
ПАЗЛЫ:
- Используй add_puzzle_step_filter с темами из enum PuzzleTheme
  (см. справочник в discovery). Темы — 1..3 на шаг (OR).
- Подбирай ratingMin/Max под уровень курса:
  - beginner: 800..1200
  - intermediate: 1200..1600
  - advanced: 1600..2200
- limit обычно 3..5 пазлов на шаг. Не делай 10 — это утомляет.
- Если пользователь просит «покажи примеры» — вызывай
  find_puzzles_preview и приводи позиции в чате; НЕ создавай шаг
  без явного «добавь».

ДИАГРАММЫ:
- ВСЕГДА вызывай validate_fen ДО того как вставить FEN в шаг.
- Источники FEN: (1) find_puzzles_preview, (2) list_my_analyses,
  (3) сообщение пользователя, (4) каталог KNOWN_POSITIONS.
  НЕ выдумывай FEN сам — модель часто расставляет позицию, в
  которой уже мат или невозможные фигуры.
- Диаграмму вставляй в TextStep: payload.diagrams = [{fen,
  caption, orientation}] + bodyMarkdown содержит {{diagram:0}}.

ПАРТИИ:
- list_my_analyses — поиск только по СВОИМ анализам пользователя.
- Из найденных предложи 1..3 в плане, дай пользователю выбрать.
- add_game_step_from_analysis — после явного подтверждения.
- add_game_step_from_pgn — если пользователь прислал PGN в чате.
  Не «вспоминай» PGN классических партий полностью — там много
  потенциальных опечаток. Лучше попроси пользователя прислать.

ТАКТИЧЕСКИЙ DRILL:
- 7 типов: find-hanging-piece, find-loose-piece, find-pin,
  find-fork, count-attackers, find-all-checks,
  find-undefended-attack.
- difficultyBucket по уровню: easy/medium/hard.
- count 2..3 на шаг (короткие микро-задачки).

ЭНДШПИЛЬНЫЙ ТРЕНАЖЁР:
- В этой версии не поддерживается — если попросят, ответь
  «пока вручную через редактор» (без вызова tools).
```

## 4. Безопасность и лимиты

### 4.1 Authorization

| Tool | Доступ |
|---|---|
| `add_puzzle_step_filter` | owner курса (через user-courses guard'ы) |
| `find_puzzles_preview` | public — puzzle-bank публичный |
| `validate_fen` | public — чистая утилита, без БД |
| `list_my_analyses` | owner (только свои) |
| `add_game_step_from_analysis` | owner курса + owner analysis (ADR-072) |
| `add_game_step_from_pgn` | owner курса |
| `add_tactical_drill_step` | owner курса |

Все — через JWT пользователя чата, никаких system-elevated вызовов.

### 4.2 Лимиты payload'а

- `puzzle filter.limit` ≤ 10 (хард на DTO, soft в prompt — обычно 3..5).
- `drill count` ≤ 5 (хард).
- `pgn` ≤ 200 КБ (ADR-072).
- `lesson.steps` ≤ 50 (ADR-026), per-AI-генерацию — ≤ 15 (поднимаем с
  10 в ADR-074 §8 — иначе для chess-уроков с puzzle+drill+game+text
  не хватает).

### 4.3 Rate-limits

- `add_*_step` через assistant — попадают под существующий
  `@UserRateLimit(5, 3600)` на create_user_course (ADR-074 KS-3208) —
  одна генерация = один курс, лимит на ней.
- `find_puzzles_preview` и `list_my_analyses` — read-only, попадают
  под общий chat-rate-limit (10 req/min, 100/day). Отдельный лимит
  на «количество поисков в одном диалоге» НЕ вводим — пользователь
  всё равно ждёт ответа модели.
- `validate_fen` — чистая функция, без rate-limit.

### 4.4 Audit

Существующая таблица `ai_lesson_generations` (ADR-074 §5.4)
расширяется полем `tool_calls JSONB` — массив `{name, status,
durationMs}` для статистики какие tools ассистент дёргал на
конкретную генерацию. Это диагностика, не персональные данные.

### 4.5 Защита от спама поиска

`find_puzzles_preview` может теоретически быть зацикленным в диалоге
(«а покажи ещё, а покажи ещё»). Защита — `MAX_TOOL_TURNS = 16` на
один турн пользователя + общий chat-rate-limit на сообщения. Не
вводим отдельный счётчик.

## 5. Что НЕ в этом ADR

- Каталог `KNOWN_POSITIONS` (классические дебютные/эндшпильные FEN)
  — отложен на P5 / M3. Если до этого пользователь явно попросит
  «давай ассистент сам мог взять классические эндшпили» —
  расширяем.
- Поиск чужих публичных анализов — M3 (требует обсуждения
  приватности и индексов).
- `add_endgame_drill_step_*` — M3.
- `add_opening_drill_step_*` — M3 (PGN-дерево вариантов слишком
  сложно для AI-генерации без человеческой проверки).
- Превью FEN'а как рендеренной картинки в чате (для preview-
  сценария) — это улучшение UX чата, отдельная frontend-задача.
- Авто-перевод на язык пользователя для подписей под диаграммами и
  заголовков шагов — наследуется из системного i18n-поведения
  ChatAssistantService.

## 6. Риски

1. **Модель неудачно подбирает тему пазлов.** Например, спрашивают
   «урок про мат конём и слоном», а модель ставит тему
   `bishopEndgame` без `mateIn5`. Митигация: eval-набор (KS-3232)
   проверяет ≥ 8 типовых запросов; в system-prompt — справочник
   тем с одной строкой описания.
2. **Diagram-FEN всё-таки фантазируется**, несмотря на запрет.
   Митигация: `validate_fen` обязателен, но он проверяет только
   синтаксис и легальность позиции — НЕ корректность урока.
   Дополнительно: тест-инструкция в prompt'е «если ты создал FEN
   сам без источника — НЕ вставляй его, попроси FEN у пользователя».
   Eval-сценарий: «сделай диаграмму итальянской партии» — модель
   должна попросить FEN или взять из puzzle-bank'а с темой
   `opening`.
3. **PGN классических партий с ошибками.** В prompt — запрет
   «вспоминать» PGN целиком; просьба к пользователю прислать.
4. **MAX_TOOL_TURNS=16 раздувает токены.** Каждый turn — это
   ~200–500 input + ~100–300 output. На 16 turns ≈ +$0.10 на одну
   полную генерацию урока. Лимит «5 курсов в час» удерживает
   дневной риск.
5. **Несовместимые лимиты puzzle.limit (наш 10) vs limit на бэке
   (`puzzles__find` maxLimit=50).** Не конфликт — это два разных
   лимита: 10 — для AI-генерации (методический предел), 50 — для
   browser'а. Хард-валидация в DTO ассистента.
6. **AI забывает вызвать validate_fen.** Eval-сценарий это ловит.
   Дополнительная защита — серверный hook: при создании
   `text`-шага с `diagrams[].fen` сервер сам прогоняет chess.js,
   ошибочный FEN → 400.

## 7. Реализация — follow-up задачи

Все — backend, кроме одной eval-задачи в `chess-expert`. Frontend
не меняется (ChatWidget уже рендерит tool_call events по KS-3210).
Никаких новых shared-типов — все DTO ассистента используют
существующие union'ы из `packages/shared/src/types/lessons.ts`.

Зависимости: B-задачи 3221, 3223, 3224, 3226 — независимы между
собой (разные домены), могут идти параллельно. KS-3222 (eval P1)
зависит от 3221. KS-3225 (system-prompt v3) — собирает диффы из
3221+3223+3224+3226, идёт последним.

### KS-3221 (B1) — `add_puzzle_step_filter` + `find_puzzles_preview` (P1)

**Assignee:** backend.
**Labels:** `chat`, `lessons`, `puzzle`.
**Описание:** добавить 2 tools в lesson-assistant-tools.service.ts с
`@McpToolForAssistant`. `add_puzzle_step_filter` создаёт LessonStep
type='puzzle' с PuzzleStepPayload mode='filter'. Валидация: 1..3
темы, ratingMin..ratingMax в 400..3000, limit 1..10.
`find_puzzles_preview` — обёртка над PuzzleService.find с
limit 1..5, без записи в БД. Доступ к bank'у — public (через JWT,
но без owner-check на пазлы).
**Acceptance:**
- Tool создаёт шаг с фильтром; при прохождении студент видит
  подобранные пазлы (используется существующая логика
  PuzzleStepRunner).
- Превью отдаёт массив с puzzleId + fen + themes + rating +
  firstMoveUci.
- Лимиты в DTO работают (limit > 10 — 400).
- Юнит-тесты на 5 сценариев фильтра + 3 на ошибки валидации.

### KS-3222 (B2 / eval P1) — eval-сценарии на пазлы

**Assignee:** chess-expert (методическая часть) + backend (запуск).
**Labels:** `chat`, `lessons`, `puzzle`.
**Зависит:** KS-3221.
**Описание:** 8 типовых запросов («сделай тренировку на мат в 2
для новичков», «5 задач на fork рейтинга 1500», «урок по
эндшпилю»…), eval-фреймворк проверяет: (а) ассистент использует
правильные `PuzzleTheme`, (б) ratingMin/Max в разумном диапазоне,
(в) limit 1..10, (г) НЕ вызывает add_puzzle_step без явного «да».
**Acceptance:**
- 8 eval-сценариев проходят ≥ 7 из 8 на каждом релизе.
- Отчёт сохраняется в `apps/api/test/eval/results/`.

### KS-3223 (B3) — `validate_fen` + диаграммы в TextStep (P2)

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Описание:** добавить tool `validate_fen` (обёртка над chess.js,
без побочных эффектов). Серверный hook: при создании text-шага с
`diagrams[].fen` через ассистента — прогон chess.js, при ошибке
400 с явным сообщением. System-prompt v3 (KS-3225) даёт
инструкции по работе с диаграммами.
**Acceptance:**
- Валидный FEN — `{valid: true, sideToMove, ...}`.
- Невалидный — `{valid: false, error: '...'}` (не throw).
- Tool exposed как `@McpToolForAssistant`.
- Server-side validation при сохранении text-шага через
  ассистента — невалидный FEN отклоняется.

### KS-3224 (B4) — game-tools (P3)

**Assignee:** backend.
**Labels:** `chat`, `lessons`, `analysis`.
**Описание:** добавить tools `list_my_analyses`,
`add_game_step_from_analysis`, `add_game_step_from_pgn`. Owner-check
на analysisId автоматический (через AnalysisService). PGN-валидация
через chess.js (как в ADR-072 KS-3180), лимит 200 КБ.
**Acceptance:**
- list возвращает только свои анализы (owner-check).
- add_from_analysis вызывает GameStepHydrator (ADR-072).
- add_from_pgn принимает PGN ≤ 200 КБ, валидирует, сохраняет.
- 3 юнит-теста (happy + 2 ошибки).

### KS-3226 (B5) — drill-tools (P4)

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Описание:** пометить `TacticDrillController` `@McpModule`
(сейчас не размечен). Добавить tool `add_tactical_drill_step` —
создаёт LessonStep type='drill' с
DrillStepPayload {drillType, difficultyBucket, count, minSolved}
без drillId (random mode). Whitelist 7 drillType'ов.
**Acceptance:**
- Tool создаёт drill-шаг; при прохождении студент получает drill
  через `GET /tactic-drill/by-step/:stepId`.
- count > 5 — 400.
- Неизвестный drillType — 400.

### KS-3225 (B6) — system-prompt v3 + поднять MAX_TOOL_TURNS до 16

**Assignee:** backend.
**Labels:** `chat`, `lessons`.
**Зависит:** KS-3221, KS-3223, KS-3224, KS-3226.
**Описание:** собрать диффы system-prompt'а (§3.4) в одну версию
v3 (константа SYSTEM_PROMPT_V3). Поднять MAX_TOOL_TURNS=16.
Per-AI-генерацию лимит шагов с 10 (ADR-074) поднять до 15.
**Acceptance:**
- v3 включает блоки про пазлы / диаграммы / партии / drill.
- 5 eval-сценариев на смешанный урок (пазлы + диаграммы + drill +
  партия) проходят за ≤ 16 tool-turns.
- Откат: переключить SYSTEM_PROMPT_V2 константой.

## 8. M3 (отложено)

- KS-XXXX: `add_endgame_drill_step_*` + каталог `KNOWN_ENDGAMES`.
- KS-XXXX: `add_opening_drill_step_*` (PGN-дерево вариантов).
- KS-XXXX: поиск чужих публичных анализов (отдельный индекс +
  privacy-аудит).
- KS-XXXX: рендер FEN'ов как картинок в превью-сценарии чата
  (frontend).
- KS-XXXX: knowledge-tools (ADR-063) для лекций — ассистент
  цитирует из docs/ADR'ов вместо «своей памяти».

## 9. Откат

- Снять `@McpToolForAssistant` с любого из новых tools — модель
  теряет к нему доступ, ничего не ломается (план просто переходит
  на text-плейсхолдер, как в MVP).
- Вернуть SYSTEM_PROMPT_V2 — поведение откатится к ADR-074.
- Tools остаются в коде как мёртвый, но валидный набор — удаление
  не требуется.
