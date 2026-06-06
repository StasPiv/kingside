# ADR-111: Live-analysis — полная трансляция содержимого окна анализа

**Статус:** Предложено
**Дата:** 2026-06-06
**Задача:** KS-3741
**Родительский ADR:** [ADR-110](./110-live-analysis-broadcast.md)

## 1. Контекст

### Что есть сейчас (после ADR-110 / KS-3732)

1. **Backend** — модуль `apps/api/src/live-analysis/`:
   - `live-analysis.controller.ts`: `POST /live-analyses`, `GET /live-analyses/:slug`, `DELETE /live-analyses/:id`, `GET /live-analyses` (мои).
   - `live-analysis.gateway.ts`: namespace `/live-analysis`, события `SUBSCRIBE | UNSUBSCRIBE | MOVE | RESET | CLOSE | SYNC_REQUEST | SYNC | VIEWERS | CLOSED | ERROR`.
   - `live-analysis.service.ts`: state per-slug в Redis hash + UCI history (List) + viewers (Int), pub/sub каналы `live-analysis:move|sync|closed`, mutex per-slug, rate-limit ходов, cleanup-job 30 мин.
   - Что передаётся в реальном времени: только UCI-ход (`MoveEvent { slug, uci, fen, ply }`) + `SyncSnapshot { slug, startingFen, moves: string[], currentFen, currentPly, orientation }`.

2. **Frontend** — страница зрителя `apps/web/src/pages/LiveAnalysisViewerPage.tsx`:
   - Рендерит **только** `<Chessboard>` + счётчик зрителей + баннер закрытия.
   - Локальная ветка зрителя: перетащил фигуру → `viewerFen` обновился локально, на сокет ничего не уходит. Кнопка «Вернуться к трансляции».
   - НЕ показывает: список ходов, варианты, NAGs, комментарии, аннотации (стрелки/highlights), opening tree, движок Stockfish, инфо о партии.

3. **Сторона автора** — `apps/web/src/pages/AnalysisPage.tsx` + хук `useAnalysisLiveBroadcast`:
   - Кнопка «Транслировать» создаёт live-analysis, эмитит `move` на каждый ход автора.
   - Аннотации/комментарии/варианты/NAGs у автора живут в Review-state локально (см. ниже §1.5) и в реалтайм НЕ улетают.

### Существующая публичная страница анализа (research под §1 задачи)

4. **Маршрут:** `/analysis/public/:id` в `apps/web/src/App.tsx:746` рендерит `AnalysisPage` с пропом `publicMode=true`.
5. **Загрузка данных:** `useSavedAnalyses.getPublicById` → `GET /analyses/public/:id`. Контроллер `apps/api/src/analysis/analysis-public.controller.ts` без `JwtAuthGuard`. Поля ответа (`packages/shared/src/types/api-contracts.ts:1574 AnalysisResponse`):
   - `id`, `userId`, `title`, `pgn`, `fen`, `opening`, `currentPosition`, `boardOrientation`, `isPublic`, `originalAnalysisId`, `createdAt`, `updatedAt`.
   - Поле `pgn` — **annotated PGN**: содержит варианты, NAGs (`!`, `?`, `!!`, `??`, `!?`, `?!`), комментарии, расширения `[%csl ...]` (highlights клеток), `[%cal ...]` (стрелки), `[%cvc ...]` (цвет варианта — KS-2286).
   - Парсится фронтом через `apps/web/src/review/utils/PgnDeserializer.ts → parseAnnotatedPgn` → дерево `ChessMove` с полями `nags`, `comment`, `annotations.{highlights,arrows}`, `variations`, `variationColor` (см. `apps/web/src/review/types.ts`).
   - Сериализуется обратно через `PgnSerializer.serializeToAnnotatedPgn` (вызывается автосейвом автора, см. `useAdHocAnalysisAutosave`).
6. **Шаринг:** `PATCH /analyses/:id/share` с body `{ isPublic: boolean }`. Слаг = UUID (поле `id`). Ссылка автора — `kingside.site/analysis/public/<uuid>` (фронт-роутер).
7. **Компоненты публичной страницы** (= обычной AnalysisPage в `publicMode`):
   - `AnalysisHeader` — breadcrumbs + title (read-only в publicMode).
   - `AnalysisBoard` — `<Chessboard>` + EvalBar + GameMetaBar + promotion overlay + VariationChooser.
   - `AnalysisSidebar` — `panelStates: { gameInfo, engine, moves, ai, book }`:
     - **engine** — Stockfish-панель (локальный wasm у зрителя, серверные эвалуации не передаются — каждый запускает свой движок).
     - **moves** — `ReviewMoveList` (дерево ходов c вариантами, NAGs, комментариями, цветами вариаций).
     - **book** — `ArchiveTreePanel`: opening explorer (статистика из архива партий). Загружается отдельным REST-запросом по текущему FEN, **не зависит от автора**.
     - **ai** — `AiPositionCommentPanel`: запрашивает комментарий LLM по позиции, локально для зрителя.
     - **gameInfo** — `GameMetaBar` (мета из PGN-headers: white/black, event, ELO).
   - В publicMode autosave / edit-title / Share / change-PGN-headers — выключены.

### Что просит пользователь / KS-3741

Зритель live-трансляции должен видеть **то же, что и на публичной странице анализа** (`/analysis/public/:id`), но содержимое должно обновляться в реальном времени по мере того, как автор работает в своём окне:

- ходы (уже есть);
- комментарии к ходам;
- дерево вариантов (включая удаление/promote/truncate);
- аннотации (стрелки `[%cal]`, выделения `[%csl]`, цвета вариаций `[%cvc]`);
- NAGs;
- PGN-headers (если автор изменил metadata);
- «книга» — opening tree. **Не нужно передавать через WS:** ArchiveTreePanel запрашивает `/archive/tree?fen=...` локально по текущему FEN, как и у автора. Достаточно, чтобы зритель видел актуальный FEN — дерево подтянется само. То же касается Stockfish (локальный wasm у зрителя) и AI position comment (отдельный LLM-запрос).

То есть **через realtime канал критично передавать только аннотированный PGN + текущий ply**. Остальные панели — производные от PGN/FEN и не требуют отдельной синхронизации.

### Что НЕ в скоупе ADR-111

- Persistent-сохранение трансляции как `Analysis` после её закрытия (отдельный follow-up — «сохранить разбор в мастерскую»).
- Совместное редактирование зрителями (collaborative editing) — зрители остаются read-only.
- Real-time передача Stockfish-оценок автора (каждый зритель крутит локальный движок).
- Передача AI-комментариев автора через WS.
- Изменение namespace / транспорта — остаёмся на `/live-analysis` в `apps/api`.

## 2. Решение

### 2.1 Что синхронизируется в реальном времени (§2 задачи)

| Поле | Источник истины | Канал передачи | Частота |
| --- | --- | --- | --- |
| Аннотированный PGN (включая дерево, варианты, NAGs, комментарии, `[%csl]`, `[%cal]`, `[%cvc]`) | автор (`AnalysisPage` review-state) | WS `state-patch` (новое событие) | дебаунс 500 мс per-slug |
| Совершённый ход (UCI) | автор | WS `move` (как сейчас) | мгновенно на каждый ход |
| PGN headers (White/Black/Event/Round/ELO/Result/...) | автор (`PgnHeadersModal`) | вместе со `state-patch` | дебаунс 500 мс |
| `currentPosition` / `currentPly` (на каком ходу автор сейчас стоит) | автор | вместе с `move` и `state-patch` | мгновенно/дебаунс |
| `boardOrientation` (white/black) | автор | вместе со `state-patch` | мгновенно при изменении |
| Стартовый FEN / SetUp | автор | `sync` / `reset` (как сейчас) | при создании или reset |
| Счётчик зрителей | сервер | WS `viewers` (как сейчас) | throttle 2с |
| Статус (active/closed) | сервер | WS `closed` (как сейчас) | мгновенно |
| Opening explorer (book) | архив-сервис | **не через WS**, локальный REST у зрителя по FEN | по факту смены FEN |
| Stockfish-линии | локальный wasm зрителя | **не через WS** | локально |
| AI position comment | LLM endpoint | **не через WS**, локально по запросу | локально |

**Обоснование «передаём PGN целиком, а не дельты»:**
- Источник истины анализа — annotated PGN. PgnSerializer уже превращает фронтовское дерево `ChessMove` в строку, deserializer — обратно. Никакого нового структурированного протокола изобретать не нужно.
- Альтернатива (granular events: `nag-set`, `comment-set`, `variation-add`, `arrow-set`, `variation-color-set`, `variation-promote`, `variation-delete`, `variation-truncate`, ...) — требует на сервере реализовать копию модели review-state и применять патчи по порядку. Любое расширение фронта (новый тип аннотации) тянет миграцию контракта и обоих концов. Дорого, хрупко.
- Альтернатива (JSON-patch RFC 6902 по review-tree) — компромисс, но дерево с polymorphic-вариантами плохо ложится в JSON-patch path-семантику, и кеширование «предыдущей версии у каждого зрителя» добавляет ещё один источник рассинхрона.

**Цена решения «полный PGN»:** объём. На длинном разборе с вариантами и комментариями PGN — единицы–десятки KB. При дебаунсе 500 мс и пике из §2.7 ADR-110 (50 трансляций × 30 зрителей × 2 эмита/сек × 10 KB) — порядка 30 MB/сек egress. Митигация:
- Дебаунс 500 мс per-slug (см. §2.5).
- Hard cap размера PGN 256 KB — отклоняем большие (`error: pgn-too-large`).
- Socket.IO `perMessageDeflate: true` для сжатия (уже работает на стороне сервера; включить явно в gateway). Аннотированный PGN жмётся ~5×.
- Подписку на full-payload отдаём только зрителю, который явно подписался (см. §2.2 ниже): кто-то хочет «только доска» — пусть подписывается без `full=true` и получает старый поток (move + sync без PGN).

### 2.2 Транспорт: расширение `/live-analysis` (§3 задачи)

**Решение: расширить существующий namespace `/live-analysis` новыми событиями. Не делать единый «полный snapshot» событием.**

Аргументы:
- `move` остаётся узким каналом для частого случая (ход автора). Это даёт мгновенную анимацию у зрителя без ожидания debounce'нутого `state-patch`. Без `move` зритель видел бы «ход с задержкой 500 мс», что неприятно.
- `state-patch` — отдельное событие для редких изменений (комментарий, NAG, новый вариант, стрелка, headers). Дебаунс не задевает плавность доски.
- Sync на subscribe — единый event со всеми полями.

**Новые/расширенные события:**

| Событие | Направление | Payload (новый/изменённый) | Когда |
| --- | --- | --- | --- |
| `SUBSCRIBE` | client→server | `{ slug, mode?: 'board' \| 'full' }` (по умолчанию `'full'`) | при подписке зрителя |
| `SYNC` | server→client | `{ slug, startingFen, moves: string[], currentFen, currentPly, currentPgn?: string, headers?: PgnHeaders, orientation, title?: string, ownerUsername?: string \| null }` | в ответ на subscribe / на pub-sub broadcast |
| `MOVE` | как сейчас | `{ slug, uci, fen, ply }` | автор сделал ход |
| `STATE_PATCH` | client→server, server→client | `{ slug, pgn: string, headers?: PgnHeaders, currentPly?: number, orientation?: 'white' \| 'black' }` | автор изменил аннотацию/вариант/headers/orientation, дебаунс 500 мс |
| `RESET` | как сейчас + расширить | `{ slug, fen?, pgn? }` (добавить `pgn`) | автор «Установить позицию» / переключился на другую партию |
| `CLOSE` / `CLOSED` / `VIEWERS` / `ERROR` | без изменений | — | — |

**Поле `mode` в SUBSCRIBE.** На старте отдаём всем `full` по умолчанию — фронт всегда хочет полный анализ. `'board'` оставляем зарезервированным для будущих ботов/виджетов «только доска» (например, OBS-плагин стримера), которые не хотят гонять PGN. Этого хватит, чтобы не делать second-pass refactoring при появлении такого требования.

**Поле `currentPly` в `STATE_PATCH`.** Передаётся, потому что author может листать вперёд/назад по своему дереву без совершения новых ходов — `move` в этом случае не эмитится, но «где сейчас стоит автор» меняется. Зритель ставит свой `ReviewMoveList` в ту же позицию (это даёт ощущение «смотрит вместе с автором»).

**Тип `PgnHeaders`.** Запись `Record<string, string>` со стандартными ключами (`Event`, `Site`, `Date`, `Round`, `White`, `Black`, `Result`, `WhiteElo`, `BlackElo`, `WhiteTitle`, `BlackTitle`, `ECO`, `Opening`). Они уже сидят внутри `pgn`, но дублируются явным полем — фронт `GameMetaBar` читает их без парсинга.

### 2.3 Модель данных (§4 задачи)

**PostgreSQL — таблица `live_analyses` без изменений.** Полная PGN-строка эфемерна и в БД не персистится. Если в будущем «сохранить разбор после закрытия» — добавим колонку `final_pgn TEXT?` отдельной миграцией (см. §3 — это вне scope MVP-расширения).

**Redis — расширяем hash `live_analysis:<id>:state`:**

| Поле | Тип | Описание |
| --- | --- | --- |
| `startingFen` | string | как сейчас |
| `currentFen` | string | как сейчас |
| `currentPly` | string (число) | как сейчас |
| `orientation` | `'white' \| 'black'` | как сейчас |
| **`currentPgn`** (новое) | string (annotated PGN) | последний PGN автора. До первой `state-patch` от автора — `null` / пустая строка. |
| **`headersJson`** (новое) | string (JSON-stringified `PgnHeaders`) | PGN-headers отдельной мапой. Если null — фронт парсит из `currentPgn`. |
| **`lastPatchAt`** (новое) | string (UNIX ms) | timestamp последнего `state-patch`. Дополнительно к `lastActivityAt` в PG — для дебаунса на сервере. |

**Hard cap `currentPgn` = 256 KB.** Это перекрывает даже сильно аннотированный анализ. При превышении сервер кидает `error: pgn-too-large`, патч не применяется. Защита от случайного «бесконечного дерева» и преднамеренного абуза автора.

**Что НЕ храним в Redis:**
- Дерево `ChessMove` в JSON. PGN сам по себе — компактная форма дерева, нет смысла дублировать.
- Per-viewer state.
- Opening-tree / engine-eval (не источник истины).

**Pub/sub каналы:**
- `live-analysis:move` — без изменений.
- `live-analysis:sync` — payload расширяется (currentPgn, headers).
- `live-analysis:closed` — без изменений.
- **Не вводим отдельный `live-analysis:state-patch` канал.** State-patch на сервере конвертится в `sync` (полный snapshot) и публикуется в `live-analysis:sync`. Аргумент: gateway уже подписан на `sync`, и в комнате каждый зритель получит свежий snapshot. Дополнительный канал = больше кода, больше point-of-failure без выгоды.

### 2.4 Авторизация (§5 задачи)

**Остаётся как в ADR-110.**
- `POST /live-analyses` — `JwtAuthGuard`.
- `GET /live-analyses/:slug` — публично.
- `DELETE /live-analyses/:id` — owner-only.
- WS `subscribe`/`unsubscribe` — без auth (анонимы).
- WS `move` / `reset` / **`state-patch`** / `close` — **только owner** (по JWT в handshake + сравнение `ownerId`).

`state-patch` сюда добавляется на тех же правах, что `move`: автор → ok, аноним → `error { code: 'forbidden' }`.

Antiabuse-меры из ADR-110 (rate-limit ходов, IP cap, viewer cap) остаются. Дополнительно — **rate-limit `state-patch` у автора**: 5 патчей/сек с burst 10 (на случай если фронт случайно эмитит на каждый keystroke в комментарии без дебаунса).

### 2.5 Жизненный цикл (§6 задачи)

**Без изменений по сравнению с ADR-110.**
- Создаётся `POST /live-analyses` от автора на `AnalysisPage`.
- Закрывается явно (`DELETE` / WS `close`) или по таймауту 30 мин неактивности (cleanup-job).
- Любой `state-patch` обновляет `lastActivityAt` (throttle 10 сек — не каждый патч в БД).

**Дебаунс state-patch у автора:** 500 мс per-slug на стороне фронта (см. §2.7). Сервер дополнительно дросселирует приём (5 патчей/сек, burst 10) — это страховка от поломки клиентского дебаунса, не основной механизм.

### 2.6 Frontend (§7 задачи)

**Решение: переиспользовать `AnalysisPage` в специальном режиме, а не отдельный `LiveAnalysisViewerPage`.**

Аргумент очевиден: вся обвязка (Sidebar/Board/Header/Stockfish/ArchiveTree/AI/панели) уже сделана. Дублировать — самоубийство. Текущий `LiveAnalysisViewerPage` оставляем только как тонкую обёртку-роут, она монтирует `AnalysisPage` с новыми пропами.

**Изменения в `AnalysisPage`:**
- Добавить проп `liveBroadcast?: { slug: string; mode: 'viewer' }`.
- В `liveBroadcast.mode==='viewer'` поведение = `publicMode=true` (read-only, autosave/share/edit-title выключены), **плюс**:
  - Источник PGN — не REST, а WS. На mount — `useLiveAnalysisSocket` подписывается на `slug`, ждёт `sync`, отдаёт `currentPgn`/`headers` в `AnalysisContext`.
  - На каждый `STATE_PATCH` или `SYNC` event — обновляем PGN внутри (через существующий механизм `parseAnnotatedPgn` → setHistory). На каждый `MOVE` — оптимистично проигрываем UCI (как в текущем LiveAnalysisViewerPage), `state-patch` потом «выровняет».
  - Локальная ветка зрителя (зритель перетащил фигуру → ушёл с авторской линии): не затирать review-tree входящими `state-patch`. Поведение: при наличии локальных изменений показываем badge **«Получено обновление от автора»** с кнопкой «Применить». Применение = `setHistory` свежим деревом из PGN, локальные правки зрителя пропадают (с предупреждением). Без принудительной перезаписи.
  - Skрываем явно owner-only пункты `AnalysisActionsMenu` (Share, «Транслировать», Save) — точно так же, как сейчас работает `publicMode`.

**Изменения в `LiveAnalysisViewerPage.tsx`:**
- Превращается в обёртку:
  - читает `:slug` из URL,
  - дёргает `GET /live-analyses/:slug` для early-error (`not-found`/`closed`),
  - рендерит `<AnalysisPage liveBroadcast={{slug, mode:'viewer'}} />`.
- Локальный `Chessboard`, локальный `useLiveAnalysisSocket` — переезжают внутрь `AnalysisPage` через новый хук `useLiveAnalysisBroadcast(slug, mode)` (см. ниже).

**Новый хук `useLiveAnalysisBroadcast(slug, mode)`:**
- Под капотом — `useLiveAnalysisSocket` + обработчики событий.
- Возвращает `{ snapshot, viewerCount, closedReason, hasPendingPatch, applyPendingPatch }`.
- На стороне `viewer`-режима: при первом `SYNC` ставит PGN/headers в `AnalysisContext`. На `STATE_PATCH`: если local-fork нет → applyPGN; есть → копит в `pendingPatch`, выставляет `hasPendingPatch=true`.

**Сторона автора (расширение `useAnalysisLiveBroadcast`):**
- Подписаться на review-state (`history`, `annotations`, `comments`, `nags`, `variations`, `boardOrientation`, headers).
- При любом изменении — дебаунс 500 мс — `serializeToAnnotatedPgn(history)` и `socket.emit('state-patch', { slug, pgn, headers, currentPly, orientation })`.
- Move оставить как сейчас (мгновенно на ход).

**Что НЕ переезжает в live-режим:**
- Кнопка «Транслировать» на AnalysisPage — у автора как сейчас.
- Save-локально / autosave / Share / Edit-title — у автора как сейчас.

### 2.7 Backend (§8 задачи)

Все правки локализованы в `apps/api/src/live-analysis/`.

1. **`packages/shared/src/types/api-contracts.ts`** (либо в собственный модуль `events/live-analysis.ts`):
   - `LiveAnalysisEvents` — добавить `STATE_PATCH = 'state-patch'`.
   - `LiveAnalysisSyncSnapshot` — расширить полями `currentPgn?: string`, `headers?: Record<string,string>`, `title?: string | null`, `ownerUsername?: string | null`.
   - Новый `LiveAnalysisStatePatchEvent { slug, pgn, headers?, currentPly?, orientation? }`.
   - `LiveAnalysisErrorEvent.code` — добавить `'pgn-too-large'`.

2. **`live-analysis.service.ts`:**
   - Добавить метод `applyStatePatch(slug, actingUserId, patch: { pgn, headers?, currentPly?, orientation? })`:
     - assertOwnerAndActive (как у `applyMove`).
     - rate-limit per-slug (5/сек, burst 10) — отдельный `TokenBucketLimiter`.
     - hard cap `pgn.length <= 262144` → иначе `BadRequestException('pgn-too-large')`.
     - валидация: `new Chess(); chess.loadPgn(pgn, { strict: false })` — если throws, `BadRequestException('Invalid PGN')`.
     - извлечь currentFen из загруженного chess (или применить `currentPly` если передан).
     - HSET state hash: `currentPgn`, `headersJson`, `currentFen`, `currentPly`, `orientation` + EXPIRE.
     - touchLastActivity (throttled).
     - **publish `live-analysis:sync`** с полным `SyncSnapshot` (включая moves: chess.history({verbose:false}) → UCI/SAN — здесь UCI, см. ниже).
   - В `getSyncSnapshot` и `getBySlug` — возвращать `currentPgn` и `headers` из Redis.
   - **moves**: продолжаем хранить UCI list. На state-patch — синхронизируем list с тем, что в PGN main-line: `DEL :moves; RPUSH ...newMoves`. Иначе после reset/patch UCI history рассинхронизируется с PGN, и зритель, который опоздал, увидит несовпадение.

3. **`live-analysis.gateway.ts`:**
   - Новый handler `@SubscribeMessage(LiveAnalysisEvents.STATE_PATCH)` — owner-check, вызов `service.applyStatePatch(...)`. По возврату — pub/sub `sync` уже разлетится.
   - `SubscribePayloadDto` — добавить `mode?: 'board' | 'full'`. На MVP оба поведения шлют одинаковый `sync` (поле `mode` зарезервировано для будущего, не влияет на бэк сейчас).
   - DTO `StatePatchPayloadDto` — class-validator (`@IsString() pgn`, `@MaxLength(262144) pgn`, `@IsObject() @IsOptional() headers`, `@IsInt() @Min(0) @IsOptional() currentPly`, `@IsIn(['white','black']) @IsOptional() orientation`).
   - В `mapErrorToPayload` — case `'pgn-too-large'` (по сообщению либо отдельный exception type).

4. **Метрики (`metrics.service.ts`):**
   - `live_analysis_state_patches_total` (counter), `live_analysis_state_patch_bytes_sum` (counter для среднего размера), `live_analysis_state_patch_rejected_total{reason="too_large"|"rate_limit"|"invalid_pgn"}`.

5. **`live-analysis.module.ts`:** новые DTO, без структурных изменений.

6. **Тесты:**
   - service-spec: applyStatePatch happy path, валидация PGN, hard cap, rate-limit, синхронизация moves-list, owner-check.
   - gateway-spec: subscribe→sync включает currentPgn, state-patch от анонима → forbidden, state-patch с битым PGN → error.
   - e2e: автор шлёт state-patch → зритель получает SYNC с currentPgn в течение 1с.

### 2.8 Риски и подводные камни

1. **Размер PGN в долгой сессии.** Аннотированный анализ с длинным деревом вариантов и подробными комментариями может выйти за 100 KB. Hard cap 256 KB — комфортный потолок (по статистике существующих `Analysis` в БД — порядок десятков KB на максимум). При превышении автор увидит toast «Трансляция отстаёт: содержимое слишком большое» и сможет либо обрезать дерево, либо завершить трансляцию.

2. **Чтение headers из PGN vs из отдельного поля.** Дублирование. Решено в пользу обоих: `headers` — удобная мапа без парсинга, `currentPgn` — каноничный источник. При расхождении побеждает `currentPgn` (PGN-парсер заново вычитает headers, маппинг перетрётся).

3. **Race у зрителя: move прилетел раньше state-patch.** Move обновил currentFen, дерево PGN ещё старое. Решение: зритель применяет move мгновенно к локальному `currentFen` (как в текущем LiveAnalysisViewerPage), при следующем `sync` дерево пересобирается из свежего PGN, currentFen синхронизируется с `currentPly`. Сценарий выровняется за дебаунс-окно 500 мс.

4. **Race у автора: одновременно эмит move + state-patch с конфликтом.** Mutex per-slug в сервисе уже сериализует. Move применился → currentFen и moves-list обновились. state-patch пришёл с устаревшим деревом без последнего хода — applyStatePatch перепишет moves-list по PGN. Это **корректно**: автор сам отвечает за консистентность своего PGN; если он шлёт state-patch без последнего хода — значит на его UI этого хода нет в дереве. Главное — после patch'а dataflow выровнен.

5. **Множественные вкладки автора.** Если автор открыл AnalysisPage в двух вкладках — обе шлют move/state-patch в одну трансляцию. Решение: фронт в `useAnalysisLiveBroadcast` ставит lock в localStorage (одна вкладка активна) — это **отдельный follow-up** на frontend, не в этом ADR. Сейчас race разрешается mutex'ом per-slug + последний эмит выигрывает.

6. **Локальная ветка зрителя при частых state-patch.** Зритель свернул в вариант, автор шлёт 4 патча/мин. Без бейджа «получено обновление» зритель не понял бы, что доступна свежая версия. Бейдж — обязательная часть UX, не «nice to have».

7. **Opening tree (book) у зрителя.** ArchiveTreePanel дёргает `/archive/tree?fen=<currentFen>` локально. При live-переключении автором currentFen меняется быстро → у зрителя пойдёт серия таких запросов. Митигация: debounce запроса дерева на 300 мс (уже работает в существующем компоненте? — проверить в реализации; иначе добавить). Это вне scope live-analysis, но flag для frontend-задачи.

8. **Stockfish у зрителя.** Каждое обновление currentFen дёргает локальный wasm. У зрителя движок будет постоянно прерываться/перезапускаться при частых ходах автора. Текущее поведение `useStockfish` уже handles это (cancel + restart на смену FEN). Не блокер.

9. **PGN headers — приватные данные.** Если автор поставил `[White "Anonymous"]` локально, но в headersJson попало что-то ещё (например, autosave из открытого ранее анализа) — пробросится зрителям. Митигация: автор контролирует headers сам, никаких автоматических вставок не делаем без явного действия (это и так так работает в `PgnHeadersModal`).

10. **Атрибут `mode: 'board' | 'full'` сейчас не используется.** Серверу не нужно различать — он всегда шлёт full sync. Frontend в режиме `'board'` мог бы игнорировать PGN. Оставляем зарезервированным, документируем «не влияет на trafиc на MVP».

11. **WS payload-размер.** Socket.IO по умолчанию `maxHttpBufferSize=1MB`. 256 KB укладываются. Поднимать лимит не нужно. Для уверенности — явно ставим `maxHttpBufferSize: 512_000` в gateway (запас вдвое над hard cap PGN), чтобы шумные клиенты не положили процесс.

12. **`perMessageDeflate` для сжатия.** Включить в gateway-options. Аннотированный PGN — текст с повторами хедеров/паттернов NAG/тегов, жмётся хорошо. Цена — CPU на сжатие, но при 5 эмитах/сек на инстанс это копейки.

13. **Метрика «сколько RAM держит in-memory PGN».** Хранение `currentPgn` в Redis — отдельный ключ на трансляцию, 256 KB × 100 активных = 25 MB. Не критично.

14. **Сериализация дерева в режиме автора.** `serializeToAnnotatedPgn` гоняется на каждом эмите. Для крупного дерева — миллисекунды. Дебаунс 500 мс перекрывает CPU-стоимость с большим запасом.

15. **Зритель видит «промежуточный» PGN.** Дебаунс 500 мс значит, что зритель видит изменения с задержкой ≤500 мс. Это нормально для комментариев/вариантов. Для самих ходов — `move` event без дебаунса даёт мгновенный отклик.

16. **Регрессия текущей `LiveAnalysisViewerPage`.** Превращение в обёртку = переписывание. QA-чеклист обязан включать сценарий «открыл live-ссылку анонимом, видишь доску, анимация хода, баннер закрытия» — то есть текущий MVP не сломан.

## 3. Последствия

- **Backend.** Расширение типов/событий в `packages/shared`, новый WS handler `state-patch`, новый метод сервиса, расширение state hash в Redis, новые метрики. Миграций БД нет.
- **Frontend.** Превращение `LiveAnalysisViewerPage` в обёртку над `AnalysisPage` с режимом `liveBroadcast`. Новый хук `useLiveAnalysisBroadcast`. Расширение `useAnalysisLiveBroadcast` у автора (эмит state-patch с дебаунсом). Badge «получено обновление» при локальной ветке зрителя. Перенос текущих локальных доска+anim+banner внутрь AnalysisPage liveBroadcast-режима.
- **Shared types.** Новый event и тип patch-payload, расширение `SyncSnapshot`.
- **DevOps.** Нет изменений. Тот же `api.kingside.site`, Redis, RDS.
- **QA.** Чеклист:
  - Зритель видит изменение комментария в течение 1с.
  - Изменение NAG доходит до зрителя.
  - Удаление варианта у автора → исчезновение у зрителя.
  - Стрелка `[%cal Re2e4]` отрисовывается на доске зрителя.
  - Изменение headers → GameMetaBar обновился.
  - Хард-кэп: автор пытается отправить PGN >256 KB → ошибка, у зрителя ничего не меняется.
  - Локальная ветка зрителя: state-patch пришёл → badge «Получено обновление» с применением по кнопке.
  - Реконнект зрителя: получает SYNC с актуальным PGN.
  - Закрытие трансляции: дерево анализа замораживается, доска read-only.
  - Smoke текущего MVP-сценария «только доска» не сломан.
- **Документация.** После релиза — обновить `docs/architecture/system-overview.md` (раздел про `/live-analysis`): упомянуть `state-patch` и поле `currentPgn`.

## 4. Предлагаемая разбивка на задачи (§9)

### Backend
- **KS-N01 [backend]** — `packages/shared`: добавить `LiveAnalysisEvents.STATE_PATCH`, тип `LiveAnalysisStatePatchEvent`, расширить `LiveAnalysisSyncSnapshot` (currentPgn, headers, title, ownerUsername), новый error code `'pgn-too-large'`.
- **KS-N02 [backend]** — `live-analysis.service.ts`: метод `applyStatePatch`, расширение `getSyncSnapshot`/`getBySlug` полями currentPgn/headers, синхронизация moves-list при patch, новый TokenBucketLimiter (5/сек, burst 10) для state-patch. Юнит-тесты: happy path, валидация PGN, hard cap, rate-limit, owner-check.
- **KS-N03 [backend]** — `live-analysis.gateway.ts`: handler `@SubscribeMessage('state-patch')`, DTO `StatePatchPayloadDto` с class-validator (включая `MaxLength(262144)`), error-mapping `pgn-too-large`. В gateway options — `perMessageDeflate: true`, `maxHttpBufferSize: 512000`. Юнит-тесты на forbidden/invalid/too-large.
- **KS-N04 [backend]** — метрики: `live_analysis_state_patches_total`, `live_analysis_state_patch_bytes_sum`, `live_analysis_state_patch_rejected_total` (labels: reason). Интеграция в applyStatePatch.

### Frontend
- **KS-N05 [frontend]** — клиент-события и хук `useLiveAnalysisBroadcast(slug, mode='viewer')`: подписка через `useLiveAnalysisSocket`, обработка SYNC/STATE_PATCH/MOVE/VIEWERS/CLOSED. Возврат `{snapshot, viewerCount, closedReason, hasPendingPatch, applyPendingPatch}`.
- **KS-N06 [frontend]** — `AnalysisPage`: новый проп `liveBroadcast?: { slug, mode }`. В режиме `viewer`:
  - Источник PGN из хука вместо REST (запрет fetch'а `/analyses/public/:id`).
  - Подавить owner-only действия (autosave, Share, Save, edit-title, кнопка «Транслировать», Set Position).
  - Применять PGN из sync/state-patch через `setHistory(parseAnnotatedPgn(...))`.
  - При локальной ветке зрителя — копить pendingPatch, показывать badge «Получено обновление».
- **KS-N07 [frontend]** — `LiveAnalysisViewerPage.tsx`: превратить в обёртку (early-fetch snapshot, рендер `<AnalysisPage liveBroadcast=...>`). Сохранить текущие сценарии noindex/notfound/closed.
- **KS-N08 [frontend]** — `useAnalysisLiveBroadcast` у автора: подписаться на изменения `history`, `annotations`, `nags`/`comments`/`variations`/`boardOrientation`/`pgnHeaders`. Debounce 500 мс per-slug, сериализация через `serializeToAnnotatedPgn`, emit `state-patch`. На совершённый ход — продолжаем мгновенно эмитить `move`.
- **KS-N09 [frontend]** — UI «получено обновление» (badge + кнопка) на стороне зрителя при локальной ветке. Сценарии: применить (затирает локальную ветку, swap PGN), скрыть (продолжает копить — оставляем поведение для KS-N06 на bdb solution).

### QA / документация
- **KS-N10 [qa]** — расширенный smoke по чеклисту из §3.
- **KS-N11 [architect]** — пост-релиз: обновить `docs/architecture/system-overview.md` (карточка `/live-analysis` упоминает `state-patch`, currentPgn, размер cap).

### Карта зависимостей
- N01 → N02 → N03 → N04 (backend chain, можно N04 параллельно с N03).
- N01 → N05 → (N06 + N07) → N08 → N09 (frontend chain).
- N02-3 / N05-7 можно вести параллельно после N01.
- N10 — после фронта.

## 5. Связь с соседними ADR

- **ADR-110** — расширение. Сохраняем все решения (модуль в `apps/api`, namespace `/live-analysis`, гибрид PG+Redis, slug nanoid(10), cleanup 30 мин). Этот ADR добавляет поверх ровно одно событие (`state-patch`), одно поле в snapshot (`currentPgn`/`headers`) и переиспользует `AnalysisPage` как UI зрителя вместо отдельного компонента.
- **ADR-051** (publishing анализов через `isPublic`) — параллельный канал. Зритель `/analysis/public/:id` видит застывший snapshot, зритель `/live/:slug` — живой поток. Если автор хочет «оставить разбор после трансляции» — отдельный follow-up (создать `Analysis` из текущего PGN при closing).
- **ADR-061 / ADR-072** (PgnSerializer / parseAnnotatedPgn) — переиспользуем без изменений. Формат `[%csl]`/`[%cal]`/`[%cvc]` — единый канон.
- **ADR-021** (broadcast-service) — Lichess broadcast'ы, отдельный домен, не пересекается.
