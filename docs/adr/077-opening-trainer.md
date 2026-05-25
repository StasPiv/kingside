# ADR-077. Opening Trainer — тренировка дебютов из пользовательского PGN

Статус: предложен (2026-05-23)
Связано: KS-3268 (этот ADR), ADR-025 (SM-2 для уроков),
ADR-035 (tactical drills), ADR-072 (тип шага «Партия»),
ADR-026 (User Courses), `OpeningDrillStepPayload` в shared.

## 1. Контекст

Запрос пользователя (VIP, референс — ChessBase Opening Trainer):

> Тренировка дебютов. Загружает PGN со своими анализами, повторяет
> дебют чтобы запомнить все записанные ходы. Бот — рандомайзер, но
> ответы не повторяются пока все линии не пройдены. За правильные
> ответы — баллы.

Что уже есть в проекте:

- `OpeningDrillStepPayload` (`packages/shared/src/types/lessons.ts:434–452`)
  — это шаг **урока** с одним PGN-деревом, флагами `playerSide` и
  `onDeviation`. Без сессий, без SRS, без репертуара. Это
  заготовка под **конкретный шаг конкретного урока**, не под
  отдельную тренировку с десятками линий.
- `Analysis` (`packages/db/prisma/schema.prisma:509–597`) хранит PGN
  как `TEXT`-строку. Дерево не структурируется в БД — парсится
  `chess.js#loadPgn` на фронте на лету. Семантика — «одна партия для
  разбора», с метаданными игроков, опц. `isPublic`.
- `Sm2Service` (`apps/api/src/lessons/sm2.service.ts`) и модель
  `LessonReview` (ADR-025) реализуют SM-2 на уровне уроков —
  компонент готов к переиспользованию.
- Паттерн «одна попытка = одна строка» — в `PuzzleAttempt`,
  `TacticDrillAttempt`. Сессий явно нет (агрегируем по `createdAt`).
- Random-without-repeat — есть пример в
  `tactic-drill-sprint.service.ts` (shuffled round-robin), но
  per-session состояние не хранится в БД.
- PGN-парсер с вариантами на бэке — отсутствует, используется только
  `chess.js#loadPgn` (умеет вложенные `(вариант)` и NAG `$1..$6`).

«/studio» из задачи (KS-3261/3263) — это про дедупликацию анализов и
метаданные, **отдельного модуля Studio в кодовой базе нет**.

## 2. Решение

### 2.1 Отдельная сущность `OpeningRepertoire`, НЕ расширение `Analysis`

| Аспект | `Analysis` | `OpeningRepertoire` |
|---|---|---|
| Семантика | «одна сохранённая партия для просмотра» | «дерево вариантов для изучения» |
| Owner-доступность | приватный + опц. `isPublic` для share | приватный, без публикации в MVP |
| Метаданные | white/black/event/result | side(s), title, описание |
| Прогресс | нет (это просмотр) | per-линия (counters, mastered, SRS) |
| Размер | одна партия | десятки/сотни линий |
| Дерево в БД | нет, только PGN-строка | structured JSONB |

Объединять в один тип через флаг `isRepertoire` — отвергнуто:
смешивание двух сущностей, путаница в списках, разные UX. Конверсия
из мастерской — отдельный flow («Использовать как репертуар» в
карточке анализа → POST'ит копию PGN в `/opening-trainer`).

### 2.2 Дерево хранится structured (JSONB), а не как строка

PGN с вариантами на каждый запрос парсить — дорого и не даёт быстро
ответить «какие ходы доступны в позиции X». Структура:

```ts
interface RepertoireTree {
  /** FEN корневой позиции (обычно стандартная стартовая). */
  rootFen: string;
  /** Все узлы дерева, ключ — FEN позиции. Транспозиции схлопываются в один узел. */
  nodes: Record<string, RepertoireNode>;
  /** Метаданные: сколько узлов, сколько edges, max-глубина. */
  meta: { nodeCount: number; edgeCount: number; maxDepth: number };
}

interface RepertoireNode {
  fen: string;                  // ключ-дубликат для удобства
  /** Доступные ходы из этой позиции (один или несколько — варианты). */
  edges: RepertoireEdge[];
}

interface RepertoireEdge {
  moveUci: string;              // 'e2e4'
  moveSan: string;              // 'e4'
  childFen: string;             // FEN после хода
  nag?: number[];               // [1,4] = "!?", "main line", etc.
  comment?: string;             // авторский комментарий
}
```

Парсинг PGN → дерево делается **на бэке** при сохранении репертуара:

1. `chess.js#loadPgn(pgn)` (тот же, что в `OpeningDrillStepPayload`
   валидаторе).
2. Рекурсивный обход parsed game вместе с дочерними вариантами.
3. Для каждой позиции вычисляем FEN; если он уже в `nodes` —
   добавляем edge к существующему узлу (транспозиция = один узел,
   два предка).
4. NAG'и и комментарии сохраняются на edge'ах.

**Лимиты репертуара (хард в DTO):**

- `nodeCount ≤ 2000`
- `edgeCount ≤ 5000`
- размер исходного PGN ≤ 500 КБ

Превышение — 400 «Репертуар слишком велик, разбейте на несколько».

> **KS-3335 (2026-05-25):** лимит `maxDepth ≤ 80 полуходов` снят.
> Пользователи добавляли реальные партии длиннее 40 полных ходов
> (81+ полуходов), упирались в 400. Поле `tree.meta.maxDepth`
> остаётся в дереве как **информационное** (используется UI для
> отображения «макс. глубина: N полуходов»), но `throw` в
> `RepertoireBuilderService` на превышении убран. Константа
> `OPENING_REPERTOIRE_LIMITS.maxDepthHalfMoves` удалена из shared.
> Защита от runaway-PGN остаётся через лимиты `maxNodes` / `maxEdges`
> / `maxPgnBytes`.

### 2.3 Логика бота — server-side, не client-side

Почему server:

- Состояние «какие варианты сыграны» персистентно (VIP может
  вернуться через неделю — это требование §5 задачи).
- Random-без-повтора корректно работает только с централизованным
  состоянием (несколько устройств одного пользователя в один
  момент).
- Сервер — источник истины дерева позиций (фронт не должен иметь
  возможность «угадать» ход чита, отметив его правильным).

Алгоритм бот-хода в позиции X:

```
edges = tree.nodes[fenX].edges
played = session.playedLines[fenX] ?? []     // массив childFen, уже сыгранных
available = edges.filter(e => !played.includes(e.childFen))

if available.length > 0:
    pick = uniform-random(available)
    session.playedLines[fenX].push(pick.childFen)
    return pick.moveUci

else if repeatMode === 'cycle':
    session.playedLines[fenX] = []           // обнуляем
    pick = uniform-random(edges)
    session.playedLines[fenX].push(pick.childFen)
    return pick.moveUci

else if repeatMode === 'complete':
    return SESSION_COMPLETE
```

`playedLines: Json` в `OpeningTrainerSession` — словарь `{ [fenX]:
string[] }`, **per-position**. Это правильнее глобального
«сыгранных линий»: в одной позиции бот может пройти все варианты, в
другой — только часть.

### 2.4 Проверка хода пользователя

Когда ход пользователя, фронт шлёт `POST /opening-trainer/sessions/
:id/move { moveUci }`. Сервер:

1. Берёт `currentFen` сессии.
2. Смотрит `tree.nodes[currentFen].edges` — это допустимые ходы по
   репертуару.
3. Если `moveUci ∈ edges.moveUci` → **correct**: применяет ход,
   тут же выбирает бот-ход (см. §2.3), возвращает оба + новый
   `currentFen` + scoring delta.
4. Иначе → **wrong**: возвращает массив правильных ходов
   (короткий — обычно 1–3 SAN) + applied: false (ход не
   засчитывается, состояние сессии не двигается). UX (фронт) даёт
   варианты «попробовать снова» / «показать ответ и продолжить»
   / «откатиться на 1 ход».

Если в позиции не осталось edges (конец заученной линии) →
**line-complete**: фронт показывает «линия пройдена», предлагает
вернуться на развилку выше или начать с начала.

### 2.5 Persistent прогресс — `OpeningLineProgress`

Per-path (не per-line, не per-edge) — потому что мастеринг
оценивается по полной цепочке от root до точки замера:

```prisma
model OpeningLineProgress {
  id           String    @id @default(uuid()) @db.Uuid
  userId       String    @map("user_id") @db.Uuid
  repertoireId String    @map("repertoire_id") @db.Uuid

  /// Хеш UCI-пути от корня (sha1(join('|', pathUci))).
  /// Используем для уникальности — пути могут быть длинными.
  pathHash     String    @map("path_hash")
  pathUci      Json      @map("path_uci")     // массив строк
  pathLength   Int       @map("path_length")  // длина в полуходах

  correctCount         Int @default(0) @map("correct_count")
  wrongCount           Int @default(0) @map("wrong_count")
  consecutiveCorrect   Int @default(0) @map("consecutive_correct")
  lastPlayedAt         DateTime @map("last_played_at")
  masteredAt           DateTime? @map("mastered_at")

  /// SM-2 поля для review-режима (M2). NULL до достижения мастеринга.
  sm2Easiness   Float?    @map("sm2_easiness")
  sm2Interval   Int?      @map("sm2_interval")
  sm2DueAt      DateTime? @map("sm2_due_at")
  sm2Reps       Int?      @map("sm2_reps")

  @@unique([userId, repertoireId, pathHash])
  @@index([userId, repertoireId])
  @@index([userId, sm2DueAt])    // для «к повтору сегодня»
  @@map("opening_line_progress")
}
```

Мастеринг: `MASTERY_THRESHOLD = 3` подряд правильных проходов линии.
После — `masteredAt = now`, и `Sm2Service` инициализирует
`sm2Easiness = 2.5`, `sm2Interval = 1`, `sm2DueAt = now + 1day`. При
следующих повторах в **режиме review** обновляется SM-2 по тому же
алгоритму, что в `LessonReview`.

В **режиме learn** (новые линии) SM-2 не применяется — учим, пока
не наберём 3 подряд правильных, дальше переключаемся на review.

### 2.6 Сессии и попытки

```prisma
model OpeningTrainerSession {
  id            String    @id @default(uuid()) @db.Uuid
  userId        String    @map("user_id") @db.Uuid
  repertoireId  String    @map("repertoire_id") @db.Uuid
  side          String    // 'white' | 'black'
  mode          String    // 'learn' | 'review' | 'mistakes' | 'free'
  repeatMode    String    @default("complete") @map("repeat_mode") // 'cycle' | 'complete'

  /// {[fen]: string[]} — какие childFen бот уже сыграл per-position.
  playedLines   Json      @default("{}") @map("played_lines")
  /// Текущая FEN позиция (для resume через 7 дней).
  currentFen    String    @map("current_fen")
  /// UCI-путь от корня до текущей позиции (для line-progress на финале).
  currentPath   Json      @default("[]") @map("current_path")

  score         Int       @default(0)
  movesPlayed   Int       @default(0) @map("moves_played")
  correctMoves  Int       @default(0) @map("correct_moves")
  wrongMoves    Int       @default(0) @map("wrong_moves")
  hintsUsed     Int       @default(0) @map("hints_used")

  startedAt     DateTime  @default(now()) @map("started_at")
  lastActivityAt DateTime @map("last_activity_at")
  finishedAt    DateTime? @map("finished_at")

  @@index([userId, repertoireId, finishedAt])
  @@map("opening_trainer_sessions")
}

model OpeningTrainerAttempt {
  id          String    @id @default(uuid()) @db.Uuid
  sessionId   String    @map("session_id") @db.Uuid
  positionFen String    @map("position_fen")
  expectedMoves Json    @map("expected_moves")   // массив moveUci
  userMove    String    @map("user_move")
  correct     Boolean
  hintUsed    Boolean   @default(false) @map("hint_used")
  scoreDelta  Int       @map("score_delta")
  responseTimeMs Int    @map("response_time_ms")
  createdAt   DateTime  @default(now()) @map("created_at")

  @@index([sessionId, createdAt])
  @@map("opening_trainer_attempts")
}
```

Сессия — длительная (минуты-часы), переживает refresh браузера и
возвращение через дни. `currentFen` + `currentPath` позволяют
продолжить с того же места. `finishedAt = null` пока активна;
проставляется при «complete», `mode='free'`-exit, или авто через
24 часа неактивности.

### 2.7 Скоринг (MVP)

Простые, читаемые числа:

- Правильный ход без подсказки: **+10**
- Правильный после подсказки: **+5**
- Бонус за быстрый (<5 секунд): **+1**
- Неправильный: **−5** (минимум баланс 0, в минус не уходим)
- Стрик-бонус (5 подряд правильных): следующие правильные ×1.2
  до первой ошибки

Бот считается «нейтральным» — он не «соперник», а тренажёр. Без
рейтинга à la TacticDrillRating. Глобальный лидерборд по
репертуарам — M3.

### 2.8 UX flow

Маршруты:

- `/opening-trainer` — лобби: список моих репертуаров +
  «+ Загрузить PGN».
- `/opening-trainer/new` — форма загрузки PGN + выбор имени.
- `/opening-trainer/:id` — карточка репертуара: статистика
  (mastered/learning/wrong), tree-view (M2), кнопки «Тренировать
  новые», «Повторить ошибки», «По расписанию SRS» (M2), выбор
  стороны.
- `/opening-trainer/:id/session/:sid` — активная сессия: доска,
  индикатор «Линия 3/12», текущий счёт, бот-ход, ввод хода
  пользователя, реакция, кнопки «Подсказка / Откатить /
  Сдаться».
- `/opening-trainer/:id/session/:sid/result` — финальный экран:
  баллы, покрытие линий, разбор ошибок, кнопки «Ещё раз» /
  «Назад к репертуару».

### 2.9 Что НЕ переиспользуем `OpeningDrillStepPayload`

`OpeningDrillStepPayload` — это **шаг урока**: один PGN, обычно
короткая последовательность с парой вариантов, привязанная к
конкретному уроку. У него:

- Нет масштаба «репертуар на 200 линий».
- Нет persistent-прогресса по линиям.
- Нет SRS.
- Нет сессий между устройствами.
- Цель — отработать конкретную линию **в контексте урока**.

Opening Trainer — отдельный продукт, со своим лобби, отдельной
тренировкой и SRS. Мерж в одну сущность дал бы Frankenstein-DTO.

В будущем можно соединить: шаг урока `opening_drill` принимает
`repertoireId` + опц. `subtreeFromFen`, и при прохождении создаёт
полноценную trainer-сессию. Это **M3 интеграция**, не блокер сейчас.

## 3. API

Все endpoints под `JwtAuthGuard` (owner-check встроен в сервис).

### Репертуары

- `GET /opening-trainer/repertoires` — список моих, метаданные
  без дерева. `?include=stats` подгружает агрегаты per-repertoire
  (mastered/learning/wrong counts).
- `POST /opening-trainer/repertoires` — создание, body `{ title,
  description?, pgn }`. Бэк парсит PGN, валидирует chess.js, строит
  дерево, проверяет лимиты, сохраняет.
- `GET /opening-trainer/repertoires/:id` — детали + дерево
  (full, с тривиальной кешируемостью HTTP).
- `PATCH /opening-trainer/repertoires/:id` — обновить title /
  description / pgn (последнее → пересборка дерева; прогресс
  пользователя НЕ сбрасывается, но линии, которых больше нет в
  дереве, помечаются `orphaned=true` и не учитываются в SRS).
- `DELETE /opening-trainer/repertoires/:id` — soft-delete (для
  возможности восстановить через 30 дней; potem hard).

### Сессии

- `POST /opening-trainer/repertoires/:id/sessions` — старт
  сессии: `{ side, mode, repeatMode? }`. Возвращает sessionId +
  initial state (если играю чёрными — первый бот-ход уже сделан;
  если белыми — жду мой ход).
- `GET /opening-trainer/sessions/:sid` — текущее состояние
  (для resume).
- `POST /opening-trainer/sessions/:sid/move` — мой ход, body
  `{ moveUci, responseTimeMs }`. Возвращает: `{ correct,
  expectedMoves?, botMoveUci?, newFen, scoreDelta, sessionState }`.
- `POST /opening-trainer/sessions/:sid/hint` — запросить
  подсказку. Возвращает один правильный ход (SAN). Помечает
  `hintUsed` на следующей попытке.
- `POST /opening-trainer/sessions/:sid/giveup` — сдаться на
  текущей позиции. Возвращает все правильные, отмечает ход как
  wrong, переходит на бот-ход.
- `POST /opening-trainer/sessions/:sid/undo` — откатить
  последний ход (отменяет scoreDelta).
- `POST /opening-trainer/sessions/:sid/finish` — закрыть
  сессию (агрегирует `OpeningTrainerAttempt` в
  `OpeningLineProgress`, рассчитывает mastered, проставляет
  `finishedAt`).

### Прогресс

- `GET /opening-trainer/repertoires/:id/progress` — список
  `OpeningLineProgress` для репертуара (для tree-view с
  покраской).
- `GET /opening-trainer/reviews/due` — список линий
  (`pathUci` + `repertoireId`), у которых `sm2DueAt <= now`. M2.

## 4. Лимиты и безопасность

- Owner-check на всех endpoints (repertoire, session).
- Лимит репертуаров на пользователя: 50 (MVP).
- Лимит активных сессий: 10 (старые автозакрываются через 24 ч
  неактивности).
- `@UserRateLimit(20, 60)` на `POST .../sessions/:sid/move` —
  типичная сессия даёт ~30 ходов в минуту, лимит 20/мин — это
  ~хороший человек, защита от автоматизации.
- PGN ≤ 500 КБ, после парсинга nodeCount ≤ 2000, edgeCount ≤ 5000.
- Дерево возвращается полностью на `GET /repertoires/:id` — без
  пагинации (M1). Если в реальной практике 2000-node репертуары
  начнут быть нормой — M2 добавит lazy-загрузку поддерева по FEN.

## 5. Этапы

### M1 (MVP — этот ADR определяет)

- Backend: миграция `OpeningRepertoire` + `OpeningTrainerSession` +
  `OpeningTrainerAttempt`. PGN → tree парсер. Endpoints CRUD
  repertoire + session lifecycle. Bot picker (random-without-repeat
  per session). Validation, лимиты. Без `OpeningLineProgress`,
  без SRS.
- Frontend: страницы `/opening-trainer/*`. Доска + ход бота +
  ход пользователя + правильно/неправильно + финал. Скоринг
  отображается в реальном времени.
- Скоринг: +10 / +5 / +1 / −5 + стрик (см. §2.7).
- repeatMode по умолчанию: `complete` (когда все варианты пройдены
  на каждой развилке — сессия завершается).

### M2

- `OpeningLineProgress` + mastered-флаг (3 подряд правильных).
- SM-2 для review-режима (как `LessonReview`).
- Режимы: «новые», «ошибочные», «к повтору».
- Compact tree-view на карточке репертуара (покраска
  mastered/learning/wrong/not-played).
- Resume сессии после refresh / возврата через дни.
- Конверсия из мастерской: кнопка «Использовать как репертуар»
  на странице анализа.

### M3

- Импорт ChessBase prep (.cbf/.cbe) — отдельный конвертер.
- Sharing репертуаров (`isPublic` флаг, как в `Analysis`).
- Лидерборды по дебютам.
- Аналитика «слабые места» (heatmap по дереву, проблемные позиции).
- Lazy-загрузка поддерева для огромных репертуаров.
- Интеграция с `opening_drill`-шагом урока (link к репертуару).
- Multi-board «дрилл» (5 линий параллельно) для intensive-режима.

## 6. Риски

1. **Транспозиции в PGN.** Если две ветки приходят в одну позицию
   (1.e4 e5 2.Nf3 ≡ 1.Nf3 e5 2.e4), бэк должен схлопнуть их в один
   node с двумя parent-edges. Алгоритм по ключу FEN — стандартный.
   Тесты обязательны.
2. **Дерево разрастается.** Пользователь импортирует базу 2000
   партий — это миллионы nodes. Лимит 2000 nodes / 5000 edges
   жёстко в DTO. Превышение — 400 с просьбой разбить.
3. **`chess.js#loadPgn` на огромных PGN.** Может занять секунды и
   блокировать event loop. Парсинг — в отдельном worker'е (если
   будет нужно) или с явным time-budget (1 секунда max, 408
   timeout если дольше). MVP — синхронно, лимит размера PGN держит
   нас в пределах ~100 мс.
4. **Concurrent sessions того же репертуара.** Возможны — мы
   создаём независимые `OpeningTrainerSession`. `playedLines`
   per-session. `OpeningLineProgress` — единая, обновляется
   commit'ом сессии (`finish`). Конфликтов нет.
5. **Бот-ход кэшируется фронтом и обходится.** Сервер — источник
   истины, фронт не доверенный. Каждый `POST .../move` — заново
   валидирует против tree. Никакой шахматной логики не делегируем
   фронту.
6. **PGN с NAG '$'$' и комментариями `{}`.** Сейчас в
   `OpeningDrillStepPayload` валидаторе уже работает
   `chess.js#loadPgn` через `pgn-normalize.ts` (KS-2280). Переиспользуем
   ту же утилиту нормализации.
7. **Удаление edge'а из репертуара при обновлении PGN.** В M2 это
   важно: `OpeningLineProgress` могут ссылаться на пути, которых
   больше нет. Помечаем такие записи `orphaned=true` (миграция
   добавит поле) и не учитываем в SRS. В M1 (где
   `OpeningLineProgress` ещё нет) — нет проблемы.
8. **Размер `OpeningTrainerSession.playedLines`.** Per-position
   накапливается. В худшем случае все 2000 позиций × 5 edges =
   10000 entries × ~20 байт = 200 КБ JSONB. Норма. Если станет
   проблемой — squash periodically (но в обычной сессии < 100
   позиций задействовано).
9. **Frontend mobile UX.** Доска + контролы должны помещаться на
   узкий экран. Применяем паттерны из ADR-073 (game step mobile
   focus-mode) — sticky-минимум, доска во весь width, контролы
   снизу. Слишком много сразу делать не будем; mobile-полировка
   — в follow-up задаче L1.

## 7. Реализация — follow-up задачи

Зависимости: B1 → B2 → B3 → F1 → F2 → L1. B и F можно частично
параллелить (frontend ходит против моков OpenAPI). Shared-типы
вытягиваются в KS-3269.

### KS-3269 (S1) — shared types для Opening Trainer

**Assignee:** backend (формальный owner shared-пакета).
**Labels:** `puzzle`, `onboarding`.
**Описание:** в `packages/shared/src/types/` добавить файл
`opening-trainer.ts` с типами: `RepertoireTree`, `RepertoireNode`,
`RepertoireEdge`, `OpeningRepertoireDto`, `OpeningTrainerSessionDto`,
`OpeningTrainerMode = 'learn' | 'review' | 'mistakes' | 'free'`,
`OpeningTrainerRepeatMode = 'cycle' | 'complete'`,
request/response DTO для всех endpoints из §3.
**Acceptance:**
- TS-сборка `packages/shared` без ошибок.
- Дискриминированные union'ы (response `move` — `correct | wrong |
  line-complete`).
- Юнит-тест на сужение по дискриминатору.

### KS-3270 (B1) — модель данных + миграции

**Assignee:** backend.
**Labels:** `puzzle`, `onboarding`, `prisma`.
**Зависит:** KS-3269.
**Описание:** Prisma миграция: модели `OpeningRepertoire` (id,
userId, title, description?, pgn TEXT, tree JSONB, lineCount,
edgeCount, createdAt, updatedAt, deletedAt?), `OpeningTrainerSession`
(см. §2.6), `OpeningTrainerAttempt` (см. §2.6). Индексы по userId,
по sessionId+createdAt. Soft-delete для репертуаров. БЕЗ
`OpeningLineProgress` (M2).
**Acceptance:**
- `npm run prisma:migrate` создаёт таблицы.
- Юнит-тесты на CRUD моделей (Repository-уровень).

### KS-3271 (B2) — PGN → RepertoireTree парсер

**Assignee:** backend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3270.
**Описание:** утилита
`apps/api/src/opening-trainer/pgn-to-tree.service.ts`. Использует
`chess.js#loadPgn` + рекурсивный обход. Транспозиции схлопывает
по FEN. Возвращает `RepertoireTree` либо ошибку валидации
(unsupported, too large, illegal moves).
**Acceptance:**
- Тесты на 6 фикстур: простая основная линия; основная + вариант;
  вложенный вариант (3 уровня); транспозиция; PGN с NAG и
  комментариями; невалидный PGN.
- Лимиты hard'ом: > 2000 nodes → 400; > 5000 edges → 400.

### KS-3272 (B3) — endpoints repertoire CRUD + session lifecycle

**Assignee:** backend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3271.
**Описание:** контроллер `OpeningTrainerController` + сервис.
Endpoints из §3 (без `/reviews/due` — это M2). Бот-picker (см. §2.3)
— чистая функция, тестируется отдельно. Скоринг (см. §2.7) — чистая
функция. Owner-check, rate-limit, лимиты.
**Acceptance:**
- 12 endpoint-тестов (happy-path + 4xx).
- Тест на random-without-repeat: 1000 итераций сессии, проверка что
  все edges пройдены ровно по разу до cycle.
- Тест на скоринг (стрик-бонус, hint-penalty, минимум 0).
- Rate-limit на `/move` срабатывает при > 20 req/min.

### KS-3273 (F1) — страницы /opening-trainer/* + доска

**Assignee:** frontend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3269, KS-3272 (моки до выкатки бэка).
**Описание:** страницы `OpeningTrainerLobbyPage`,
`OpeningTrainerNewPage`, `OpeningTrainerRepertoirePage`,
`OpeningTrainerSessionPage`, `OpeningTrainerResultPage`. Доска
через `react-chessboard`. Поток: загрузка PGN → создание
репертуара → выбор стороны → старт сессии → ходы → финал.
Состояние сессии в URL `/session/:sid` (можно refresh'нуть и
продолжить через `GET .../sessions/:sid`).
**Acceptance:**
- Smoke-тест: загрузить тестовый PGN (Каро-Канн), начать сессию
  за белых, сделать правильный ход → бот отвечает; неправильный →
  показывается ошибка.
- Финал-экран показывает баллы и список линий.
- Тесты Vitest на 3 страницы (lobby, session, result).

### KS-3274 (F2) — UX полировка: подсказки, undo, обработка
неправильных ходов

**Assignee:** frontend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3273.
**Описание:** при wrong-ходе показать popup «Правильный ответ:
e4. Попробовать снова / Показать и продолжить / Откатиться».
Кнопки `hint` (показывает один правильный ход на доске стрелкой),
`undo` (откат последнего хода). Анимация бот-хода (200 ms).
Стрик-индикатор в UI.
**Acceptance:**
- Hint показывает стрелку и засчитывает hint на след. попытке
  (+5 вместо +10).
- Undo откатывает доску и scoreDelta.
- Стрик визуально подсвечивается на 5+.

### KS-3275 (L1) — адаптив mobile, sticky CTA

**Assignee:** layout.
**Labels:** `puzzle`, `mobile`, `onboarding`.
**Зависит:** KS-3273.
**Описание:** mobile layout сессии — доска во весь width, контролы
снизу sticky, стрик/счёт в compact-line вверху. Reuse паттернов из
ADR-073 (compact header через `FocusModeContext` если он будет к
тому моменту реализован — иначе native CSS только под session
page).
**Acceptance:**
- На viewport 360×844 доска + контролы + скоринг видны без скролла.
- На desktop layout не регрессирует.

## 8. Откат

- Soft-delete у репертуаров (`deletedAt`) даёт окно восстановления.
- Frontend-маршруты `/opening-trainer/*` за feature-flag
  `openingTrainerEnabled` (как `lessonsEnabled` в `App.tsx:300`).
  Снять флаг — раздел исчезает, данные в БД остаются.
- Миграции таблиц — обратно идут стандартным
  `prisma migrate resolve` (но мы их откатывать не планируем без
  крайней нужды).
