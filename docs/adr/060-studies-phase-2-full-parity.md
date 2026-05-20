# ADR-060 — Studies Phase 2: полный паритет с Lichess через переиспользование AnalysisPage

- Статус: **Superseded by ADR-067 (2026-05-20)** — Phase 2 отменяется
  вместе с модулем Studies (он удаляется целиком). Документ оставлен
  для истории.
- Статус (исторический): Accepted
- Дата: 2026-05-12
- Связанные задачи: KS-2856 (этот пересмотр), KS-2849 (superseded — войдёт
  в новый пакет, см. §10), KS-2815 (MVP, §B остаётся актуальным в части
  модели; §B.5 UI и §B.6 «что не делаем» — пересмотрены), KS-2853 (e2e
  MVP-baseline, должен сохраниться зелёным).
- Связанные ADR: ADR-059 (Studies module — модель/REST остаются),
  ADR-037 (Move annotations — макросы), ADR-051 (паттерн public share),
  ADR-021/022 (broadcast-service — потребуется для §6 broadcast-зеркало).
- Авторы: architect

---

## 1. Контекст и проблема

### 1.1 Что построил MVP KS-2815

Реализованная по KS-2815/KS-2816..KS-2835 версия Studies даёт:

- Backend (`apps/api/src/study/`): сущности `Study` + `StudyChapter`,
  CRUD, multi-PGN импорт/экспорт, public controller, лимиты,
  feature-flag `studiesEnabled`. **Это OK, оставляем.**
- Frontend каталог (`StudiesPage`) и страница студии (`StudyPage`) —
  базовые; функциональность каталога обедненная (без поиска,
  фильтров, лайков, topics).
- Редактор главы (`StudyChapterEditorPage`, 381 строка) — **отдельный
  компонент**, на голом `useReviewState` + `ReviewMoveList`, без
  NagPalette, без рисования стрелок на доске, без `useEngine` /
  eval-bar, без `PgnHeadersModal` / `SetPositionModal`, без auto-save
  через PGN-макросы аннотаций (`useStudyChapterPersistence`).
- Public-страница (`StudyChapterPublicPage`) — собственная read-only
  обёртка; не использует существующую `InlinePgnViewer`.

### 1.2 В чём проблема

1. `StudyChapterEditorPage` — частичная **копия** `AnalysisPage`
   (1786 строк), которая уже умеет всё то, чего не хватает: NAG,
   стрелки, кружки, eval-bar, движок, кастомные позиции, PGN-заголовки,
   варианты, ShareAnalysisButton, кнопки навигации. Догнать функционал
   копии — это написать AnalysisPage заново.
2. KS-2849 (follow-up на «PgnHeadersModal / SetPositionModal /
   NagPalette / drawing arrows / engine eval / breadcrumbs / promo
   dialog») — это **именно тот** список, который AnalysisPage уже
   умеет. KS-2849 закрепляет дублирование.
3. Из §B.6 KS-2815 список «не делаем в MVP» был принят волевым
   решением архитектора: practice/conceal/gamebook, embed, лайки,
   поиск, topics, broadcast-зеркало, «Save to study». Пользователь
   просил **«полноценную Studies как у Lichess»**, не получил —
   это и есть причина пересмотра.

Пользователь:
> «У нас уже есть окно анализа и в этом окне всё есть. Зачем делать
> новое окно анализа? Архитектор плохо сделал research, сделал
> базовую фишку, которая вообще не нужна. Сделай полноценную студию
> как у Lichess.»

### 1.3 Цель этой ревизии

Превратить Studies в полнофункциональную фичу с паритетом по фичам
Lichess Studies, **без второго редактора**. Через переиспользование
AnalysisPage в режиме «source = study». Часть, которая в MVP была
объявлена «фаза 2», теперь — обязательная.

---

## 2. Полный inventory Lichess Studies (без отсечений)

Источник — `https://lichess.org/study`, `https://lichess.org/api#tag/
Studies`, исходники `lichess-org/lila/modules/study/`. Структура и
наблюдения частично собраны в §1 KS-2792 (актуально), здесь приведено
**в виде чек-листа фич** с явной классификацией.

### 2.1 Модель

| # | Фича | Lichess | Текущий Kingside MVP | Делаем в Phase 2 |
|---|------|---------|----------------------|-------------------|
| M1 | Study (контейнер с метаданными: name, description, visibility, owner, members, topics, likes, from) | ✅ | частично (нет topics, likes, members, from) | **да** |
| M2 | Chapter (дерево, tags, setup, conceal, mode, gamebook, relay) | ✅ | частично (есть mode-поле строкой, нет conceal/gamebook payload) | **да** |
| M3 | Tree узел: san, fen, comments, shapes (стрелки/кружки), glyphs (NAG), eval, clock | ✅ | через PGN-блоб + макросы [%csl/%cal/%cvc] | OK, остаётся |
| M4 | Setup: orientation, variant (standard/Chess960/...), fromFen, fromPgn | ✅ | orientation + startFen | **расширяем** (variant пока не нужен — Kingside только standard) |
| M5 | Tags (PGN header tags: White/Black/Event/Site/...) | ✅ | хранятся внутри PGN-блоба | OK |

### 2.2 Режимы главы

| # | Режим | Поведение | Текущий MVP | Phase 2 |
|---|-------|-----------|-------------|---------|
| R1 | **analysis** (default) | Свободное дерево, всё видно | ✅ | OK |
| R2 | **practice** | Main-line узлы = правильные; вариант игрока = ошибка → откат + подсказка | ❌ | **да** |
| R3 | **conceal** | Ходы после ply N скрыты до тех пор, пока пользователь не сделает правильный | ❌ | **да** |
| R4 | **gamebook** | Интерактивный учебник: каждый узел имеет инструкцию автора (intro / success / failure / move-prompt); читатель идёт по сценарию | ❌ | **да** (отдельный reader page) |

### 2.3 Редактирование (тулинг)

| # | Фича | Текущий MVP | Phase 2 |
|---|------|-------------|---------|
| E1 | Делать ходы → варианты в дереве | ✅ | OK |
| E2 | Вариант ↔ main-line (promote/demote variation) | ⚠ (есть в `useReviewState`, нет UI-кнопок) | **достать через AnalysisPage** |
| E3 | NAG (`!`, `?`, `!?`, `?!`, `!!`, `??`, оценки `+/=`, `-/+` ...) | ❌ в UI | **да** (через `NagPalette` AnalysisPage) |
| E4 | Текстовые комментарии к узлу | хранятся в PGN, нет UI | **да** |
| E5 | Стрелки и кружки на доске (4 цвета, ПКМ + модификаторы) | ❌ | **да** (через `useBoardHighlights`) |
| E6 | Удалить ход / вариант / остаток | ⚠ (есть в `useReviewState`) | **доступно через UI** |
| E7 | Promote vs demote variation | ⚠ | **UI-кнопки** |
| E8 | Кастомный стартовый FEN | поле есть, нет UI-модалки | **да** (`SetPositionModal`) |
| E9 | PGN-tags editor | ❌ | **да** (`PgnHeadersModal`) |
| E10 | Импорт PGN в главу (paste / file) | ✅ multi-PGN на студию | OK; добавить per-chapter «paste PGN → replace tree» |
| E11 | Экспорт `.pgn` главы / студии | ✅ | OK |
| E12 | Auto-save (debounce) | ✅ | OK |

### 2.4 Engine / анализ

| # | Фича | Текущий MVP | Phase 2 |
|---|------|-------------|---------|
| EN1 | Локальный Stockfish wasm для оценки текущей позиции | ❌ в studies | **да** (через `useEngine`) |
| EN2 | Eval-bar | ❌ | **да** (через `EvalBar`) |
| EN3 | Engine settings (depth/lines) | ❌ | **да** (через `EngineSettingsModal`) |
| EN4 | Cloud-eval (если есть) | N/A (нет в Kingside) | — |

### 2.5 Совместная работа

| # | Фича | Текущий MVP | Phase 2 |
|---|------|-------------|---------|
| C1 | Members: owner + contributor + viewer | только owner | **да** (как минимум contributor; spectator implicit для public) |
| C2 | Realtime sync (WebSocket): несколько contributors редактируют одновременно | ❌ | **отложено** на Phase 3 — слишком тяжело; в Phase 2 — contributor работает с last-write-wins, конфликт-сообщение |
| C3 | Presence (кто в студии) | ❌ | отложено вместе с C2 |
| C4 | Sync mode «follow leader» | ❌ | отложено вместе с C2 |
| C5 | Invite-link для contributor | ❌ | **да** (генерация ссылки + accept-flow) |

### 2.6 Видимость / доступ

| # | Фича | Текущий MVP | Phase 2 |
|---|------|-------------|---------|
| V1 | public (в каталоге, доступна всем) | ✅ (без каталога-индексации) | **расширяем** |
| V2 | unlisted (по прямой ссылке, не в каталоге) | ❌ | **да** (третье значение visibility) |
| V3 | private (только members) | ✅ | OK |

### 2.7 Шаринг / интеграция

| # | Фича | Текущий MVP | Phase 2 |
|---|------|-------------|---------|
| S1 | Прямая ссылка на главу + ply (`#<ply>`) | ⚠ (URL есть, ply hash нет) | **да** |
| S2 | Embed iframe (`/study/embed/...?theme=...`) | ❌ | **да** |
| S3 | «Save to study» из AnalysisPage / других мест | ❌ | **да** |
| S4 | Broadcast-зеркало (раунд → автостудия с главами по партиям) | ❌ | **да** |

### 2.8 Каталог и социум

| # | Фича | Текущий MVP | Phase 2 |
|---|------|-------------|---------|
| K1 | Каталог: «Hot / Newest / Updated / Popular» | ❌ | **да** |
| K2 | Поиск по названию / автору / topic | ❌ | **да** |
| K3 | Topics (теги студии — `#opening`, `#endgame`, ...) | ❌ | **да** |
| K4 | Лайки и счётчик | ❌ | **да** |
| K5 | Карточка с превью первой позиции главы | ⚠ (без превью) | **да** (миниатюра доски) |
| K6 | Страница «студии пользователя X» | ❌ | **да** (`/studies/by/:username`) |
| K7 | «Featured / recommended» | ❌ | отложено (требует ручной curation) |

### 2.9 i18n / a11y / dark-mode

Стандартно, как в остальном Kingside — `ru` + `en`, dark-mode переменные,
ARIA-меню для action-кнопок, keyboard-нав по дереву ходов.

---

## 3. Решение

### 3.1 UI-слой: `StudyChapterEditorPage` ≡ `AnalysisPage` в context-режиме

**`AnalysisPage` становится универсальным шахматным редактором** с
несколькими источниками данных:

```
AnalysisPage source = "review" | "analysis" | "puzzle" | "study"
```

Маршруты:

| Маршрут | source | identifiers |
|---------|--------|-------------|
| `/games/:id/review` | `review` | gameId |
| `/analysis` (ad-hoc) | `analysis` | localId либо новый |
| `/analysis/:id` | `analysis` | analysisId |
| `/puzzle/...` (с fen/pgn в state) | `puzzle` | puzzleFen/puzzlePgn |
| **`/studies/:slug/:chapterId`** | **`study`** | slug, chapterId |
| **`/studies/c/:chapterId`** | **`study`**, mode=`public-readonly` | chapterId |
| **`/study/embed/:studyId/:chapterId`** | **`study`**, mode=`embed` | studyId, chapterId |

**Что меняется в AnalysisPage:**

- Вводится понятие `context: AnalysisContext` — discriminated union
  (`{kind:'review'|'analysis'|'puzzle'|'study', ...}`). Резолвится из
  `useParams` + `useLocation` в начале компонента.
- Persistence-хук выбирается по контексту:
  - `review`: `useAnalysisPersistence(gameId, …)` (как сейчас).
  - `analysis`: `useSavedAnalyses` + `useAdHocAutosave` (как сейчас).
  - `study`: новый `useStudyChapterPersistence(slug, chapterId, …)`
    — уже есть в коде (KS-2827), интегрируется напрямую.
  - `puzzle`: без persistence (как сейчас).
- Header-bar (`GameMetaBar` / breadcrumbs / share-button) — рендерится
  через под-компонент `<AnalysisHeader context={...}>`, который
  switch'ит на варианты в зависимости от source.
- Read-only режим (для `study/public-readonly` и `study/embed`) —
  отдельный prop `readOnly`. Уже частично заложен в подкомпонентах,
  доделать.

**Что выкидываем:**

- `apps/web/src/pages/StudyChapterEditorPage.tsx` (381 строка) →
  удаляется. Маршрут `/studies/:slug/:chapterId` рендерит
  `AnalysisPage` напрямую.
- `apps/web/src/pages/StudyChapterPublicPage.tsx` → удаляется.
  Маршрут `/studies/c/:chapterId` рендерит `AnalysisPage` с
  `readOnly`.

### 3.2 Backend-расширения (модель, REST)

Модель `StudyChapter` (ADR-059 §4) **расширяется без breaking**:

```prisma
model StudyChapter {
  // existing: id, studyId, name, orderIdx, pgn, startFen, orientation,
  //           mode, createdAt, updatedAt
  /// KS-2856. Для mode='conceal' — ply, после которого ходы скрыты
  /// (пока не отгаданы пользователем). NULL если не conceal.
  concealPly Int?     @map("conceal_ply")
  /// KS-2856. Для mode='gamebook' — payload автора:
  /// { intro: string, byUci: { "<uci>": { hint?, success?, failure? } } }.
  /// JSON, без жёсткой схемы на уровне Prisma; валидация на API.
  gamebook   Json?
}
```

Модель `Study` тоже расширяется:

```prisma
model Study {
  // existing: id, ownerId, slug, name, description, isPublic,
  //           chaptersCount, createdAt, updatedAt
  /// KS-2856. Тройная видимость вместо bool. 'private' | 'unlisted' | 'public'.
  /// Миграция значений: isPublic=true → 'public', isPublic=false → 'private'.
  /// Поле isPublic остаётся как computed (`visibility !== 'private'`) для
  /// обратной совместимости с MVP-фронтом до раскатки Phase 2.
  visibility String   @default("private")
  /// KS-2856. Темы/теги (свободный текст, lower-case, до 5 шт).
  topics     String[] @default([])
  /// KS-2856. Денормализованный счётчик лайков.
  likes      Int      @default(0)
  /// KS-2856. Источник: 'scratch' (default), 'game:<analysisId>',
  /// 'broadcast:<roundId>'. Для интеграционных кейсов (Save to study /
  /// зеркало broadcast).
  fromKind   String   @default("scratch") @map("from_kind")
  fromRefId  String?  @map("from_ref_id") @db.Uuid
}

model StudyMember {
  studyId String @map("study_id") @db.Uuid
  userId  String @map("user_id") @db.Uuid
  /// 'owner' | 'contributor'. spectator implicit для public.
  role    String
  addedAt DateTime @default(now()) @map("added_at")

  study Study @relation(fields: [studyId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([studyId, userId])
  @@index([userId])
  @@map("study_members")
}

model StudyLike {
  studyId String   @map("study_id") @db.Uuid
  userId  String   @map("user_id") @db.Uuid
  likedAt DateTime @default(now()) @map("liked_at")

  study Study @relation(fields: [studyId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([studyId, userId])
  @@index([userId])
  @@map("study_likes")
}
```

Новые REST endpoints (дополняют ADR-059 §5):

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/studies/catalog` | Каталог `?sort=hot|new|updated|popular&q=&topic=&page=` (включает public + unlisted-by-direct-only) |
| `GET` | `/api/studies/by/:userId` | Публичные студии пользователя |
| `POST` | `/api/studies/:slug/like` | Toggle like |
| `POST` | `/api/studies/:slug/members` | Пригласить contributor `{userIdOrUsername}` |
| `DELETE` | `/api/studies/:slug/members/:userId` | Снять права contributor |
| `POST` | `/api/studies/:slug/invite-link` | Сгенерировать одноразовый invite-token (TTL 7 дней) |
| `POST` | `/api/studies/invites/:token/accept` | Принять приглашение (становится contributor) |
| `POST` | `/api/studies/from-analysis` | «Save to study» `{analysisId, studyId?|name?}`; если `studyId` пусто — создаёт новую студию + 1 главу |
| `PATCH` | `/api/studies/:slug/chapters/:chapterId/gamebook` | Обновить gamebook-payload главы |

Поведение публичности:

- `visibility='private'` — guard: только members.
- `visibility='unlisted'` — guard: только members + кто-то с прямой
  ссылкой/UUID. В каталог не попадает.
- `visibility='public'` — guard: anyone, попадает в каталог.

### 3.3 Режимы глав — UI и реализация

**R2 practice:**

- Поле `mode='practice'`. UI: на каждом ходе игрока проверяем — есть
  ли такой UCI в детях текущего узла main-line. Да → продолжаем; нет
  → ход откатывается, показывается hint (текст из `chess-expert`
  макроса либо стандартный «попробуйте другой ход»), флаг ошибки
  растёт.
- Engine отключаем в practice (чтобы не показывать «правильный» ход
  через eval-bar).
- В header-bar — режим switcher.

**R3 conceal:**

- Поле `concealPly`. UI: при отрисовке дерева скрываем все узлы с
  `ply > concealPly` до тех пор, пока пользователь не сыграет
  правильный ход в main-line. Каждый правильный ход «раскрывает» один
  ply вперёд.
- Editor: автор указывает `concealPly` в `PgnHeadersModal` или
  отдельном поле header-bar'а.

**R4 gamebook:**

- Поле `gamebook` JSON: `{intro?, byUci?: {"<uci>": {hint?, success?,
  failure?}}}`.
- Reader page — `/studies/:slug/:chapterId/play` (отдельный route +
  layout): доска + текстовая панель снизу. Pre-game `intro`,
  на ходе игрока — `success`/`failure` из payload'а по `uci`, либо
  стандартное «нет, попробуйте...».
- Editor: в режиме `gamebook` AnalysisPage показывает дополнительные
  поля на узле — `hint` / `success` / `failure` (текстовые
  textarea'ы).

Решения по умолчанию (без вопросов пользователю):

- Лимит ходов в gamebook payload — 200 узлов.
- Hint текст — до 500 символов.

### 3.4 Каталог и социум

`StudiesPage` переписывается:

- Топ-табы: «Hot» / «Новые» / «Обновлённые» / «Популярные» / «Мои».
- Боковая панель: фильтры по `topic` (chip-список), поле поиска.
- Карточка студии: миниатюра первой позиции первой главы (рендерится
  на клиенте через `MemoChessboard` size=64px либо SVG-snapshot
  через серверный endpoint — выберем дешевле).
- Лайки: кнопка-сердечко на карточке + на странице студии. Cooldown
  на сервере 1 сек.

Backend `/api/studies/catalog`:

- Без full-text PG — простой ILIKE по name/description + контейнер
  topics (`topics @> ARRAY[$1]`); индексы:
  - `(visibility, updatedAt DESC)` для `sort=updated`.
  - `(visibility, likes DESC)` для `sort=popular`.
  - `(visibility, createdAt DESC)` для `sort=new`.
  - `hot` — формула `likes / (now - createdAt + 1)`, на агрегате
    в SQL или на стороне сервиса (не критично к точности).

### 3.5 Embed

Маршрут `/study/embed/:studyId/:chapterId`:

- Layout без сайдбара/футера/header'а сайта.
- Рендер — `AnalysisPage` с `readOnly + minimalUI`.
- Theme override через query `?theme=brown|blue|...`.
- Header response: `X-Frame-Options: ALLOWALL` (или удаляем через
  nginx-config для этого префикса).
- В UI студии — диалог «Embed code», который копирует HTML-snippet
  `<iframe src="..." width="600" height="450"></iframe>` пользователю.

### 3.6 Save to study (S3)

Кнопка в AnalysisPage (когда source=`analysis` или `puzzle`):

- Открывает диалог `SaveToStudyDialog`: выбор студии из списка
  пользователя ИЛИ создать новую с inline-полем «название».
- При сабмите → `POST /api/studies/from-analysis {analysisId, studyId?
  | newStudyName?}` — backend копирует PGN из `Analysis` в новую
  главу (`fromKind='game:<analysisId>'`, `fromRefId=analysisId`).
- На успех — toast + ссылка на главу.

### 3.7 Broadcast-зеркало (S4)

**В источнике broadcast-service** (`apps/broadcast-service/src/sync/
broadcast-sync.service.ts`):

- При создании `BroadcastRound` с флагом `mirrorToStudy=true`
  (новое поле в `BroadcastRound`) — посылает HTTP-вызов на api
  (`POST /api/studies/from-broadcast-round` с `roundId` + `userId
  владельца зеркала`).
- API-стороне — `StudyService.createFromBroadcastRound(roundId)`:
  - Создаёт `Study` с `fromKind='broadcast:<roundId>'`,
    `fromRefId=roundId`, `name='<round.name>'`.
  - Для каждой `BroadcastGame` создаёт `StudyChapter` с pgn'ом.
  - Подписывается на обновления раунда (через broadcast-sync's
    PGN-stream) и append'ит ходы в pgn соответствующей главы
    (debounce 30 сек, чтобы не убивать БД).

**Решения:**

- Owner зеркала — admin или системный «broadcast-mirror-user»
  (создаётся при первом запуске; явный комментарий в коде).
- Visibility зеркала — `public` (broadcast'ы публичные).
- При удалении раунда — зеркало остаётся (read-only архив).
- В Phase 2 — opt-in: флаг `mirrorToStudy` ставится вручную админом
  на конкретном раунде. Автоматизация для всех раундов — Phase 3.

---

## 4. Что **не** делаем в Phase 2

Чтобы не превратить ревизию в бесконечный проект — явно фиксирую
оставленное на Phase 3:

- **Realtime-коллаборация** (C2/C3/C4). Phase 2 ограничивается
  contributor-моделью без WS-синхронизации. Конкурентный PATCH —
  last-write-wins, без живых стрелочек «X пишет». Это требует
  отдельной WS-инфры (sticky sessions / Redis adapter) — отложено
  с обоснованием.
- **Auto-зеркало всех broadcast-раундов**. В Phase 2 — opt-in
  вручную, чтобы не забивать каталог.
- **Featured / recommended** (K7). Требует ручной curation, отдельный
  admin-pipeline.
- **Cloud-eval** (EN4). У нас нет инфры для распределённого Stockfish.
- **Variants** (Chess960 / KOTH / ...) — у Kingside только standard.

Этот «не делаем» — **обоснованный**, не волевой. У каждого пункта
указана причина (инфра / ручная работа / нет в Kingside в принципе).

---

## 5. Этапы реализации (две волны)

Чтобы пакет не блокировал релиз ничем, делим на 2 волны.

### Wave A — UI-унификация + режимы + расширения backend

**Цель:** Studies становится полноценным редактором с режимами
analysis/practice/conceal/gamebook через AnalysisPage. Backend
поддерживает members, likes, topics, visibility.

| Категория | Кол-во | Дни |
|-----------|--------|-----|
| Backend (миграция + REST) | 6 | 3 |
| Frontend (AnalysisPage context + persistence) | 4 | 3 |
| Frontend (режимы UI — practice / conceal / gamebook) | 5 | 4 |
| Frontend (PgnHeadersModal / SetPositionModal / NagPalette / drawing — закрывает KS-2849) | 0 (получаем «бесплатно» через AnalysisPage) | 0 |
| Layout / CSS | 2 | 1 |
| Tests + e2e | 3 | 2 |
| **Итого Wave A** | **20** | **13 дн** при последовательной, **~7 при паре backend+frontend** |

### Wave B — Каталог + социум + интеграции

**Цель:** Каталог, фильтры, лайки, topics, embed, save-to-study,
broadcast-зеркало.

| Категория | Кол-во | Дни |
|-----------|--------|-----|
| Backend (catalog endpoint, likes, members, invite, from-analysis, from-broadcast-round) | 6 | 4 |
| Frontend (новый StudiesPage с фильтрами, лайками, поиском) | 4 | 3 |
| Frontend (embed page, SaveToStudyDialog, members UI) | 5 | 3 |
| broadcast-service (mirror flag, sync to api) | 2 | 1.5 |
| Layout / CSS | 2 | 1 |
| Tests + e2e | 3 | 2 |
| **Итого Wave B** | **22** | **14.5 дн** последовательно, **~8 при паре** |

### Сводка

**~42 тикета, ~27 дней последовательно или ~15 при параллельной паре
backend + frontend.** Wave A может выйти в прод раньше Wave B
(пользователь получает полноценный редактор с режимами; каталог и
интеграции — следующим этапом).

---

## 6. Что отменяется

### 6.1 KS-2849 — superseded

KS-2849 «follow-up: PgnHeadersModal / SetPositionModal / NagPalette /
drawing / engine / breadcrumbs / promo dialog» — **полностью входит в
Wave A через переиспользование AnalysisPage**. Не делаем отдельным
тикетом, **закрываем как superseded** (см. §10 декомпозиции — там
явный тикет на закрытие + комментарий-обоснование).

### 6.2 `StudyChapterEditorPage` и `StudyChapterPublicPage` — удаляются

Это часть Wave A, не отдельные тикеты на удаление.

---

## 7. Acceptance Wave A

1. Маршрут `/studies/:slug/:chapterId` рендерит `AnalysisPage` (не
   старый `StudyChapterEditorPage`).
2. На этом маршруте работают: NAG-палитра, рисование стрелок/кружков,
   eval-bar, движок, PgnHeadersModal, SetPositionModal, navigation,
   variants, удаление вариантов, share button.
3. Auto-save через `useStudyChapterPersistence` сохраняет всё дерево
   с аннотациями (макросы [%csl/%cal/%cvc/%eval/%clk]).
4. Режим `analysis` — дефолт; для главы доступны режимы `practice`,
   `conceal`, `gamebook`. Переключение из header-bar.
5. `practice`/`conceal` корректно проверяют ходы и скрывают/раскрывают
   узлы.
6. `gamebook` reader на `/studies/:slug/:chapterId/play` ведёт по
   сценарию.
7. Public-страница `/studies/c/:chapterId` рендерит AnalysisPage в
   read-only.
8. E2E из KS-2853 (14 сценариев) — все ✓ зелёные.
9. Backend `visibility`, `topics`, members, likes — таблицы и
   endpoints на месте, покрыты юнит-тестами.

## 8. Acceptance Wave B

1. `/studies` — каталог с табами hot/new/updated/popular/mine,
   поиском по name+description, фильтром по topic, лайками.
2. Карточка с миниатюрой первой позиции.
3. `/studies/by/:userId` — публичные студии пользователя.
4. `/study/embed/:studyId/:chapterId` — iframe-страница, проходит
   через nginx без `X-Frame-Options: DENY`.
5. AnalysisPage имеет кнопку «Save to study»; диалог работает.
6. `BroadcastRound` имеет флаг `mirrorToStudy`; при true создаётся
   студия с главами.
7. E2E на каждую из 6 фич.

---

## 9. Риски

| Риск | Митигация |
|------|-----------|
| **AnalysisPage становится слишком тяжёлым в поддержке** при добавлении 4-х режимов и context'а | Извлечь под-компоненты в отдельные файлы (`AnalysisHeader`, `AnalysisToolbar`, `AnalysisBoard`, `AnalysisMoveList`), сохранить тесты после рефакторинга. Это часть Wave A — отдельный тикет на refactor. |
| **Регрессия в AnalysisPage** (existing source=review/analysis/puzzle) при добавлении source=study | Перед PR-merge'ом — полный прогон существующих e2e (`AnalysisPage.*.test.tsx`). |
| **Practice/conceal/gamebook ломают auto-save** (режим не должен сохранять hint-undo как «сделанный ход») | В режиме practice — auto-save отключён или сохраняет только дерево автора, не игрока. Чёткая граница: «авторские правки» сохраняются, «попытки игрока» — нет. |
| **Broadcast-зеркало забивает БД при апдейтах PGN на каждом ходе** | Debounce 30 сек + batch (один UPDATE на главу за период). |
| **Catalog SQL без full-text** не масштабируется на 1М студий | На этапе MVP — ILIKE достаточно; full-text добавляем когда студий >10K (Phase 3). |
| **Embed `X-Frame-Options` влияет на security CSP** для главной | Префиксная nginx-конфигурация только для `/study/embed/*` — изолированно. |
| **Возможная путаница: было MVP, стал большой проект** | Wave A → отдельный релиз, Wave B → следующий. Между ними — пауза на feedback пользователя. |

---

## 10. Декомпозиция тикетов

Создаются отдельным пакетом (§D). Маппинг T-номеров на реальные KS-id
будет добавлен после создания (как в KS-2815 §D.6 / KS-2839 §11.10.1).

### 10.1 Wave A (UI-унификация + режимы + расширения backend)

**Backend (B):**

- **B1** — Prisma миграция: расширить `Study` (visibility, topics,
  likes, fromKind, fromRefId), `StudyChapter` (concealPly, gamebook),
  создать `study_members`, `study_likes`. Backfill `isPublic →
  visibility`. (backend, M)
- **B2** — DTO: расширить `CreateStudyDto`, `UpdateStudyDto` (visibility,
  topics); `CreateChapterDto`, `UpdateChapterDto` (concealPly, gamebook,
  mode whitelist). (backend, S)
- **B3** — `StudyService` обновление: `visibility` enum, members table
  CRUD, likes toggle. (backend, M)
- **B4** — `StudyAccessGuard` обновление: учёт visibility=unlisted (по
  ссылке только) + members. (backend, S)
- **B5** — REST endpoints: `POST /:slug/like`, `POST/DELETE /:slug/
  members[/:userId]`, `POST /:slug/invite-link`, `POST /invites/:token/
  accept`, `PATCH /:slug/chapters/:id/gamebook`. (backend, M)
- **B6** — тесты Wave A (permissions matrix + новые endpoints).
  (backend, M)

**Frontend — рефакторинг AnalysisPage (F-refactor):**

- **FR1** — извлечь `AnalysisHeader` под-компонент. (frontend, M)
- **FR2** — извлечь `AnalysisBoard` под-компонент. (frontend, M)
- **FR3** — извлечь `AnalysisMoveList` под-компонент (на базе
  `ReviewMoveList`). (frontend, M)
- **FR4** — ввести `AnalysisContext` discriminated union + резолвер
  `useAnalysisContext()`. Persistence-хук выбирается через context.
  (frontend, M)

**Frontend — переключение Studies на AnalysisPage:**

- **FS1** — маршрут `/studies/:slug/:chapterId` → `AnalysisPage` с
  `context={kind:'study', slug, chapterId}`. Удалить
  `StudyChapterEditorPage`. (frontend, M)
- **FS2** — маршрут `/studies/c/:chapterId` → `AnalysisPage` с
  `context={kind:'study', mode:'public-readonly'}`. Удалить
  `StudyChapterPublicPage`. (frontend, S)

**Frontend — режимы:**

- **FM1** — UI mode-switcher в header-bar главы. (frontend, S)
- **FM2** — режим `practice`: валидация хода игрока vs main-line,
  hint после ошибки, откат. (frontend, M)
- **FM3** — режим `conceal`: скрытие узлов после ply, инкремент
  раскрытия. (frontend, M)
- **FM4** — режим `gamebook` editor (поля hint/success/failure на
  узле). (frontend, L)
- **FM5** — режим `gamebook` reader (`/studies/:slug/:chapterId/play`).
  (frontend, L)

**Layout:**

- **L1** — стили mode-switcher + gamebook-reader. (layout, S)
- **L2** — стили practice/conceal overlay'ев на доске. (layout, S)

**Tests + e2e:**

- **T1** — обновить `AnalysisPage.*.test.tsx` под context. (frontend, M)
- **T2** — новые e2e на режимы (practice, conceal, gamebook). (frontend, M)
- **T3** — прогон baseline'а KS-2853 на новой реализации. (frontend, S)

**Отмена legacy:**

- **X1** — закрыть KS-2849 как superseded (комментарий + transition
  в Cancelled — делает координатор). (architect, S)

### 10.2 Wave B (каталог + социум + интеграции)

**Backend:**

- **B7** — `GET /api/studies/catalog` с фильтрами/sort. (backend, M)
- **B8** — `GET /api/studies/by/:userId` (публичные студии пользователя).
  (backend, S)
- **B9** — `POST /api/studies/from-analysis` (Save to study). (backend, M)
- **B10** — broadcast-service: поле `mirrorToStudy`, HTTP-вызов в api
  + `POST /api/studies/from-broadcast-round`. (backend, M)
- **B11** — append-to-pgn-chapter сервис для broadcast-зеркала (с
  debounce 30s). (backend, M)
- **B12** — тесты Wave B (catalog, likes, mirror). (backend, M)

**Frontend:**

- **FC1** — переписать `StudiesPage` с табами/фильтрами/поиском.
  (frontend, L)
- **FC2** — `StudyCatalogCard` с миниатюрой позиции. (frontend, M)
- **FC3** — like-кнопка на карточке + на странице студии. (frontend, S)
- **FC4** — page `/studies/by/:userId`. (frontend, S)
- **FC5** — `/study/embed/:studyId/:chapterId` минимальный layout +
  AnalysisPage в readOnly+minimalUI. (frontend, M)
- **FC6** — `SaveToStudyDialog` в AnalysisPage. (frontend, M)
- **FC7** — `StudyMembersDialog` (invite, accept, remove). (frontend, M)
- **FC8** — UI приёма приглашения `/studies/invites/:token`. (frontend, S)

**Layout:**

- **L3** — стили каталога с фильтрами. (layout, S)
- **L4** — стили embed-страницы (без хедера сайта). (layout, S)

**broadcast-service:**

- **D1** — nginx-конфиг: разрешить iframe для `/study/embed/*` (без
  `X-Frame-Options: DENY`). (devops, S)

**Tests + e2e:**

- **T4** — e2e на каталог (поиск, фильтр, сортировка, лайк). (frontend, M)
- **T5** — e2e save-to-study + invite-flow. (frontend, M)
- **T6** — e2e embed render. (frontend, S)

### 10.3 Реальные ключи в трекере (созданы пакетом KS-2856)

**Wave A (20 тикетов):**

| T | KS | Assignee |
|---|----|----------|
| B1 | KS-2857 | backend |
| B2 | KS-2858 | backend |
| B3 | KS-2859 | backend |
| B4 | KS-2860 | backend |
| B5 | KS-2861 | backend |
| B6 | KS-2862 | backend |
| FR1 | KS-2863 | frontend |
| FR2 | KS-2864 | frontend |
| FR3 | KS-2866 | frontend |
| FR4 | KS-2867 | frontend |
| FS1 | KS-2868 | frontend |
| FS2 | KS-2869 | frontend |
| FM1 | KS-2870 | frontend |
| FM2 | KS-2871 | frontend |
| FM3 | KS-2872 | frontend |
| FM4 | KS-2873 | frontend |
| FM5 | KS-2874 | frontend |
| L1 | KS-2875 | layout |
| L2 | KS-2876 | layout |
| T1 | KS-2877 | frontend |
| T2 | KS-2878 | frontend |
| T3 | KS-2879 | qa |
| X1 | KS-2849 | architect (закрытие superseded — комментарий оставлен, transition делает координатор) |

**Wave B (22 тикета):**

| T | KS | Assignee |
|---|----|----------|
| B7 | KS-2880 | backend |
| B8 | KS-2881 | backend |
| B9 | KS-2882 | backend |
| B10 | KS-2883 | backend |
| B11 | KS-2884 | backend |
| B12 | KS-2885 | backend |
| FC1 | KS-2886 | frontend |
| FC2 | KS-2887 | frontend |
| FC3 | KS-2888 | frontend |
| FC4 | KS-2889 | frontend |
| FC5 | KS-2890 | frontend |
| FC6 | KS-2891 | frontend |
| FC7 | KS-2892 | frontend |
| FC8 | KS-2893 | frontend |
| L3 | KS-2894 | layout |
| L4 | KS-2895 | layout |
| D1 | KS-2896 | devops |
| T4 | KS-2897 | frontend |
| T5 | KS-2898 | frontend |
| T6 | KS-2899 | frontend |

**Итого создано:** 42 тикета (Wave A: 23 включая FR3 в KS-2866 и X1, Wave B: 20). Все в статусе TODO, запуск пакетами по согласованию координатора. Wave A может выйти в прод отдельно от Wave B.

---

## 11. Ссылки

- `docs/architecture/KS-2792-studies-research.md` §§1–§2 — inventory
  Lichess Studies (актуально).
- `docs/architecture/KS-2815-studies-standalone.md` — план MVP (§B.5
  UI и §B.6 «что не делаем» — пересмотрены этим ADR; §A карта
  переиспользования и §B.3 модель — остаются).
- `docs/adr/059-studies-module.md` §4 модель + §5 REST — расширяются
  здесь, не отменяются.
- ADR-037 — макросы аннотаций в PGN.
- ADR-021/022 — broadcast-service (потребуется для §3.7).
- KS-2849 — superseded (см. §6.1).
- KS-2853 — e2e baseline (должен остаться зелёным).
- Файлы для рефакторинга / удаления:
  - `apps/web/src/pages/AnalysisPage.tsx` — рефакторинг (FR1..FR4) и
    интеграция context.
  - `apps/web/src/pages/StudyChapterEditorPage.tsx` — **удаляется**.
  - `apps/web/src/pages/StudyChapterPublicPage.tsx` — **удаляется**.
  - `apps/web/src/hooks/useStudyChapterPersistence.ts` — остаётся,
    подключается из AnalysisPage в `study`-режиме.
