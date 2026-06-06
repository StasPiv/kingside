# ADR-112: Live-analysis — привязка трансляции к ID анализа, отказ от localStorage

**Статус:** Предложено
**Дата:** 2026-06-06
**Задача:** KS-3756
**Родительские ADR:** [ADR-110](./110-live-analysis-broadcast.md), [ADR-111](./111-live-analysis-full-broadcast.md)

## 1. Контекст

### Что сейчас (после ADR-110/111, KS-3736/KS-3749, KS-3754)

1. Активная трансляция автора хранится **на frontend** в `localStorage['live-analysis:active-slug']`. Формат после KS-3754 — JSON `{ slug, sessionInitialFen, sessionAnalysisId }`. На mount `useAnalysisLiveBroadcast` читает запись и при совпадении контекста (analysisId или initialFen — если analysisId нет) восстанавливает трансляцию.

2. **Проблема (ошибка KS-3754):** автор мог одновременно работать с несколькими анализами. Открыл анализ A — запустил трансляцию (slug записался в localStorage). Перешёл на анализ B — на mount хук подхватил тот же slug (matchmaking слабый — по initialFen), и emit-эффект `state-patch` начал отправлять **PGN анализа B по slug-у анализа A**. Зрители A видели чужой разбор.

3. KS-3754 закрыл худшее, но не корень проблемы: matchmaking по `(initialFen, analysisId)` всё ещё хрупкий (ложные совпадения на ad-hoc, гонки при reload, проблемы между вкладками браузера).

### Что должно быть (постановка от пользователя)

- Автор может одновременно вести несколько трансляций.
- Каждая трансляция привязана к конкретному анализу (своя уникальная ссылка `/live/<slug>`).
- Автор открывает страницу анализа — на ней видна та трансляция, что относится к этому анализу (если активна).
- Локального состояния трансляции на frontend быть не должно. Единственный источник истины — backend.

### Что НЕ в скоупе ADR-112

- Перенос/раздача трансляции между разными `analysisId` («продолжить на другом анализе»). Если автор переключился — это другая трансляция.
- Поддержка live-broadcast'а для `kind='review'` (game review) и `kind='puzzle'` (puzzle-from-URL). Они вне модели Analysis, см. §2.2.4.
- Полное переписывание клиентской state-машины — меняем точечно: убираем localStorage, переключаем источник восстановления на REST.

## 2. Решение

### 2.1 Идентификация анализа на frontend (§1 задачи)

`AnalysisContext` (см. `apps/web/src/pages/analysis/AnalysisContext.ts`) — discriminated union с тремя ветками:

| `kind` | Маршрут | Идентификатор | Стабильность |
| --- | --- | --- | --- |
| `'analysis'` | `/analysis/:id`, `/analysis/new`, `/analysis`, `/analysis/public/:id` | `analysisId` (UUID из `analyses.id`) или `localId` (frontend-сгенерированный UUID, до первого autosave). | UUID, persistent в БД после autosave. До autosave — только localId в URL. |
| `'review'` | `/games/:gameId` | `gameId` (UUID партии из `games.id` game-сервиса) | UUID, persistent. Не равно `analysisId`. |
| `'puzzle'` | `/analysis?fen=...&moves=...` | стабильного ID нет — только FEN + moves | Нестабильно: один и тот же FEN может прийти с разных страниц. |

**Ключ привязки трансляции — `analyses.id`** (UUID). Это единственный стабильный ID, который:
- уже существует в БД;
- защищён FK от dangling;
- доступен на странице автора;
- никогда не конфликтует между анализами.

**Что делаем с ad-hoc разбором без autosave.** В `AnalysisPage` есть `localIdRef` — frontend-сгенерированный UUID, который попадает в URL ещё до создания записи в БД. Этот ID **не годится** как ключ трансляции: backend о нём не знает. Решение: **перед стартом трансляции форсируем autosave** (POST `/analyses`), получаем настоящий `analysisId`, дальше уже зовём `POST /live-analyses` с ним. Это даёт инвариант: **у каждой записи `live_analyses` всегда есть валидный `analysisId`**, и обратная совместимость никому не нужна.

**Что делаем с `kind='review'`.** Game review (`/games/:gameId`) не имеет `analysisId`. Если автор хочет транслировать — пусть сначала сохранит как Analysis (на странице уже есть пункт «Сохранить в мастерскую» / создание Analysis из game review). Это покрывает основной use-case без удвоения сложности модели (отдельная колонка `sourceGameId` не появляется). Кнопка «Транслировать» на game review без сохранения — disabled с подсказкой «Сначала сохраните в мастерскую».

**Что делаем с `kind='puzzle'`.** Аналогично — кнопка disabled. Puzzle-from-URL это режим тренировки, трансляция не нужна (а если очень нужна — пользователь жмёт «Сохранить как анализ» и оттуда стартует).

### 2.2 Привязка LiveAnalysis к analysisId (§2 задачи)

**Prisma-миграция.** Расширяем модель `LiveAnalysis` в `packages/db/prisma/schema.prisma:2109`:

```prisma
model LiveAnalysis {
  id             String             @id @default(uuid()) @db.Uuid
  slug           String             @unique
  ownerId        String             @map("owner_id") @db.Uuid
  owner          User               @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  /// KS-3756 / ADR-112. Привязка к Analysis. NOT NULL для новых записей.
  /// ON DELETE SET NULL: при удалении анализа запись трансляции переживает
  /// (история «у автора такой стрим был»), но осиротевшая запись больше
  /// не показывается на странице (по GET /by-analysis/:id).
  analysisId     String?            @map("analysis_id") @db.Uuid
  analysis       Analysis?          @relation(fields: [analysisId], references: [id], onDelete: SetNull)

  title          String?
  startingFen    String?            @map("starting_fen")
  status         LiveAnalysisStatus @default(active)
  createdAt      DateTime           @default(now()) @map("created_at")
  closedAt       DateTime?          @map("closed_at")
  lastActivityAt DateTime           @default(now()) @map("last_activity_at")
  viewerPeak     Int                @default(0) @map("viewer_peak")

  @@index([ownerId, status])
  @@index([status, lastActivityAt])
  /// KS-3756. На каждого автора — максимум одна активная трансляция
  /// на конкретный анализ. Повторный POST с тем же analysisId возвращает
  /// existing. Partial index — purposely включает только active и
  /// проверяемые записи (NULL не участвует).
  @@unique([ownerId, analysisId], name: "live_analysis_owner_analysis_active_unique", map: "live_analysis_owner_analysis_active_unique")
  @@map("live_analyses")
}
```

**Тонкость с partial unique index.** Prisma `@@unique` на уровне модели делает full unique. Нам нужен **частичный** UNIQUE — только для `status='active' AND analysis_id IS NOT NULL`, иначе:
- две закрытые трансляции одного автора на один анализ упрутся в конфликт (ложноположительный);
- активные ad-hoc-трансляции (если такие останутся легитимными — см. §2.1) с `analysis_id=NULL` упрутся друг в друга.

Решение: **создаём partial unique index через raw SQL в Prisma миграции** (Prisma его в схеме не выражает, но миграцию можно дописать руками — пример уже есть в проекте, см. `analyses.source_hash` partial unique). Тело:

```sql
CREATE UNIQUE INDEX "live_analysis_owner_analysis_active_unique"
  ON "live_analyses" ("owner_id", "analysis_id")
  WHERE "status" = 'active' AND "analysis_id" IS NOT NULL;
```

После этого `@@unique` из Prisma-схемы убираем (он лишний; partial index делает работу). Документируем в комментарии.

**Почему FK с `onDelete: SetNull`, а не `Cascade`.** Удалил автор анализ → не хотим терять историю «трансляция случилась». Запись `live_analyses` остаётся (status=closed после очередного cleanup-тика или сразу при удалении — см. §2.6), `analysis_id` обнуляется. На странице — больше не показывается (`GET /by-analysis/:id` её не найдёт).

### 2.3 REST-контракт (§3 задачи)

**Все изменения локализованы в `apps/api/src/live-analysis/`.**

1. **`POST /live-analyses`** (JwtAuthGuard, как сейчас):
   - `CreateLiveAnalysisDto` расширяется обязательным `analysisId: string` (UUID, `@IsUUID()`).
   - В сервисе:
     - проверяем `Analysis` существует и `userId === ownerId` (403 при чужом, 404 при несуществующем);
     - если уже есть `live_analyses { ownerId, analysisId, status: 'active' }` — **возвращаем существующую** (200, не 201). Идемпотентность. Альтернатива «409 Conflict» хуже UX: автор перешёл со страницы на страницу, на старой висит трансляция, нажал «Транслировать» снова — нет смысла его пугать конфликтом, мы и так знаем что у него уже есть активная;
     - иначе INSERT с `analysisId`, Redis init как сейчас.
   - Возврат — `LiveAnalysisResponse` с полем `analysisId` (новое поле).

2. **`GET /live-analyses/by-analysis/:analysisId`** (новый, JwtAuthGuard, owner-only):
   - Ищем `live_analyses { ownerId: req.user.id, analysisId: param, status: 'active' }`.
   - Найдено → возвращаем `LiveAnalysisResponse` (как `GET /:slug`, плюс `analysisId`).
   - Не найдено → 404 (фронт интерпретирует как «трансляции нет»).
   - **Не делаем `?analysisId=` query на `/me`**. Отдельный endpoint понятнее и легче кешируется в будущем. Минусы — лишний роут, но он короткий и self-explanatory.

3. **`GET /live-analyses/me`** (как сейчас, JwtAuthGuard):
   - `LiveAnalysisListItem` расширяется полем `analysisId: string | null`.
   - Сортировка как сейчас: active сверху, потом closed по createdAt desc.

4. **`GET /live-analyses/:slug`** (анонимный, как сейчас):
   - `LiveAnalysisResponse.analysisId` — добавляется в ответ. Зрителю это поле не критично, но не вредит (анонимы видят только uuid, не связь с анализом).

5. **`DELETE /live-analyses/:slug`** — без изменений.

### 2.4 Frontend модель (§4 задачи)

**Полностью убираем localStorage.**

Удаляются:
- `LIVE_SLUG_STORAGE_KEY`, `readPersistedSession`, `writePersistedSession`, `PersistedSession` в `apps/web/src/hooks/useAnalysisLiveBroadcast.ts`.
- Restore-эффект, `restoredSilently` state, `first-user-action` listener.

Заменяется на:

1. **Restore через REST.** При mount `useAnalysisLiveBroadcast` с заданным `analysisId`:
   ```
   GET /live-analyses/by-analysis/:analysisId
   ```
   - 200 → ставим slug в state, подписываемся.
   - 404 → idle.
   - 401 → пользователь разлогинился, idle.
   - 5xx/network → idle с показом тоста «не удалось проверить активную трансляцию» (опционально, чтобы автор знал, что reload может помочь).

2. **`analysisId` — обязательный аргумент хука.** Если `analysisId=null` (ad-hoc без autosave, kind='review', kind='puzzle') — хук в idle, `start()` бросает ошибку «save analysis first» (на UI кнопка disabled с тултипом).

3. **`start()` теперь:**
   ```ts
   start(): Promise<LiveAnalysisResponse | null>
   ```
   - проверяет `analysisId` и `userId`;
   - `POST /live-analyses { analysisId, startingFen, orientation, title }`;
   - устанавливает slug. **Никакого `writePersistedSession`.**

4. **`stop()`:** `WS close` + чистка локального state. **Никакого `writePersistedSession(null)`.**

5. **При смене страницы** (unmount AnalysisPage / переход на другой URL):
   - Хук размонтируется, его state теряется. Подписка на сокет закрывается. Backend продолжает считать трансляцию активной, она остаётся для других зрителей и для автора, если он вернётся.
   - На новой странице — mount нового экземпляра хука с новым `analysisId`. Делается GET `/by-analysis/:analysisId` для нового анализа.

6. **«Сначала сохрани, потом транслируй» — UX-флоу для ad-hoc.**
   В `LiveBroadcastControl` (компонент с кнопкой «Транслировать»):
   - `analysisId === null && kind === 'analysis'` → кнопка enabled, при клике сначала вызывает `handleSaveAdHoc()` (существующий механизм createAnalysis), ждёт `analysisId`, потом `start(analysisId)`. На UI показывается состояние «Сохранение…» затем «Запуск трансляции…».
   - `kind === 'review' || kind === 'puzzle'` → кнопка disabled, тултип «Сохраните в мастерскую, чтобы транслировать».

7. **Bootstrap-cleanup.** В точке входа приложения (`apps/web/src/main.tsx` или `App.tsx`) одной строкой удаляем легаси-ключ:
   ```ts
   try { window.localStorage.removeItem('live-analysis:active-slug'); } catch {}
   ```
   Это разовая миграция. Удаляется через 2-3 релиза (когда у всех существующих пользователей точно отработал bootstrap).

### 2.5 Сценарии (§5 задачи)

| Сценарий | Поведение |
| --- | --- |
| Автор открывает анализ A, в БД для A нет active live | `GET /by-analysis/A → 404` → idle. Кнопка «Транслировать» enabled. |
| Автор открывает анализ A, в БД для A active live | `GET /by-analysis/A → 200` → slug установлен, подписка на WS, индикатор «В эфире · X зрителей». |
| Автор открывает анализ A, запустил, перешёл на B, в БД для B активной нет | На A — индикатор погас (страница размонтирована), но backend держит active. На B — обычный idle. Можно запустить вторую трансляцию (B получит новый slug, отдельный от A). |
| Возвращается на A | `GET /by-analysis/A → 200` → slug A снова поднимается, индикатор «В эфире». |
| На B нажал «Транслировать», затем на A снова нажал «Транслировать» | На B — POST с analysisId=B, новый slug. На A — POST с analysisId=A. Backend partial unique даёт каждому ровно одну active. Если на A уже была — POST возвращает existing. Никаких коллизий. |
| Закрытие вкладки на A | Backend трансляцию НЕ закрывает (нет сигнала). Через 30 мин неактивности cleanup-job закроет (как сейчас, ADR-110 §3 / KS-3733). Зрители на A эти 30 мин видят последнюю позицию, потом получают `closed { reason: 'inactivity' }`. |
| Reload вкладки на A с активной трансляцией | Хук на mount делает `GET /by-analysis/A` → 200, восстанавливает slug. Никакого localStorage не нужно. |
| Ad-hoc анализ без autosave, автор жмёт «Транслировать» | UI выполняет POST `/analyses` (autosave), получает `analysisId`, POST `/live-analyses` с этим id. Транслирование стартует. |
| Game review, автор жмёт «Транслировать» | Кнопка disabled, тултип «Сохраните в мастерскую, чтобы транслировать». Если автор сохраняет — становится analysisId, кнопка enabled. |

### 2.6 Миграция (§6 задачи)

1. **Существующие активные трансляции на проде.** В новой колонке `analysis_id` они получат NULL. Они «висят» как сироты:
   - `GET /by-analysis/:id` их не найдёт (нет связи).
   - На странице «мои live-трансляции» в профиле они отображаются с пометкой «без привязки» (или фильтруются).
   - Cleanup-job закроет их через 30 мин неактивности.
   - **Дополнительный data-migration шаг (опционально):** одноразовый UPDATE в той же миграции:
     ```sql
     UPDATE live_analyses
     SET status = 'closed', closed_at = NOW()
     WHERE status = 'active' AND analysis_id IS NULL;
     ```
     Это сразу освободит зрителей от зомби-трансляций, оставшихся после KS-3754. **Рекомендация: запустить.** На проде сейчас (KS-3754) уязвимость свежая — без чистки часть автора-пользователей может остаться «в эфире» на чужом slug.

2. **localStorage cleanup.** Однострочный bootstrap (см. §2.4 п.7) удаляет ключ у всех. Через 2-3 релиза строка убирается (или оставляется навсегда — затраты на неё нулевые).

3. **Никаких новых migration-failure сценариев.** Колонка nullable + partial UNIQUE индекс (создаётся CONCURRENTLY если на большой таблице, но `live_analyses` редко перешагнёт тысячи строк — обычный CREATE INDEX подойдёт). Откат миграции тривиален (drop column).

### 2.7 Что меняется в существующем коде

| Файл | Что | Кто |
| --- | --- | --- |
| `packages/db/prisma/schema.prisma` (model `LiveAnalysis`, model `Analysis`) | Поле `analysisId`, FK, обратная связь `liveAnalyses LiveAnalysis[]` в Analysis. | backend |
| `packages/db/prisma/migrations/<...>_live_analysis_analysis_id` | Миграция: ADD COLUMN + CREATE PARTIAL UNIQUE INDEX + data cleanup. | backend |
| `packages/shared/src/types/api-contracts.ts` | `CreateLiveAnalysisDto.analysisId`, `LiveAnalysisResponse.analysisId`, `LiveAnalysisListItem.analysisId`. | backend |
| `apps/api/src/live-analysis/dto/create-live-analysis.dto.ts` | `@IsUUID() analysisId`. | backend |
| `apps/api/src/live-analysis/live-analysis.service.ts` | В `create()` — проверка владельца Analysis, idempotency по `(ownerId, analysisId, status='active')`. Новый метод `findActiveByAnalysisId(ownerId, analysisId)`. Расширение `toResponse` / `listForOwner` полем analysisId. | backend |
| `apps/api/src/live-analysis/live-analysis.controller.ts` | Новый `@Get('by-analysis/:analysisId')` (JwtAuthGuard, owner-only). | backend |
| `apps/api/src/live-analysis/live-analysis.service.spec.ts`, `controller.spec.ts` | Покрытие новых веток. | backend |
| `apps/web/src/hooks/useAnalysisLiveBroadcast.ts` | Удаление localStorage-логики; restore через `GET /by-analysis/:analysisId`; `analysisId` обязательный для start. | frontend |
| `apps/web/src/components/analysis/LiveBroadcastControl.tsx` | Disabled-флоу для review/puzzle; «Сохранить и транслировать» для ad-hoc. | frontend |
| `apps/web/src/pages/AnalysisPage.tsx` | Передача `analysisId` в хук (вместо текущей пары `initialFen`/`analysisId`). | frontend |
| `apps/web/src/main.tsx` (или `App.tsx`) | Bootstrap removeItem старого ключа. | frontend |
| Тесты `useAnalysisLiveBroadcast.test.tsx`, `LiveBroadcastControl.test.tsx`, e2e | Покрытие сценариев из §2.5. | frontend |

### 2.8 Риски и подводные камни

1. **Гонка «autosave → POST /live-analyses» для ad-hoc.** Autosave может задержаться (debounced, 1-2с). Если автор кликнул «Транслировать», но autosave в это время не успел — POST `/analyses` идёт явно, не дожидаясь debounce. Тривиально, уже умеем (там же есть «Сохранить сейчас» для других пунктов меню).

2. **`onDelete: SetNull` + UNIQUE по `analysisId`.** Когда analysisId становится NULL, partial unique его не задевает (where включает `analysis_id IS NOT NULL`). Безопасно.

3. **Concurrent POST с одного клиента.** Два таба автора одновременно отправили POST по одному analysisId. Один выиграет (вставит запись), другой получит partial-unique violation — Prisma P2002. Сервис ловит и **возвращает existing active** (см. §2.3 п.1, идемпотентность). Никаких 500.

4. **Что если автор уже имел активную трансляцию (analysis_id=NULL после миграции) и пришёл на новый POST с тем же analysis_id, что соответствует другому Analysis?** После data-cleanup из §2.6 п.1 таких случаев не будет — все NULL-active закрыты. Если cleanup не запустили — старая NULL-active живёт параллельно с новой по analysisId, не мешает (partial UNIQUE их не связывает).

5. **`GET /by-analysis/:analysisId` без авторизации.** Это **owner-only** endpoint. Зачем зрителю смотреть «какой live относится к анализу X»? Незачем; если когда-нибудь понадобится — сделаем отдельный публичный `GET /live-analyses/by-analysis/public/:analysisId` (без auth, читает только `analyses.isPublic=true`). Сейчас не нужно.

6. **Game review / puzzle disabled-кнопка.** Без явного объяснения «почему disabled» автор не поймёт. Тултип обязателен. Без него UX-регрессия.

7. **`localStorage`-cleanup в bootstrap.** Если bootstrap не успел сработать (например, юзер открыл вкладку из закладок и cleanup закомментировали по ошибке) — старый ключ продолжит жить, но **никто его не читает** (хук уже его не трогает). Безвредно.

8. **Sync moves-list при состыковке `state-patch` после restore через REST.** При restore хук получает slug и идёт на WS `subscribe`. Сервер отдаёт `sync` с актуальным PGN и moves — `applyLivePgn` в AnalysisPage уже умеет применить (KS-3750/KS-3751). Никаких изменений в WS-протоколе.

9. **Bug-by-design: «индикатор пропадает на чужой странице».** Хук на странице B не видит трансляцию A — это by design. Если автор хочет «знать что у меня в эфире — есть» в любой момент — это уже другая задача (badge в шапке профиля «У вас N активных трансляций»), вне scope.

10. **PartialIndex и Prisma reset.** При `prisma migrate reset` / fresh dev-окружении нужно прогнать миграцию с raw-SQL. Документируем в файле миграции, что raw SQL — необходимая часть, не забыть скопировать его в seed-data если кто-то накатывает по-другому.

11. **Telemetry на старте.** В метриках `live_analysis_created_total` (KS-N02 KS-3732) — добавить метку `with_analysis_id=true|false`. После миграции и релиза `false` должна быть 0. Если не 0 — где-то в коде сервиса allow-list пропустил проверку. Это soft-guard на регрессии.

## 3. Последствия

- **Backend.** Prisma миграция (новая колонка + partial unique index + data cleanup), расширение DTO/типов, новый endpoint `GET /by-analysis/:analysisId`, idempotency в `create()`. Никаких изменений WS-протокола (sync/move/state-patch остаются как в ADR-111).
- **Frontend.** Удаление localStorage-логики из `useAnalysisLiveBroadcast` (включая `restoredSilently` и first-user-action механизм KS-3754). REST-restore через новый endpoint. UX-флоу «Сохранить и транслировать» для ad-hoc. Disabled-кнопка для review/puzzle. Однострочный bootstrap-cleanup.
- **Shared types.** Поле `analysisId` в трёх типах (Create DTO, Response, ListItem). Поле в Create DTO — **обязательное** (breaking change для несуществующих внешних клиентов; для нас — только наш фронт, рискa интеграции нет).
- **DevOps.** Никаких изменений в инфраструктуре.
- **QA.** Чеклист:
  - Два анализа A и B, обе активны — на каждой видна своя.
  - Без активной — обычная страница.
  - Reload восстанавливает по REST, localStorage отсутствует.
  - Concurrent POST по одному analysisId возвращает один и тот же slug.
  - Чужой analysisId → 403.
  - Удаление Analysis у активной трансляции → запись остаётся, analysis_id=NULL.
  - Migration data-cleanup: все active с analysis_id=NULL закрыты после деплоя.
  - Game review / puzzle — кнопка disabled с тултипом.
- **Документация.** После релиза — обновить `docs/architecture/system-overview.md` (карточка `/live-analysis`): упомянуть привязку к `analysisId`, `GET /by-analysis/:analysisId`, partial unique index, отсутствие localStorage у клиента.

## 4. Предлагаемая разбивка на задачи (§7)

### Backend
- **KS-N01 [backend]** — Prisma миграция:
  - ADD COLUMN `analysis_id Uuid?` + FK `Analysis(id) ON DELETE SET NULL`;
  - CREATE PARTIAL UNIQUE INDEX `live_analysis_owner_analysis_active_unique` (см. §2.2);
  - data cleanup: UPDATE active с analysis_id=NULL → closed (см. §2.6 п.1).
  - prisma generate.
- **KS-N02 [backend]** — shared types: `CreateLiveAnalysisDto.analysisId` (обязательное), `LiveAnalysisResponse.analysisId`, `LiveAnalysisListItem.analysisId`.
- **KS-N03 [backend]** — `live-analysis.service.ts`:
  - `create()`: валидация ownership Analysis (404/403), idempotency на P2002 / на существующий active по `(ownerId, analysisId)`;
  - новый `findActiveByAnalysisId(ownerId, analysisId): Promise<LiveAnalysisResponse | null>`;
  - расширение `toResponse` / `listForOwner` полем `analysisId`;
  - удаление `slugToOwnerCache`-trick если он завязывался на старую модель (проверить, не сломал ли idempotency).
- **KS-N04 [backend]** — `live-analysis.controller.ts`: новый `@Get('by-analysis/:analysisId')` (JwtAuthGuard, ParseUUIDPipe, owner-only). Обязательная проверка `analysisId` — UUID.
- **KS-N05 [backend]** — DTO `create-live-analysis.dto.ts`: `@IsUUID() analysisId: string`. Сервис-spec + controller-spec.
- **KS-N06 [backend]** — метрика `live_analysis_created_total{with_analysis_id=true|false}` — guard на регрессии. Метрика `live_analysis_zombie_closed_at_migration_total` (один раз отдаётся миграцией).

### Frontend
- **KS-N07 [frontend]** — shared types подтянуть, типы в API-клиенте.
- **KS-N08 [frontend]** — `useAnalysisLiveBroadcast`: полностью удалить localStorage-логику (LIVE_SLUG_STORAGE_KEY, readPersistedSession, writePersistedSession, PersistedSession, restoredSilently, first-user-action listener). Restore-эффект: при mount если `analysisId` есть — `GET /live-analyses/by-analysis/:analysisId`, на 200 ставим slug, на 404 idle. `start(analysisId)` обязательный. Юнит-тесты.
- **KS-N09 [frontend]** — `LiveBroadcastControl`: kind-aware UI:
  - `kind='analysis' && analysisId` → enabled, normal flow;
  - `kind='analysis' && !analysisId` → enabled, при клике autosave → ждём analysisId → start;
  - `kind='review' || kind='puzzle'` → disabled + тултип.
- **KS-N10 [frontend]** — `AnalysisPage` интеграция: передаёт `analysisId` в `useAnalysisLiveBroadcast`. Удаление прокидывания `initialFen` через ту же логику (initialFen остаётся для `start()` payload, но не для restore-матчинга).
- **KS-N11 [frontend]** — bootstrap-cleanup: `localStorage.removeItem('live-analysis:active-slug')` в точке входа. Однострочно, можно отдельным маленьким PR.
- **KS-N12 [frontend]** — e2e/integration на сценарии из §2.5: A↔B switch, reload, disabled на review/puzzle, ad-hoc «сохранить и транслировать».

### QA / документация
- **KS-N13 [qa]** — расширенный smoke по чеклисту из §3.
- **KS-N14 [architect]** — пост-релиз: обновить `docs/architecture/system-overview.md` (карточка `/live-analysis`): упомянуть `analysisId`, `GET /by-analysis/:analysisId`, partial unique index, отсутствие localStorage.

### Карта зависимостей
- KS-N01 (миграция) → KS-N02-N06 (backend chain).
- KS-N02 (shared) → KS-N07 → KS-N08 → KS-N09/N10 → KS-N11 → KS-N12 (frontend chain).
- KS-N03/N04 и KS-N07/N08 — параллельно после N01+N02.
- KS-N13 после деплоя обеих веток. KS-N14 — финальный.

## 5. Связь с соседними ADR

- **ADR-110** — базовая модель live-broadcast (slug/Redis/state machine). Этот ADR добавляет привязку к `analysisId` и убирает localStorage; ничего в state machine не ломает.
- **ADR-111** — расширение протокола (`state-patch`, currentPgn). Этот ADR ортогонален: WS-протокол не трогается, меняется только связка «какая страница к какому slug-у относится».
- **ADR-051** (`isPublic` для Analysis) — параллельная семантика «поделиться анализом». Не пересекается: live-трансляция использует `analysisId` как ключ привязки, не флаг публичности.
- **KS-3754** (текущий фикс) — закрывал worst case через matchmaking-эвристики в localStorage. Этот ADR делает фикс корневым (источник истины — backend), эвристики удаляются.
