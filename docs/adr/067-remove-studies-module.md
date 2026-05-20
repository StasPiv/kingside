# ADR-067 — Удаление модуля Studies. Интерактивные уроки переезжают в Lessons

- Статус: Accepted
- Дата: 2026-05-20
- Связанные задачи: KS-3127 (этот audit/план), запрос пользователя 2026-05-20
  (Web), KS-2856 (Studies Phase 2 — отменяется в части дальнейшего развития).
- Связанные ADR: **Supersedes** ADR-059 (Studies module — MVP) и
  ADR-060 (Studies Phase 2 — full parity). Затрагивает ADR-021/022
  (broadcast-service — снимаем интеграцию-зеркало) и ADR-062
  (assistant features catalog — убираем записи studies/gamebook-reader).
- Авторы: architect

---

## 1. Контекст и решение

### 1.1 Запрос

Пользователь (Web, 2026-05-20):

> сейчас будет большая задача — нам нужно отказаться от функционала
> «Студия». К сожалению, этот функционал работает не так как ожидалось,
> соответственно нам нужно этот раздел убрать и убрать все хвосты по
> коду связанные с этим разделом. Основной функционал интерактивных
> уроков у нас будет в разделе «Уроки».

### 1.2 Решение

Модуль Studies удаляется целиком: backend (REST + DB), frontend
(страницы, компоненты, маршруты, API-клиент, стили, переводы),
shared-типы и feature-catalog-записи, broadcast→study mirror, ссылки
из профиля и каталога-лобби. Интерактивные уроки остаются в модуле
`lessons` (apps/api/src/lessons + apps/web/src/pages/Lesson*) — он и
есть будущий «дом» учебного контента.

Лишние фичи Studies, отсутствующие в Lessons (gamebook reader/editor,
practice-режим с валидацией хода, conceal-режим, мульти-PGN импорт по
главам, broadcast-зеркало, лайки, инвайты/контрибьюторы) **не
переносятся** в Lessons этим тикетом — фиксируются как потеря
функционала, решения о переносе принимает пользователь отдельно.

### 1.3 Что НЕ удаляется

- Модуль `lessons` — остаётся как есть.
- `AnalysisPage` сам по себе. Из него уже убрана интеграция со
  Studies (KS-3014: `kind='study'` удалён из `AnalysisContext`); в
  файлах остались только комментарии-следы, которые надо доскрести.
- Broadcast-модуль и broadcast-service — остаются. Удаляются только
  поля `BroadcastRound.mirrorToStudy` / `mirroredStudySlug`, индекс
  `broadcast_rounds_mirror_to_study_idx` и относящийся код в
  `apps/broadcast-service/src/sync/`.
- ADR-059 и ADR-060 как файлы — остаются для истории, помечаются
  `Status: Superseded by ADR-067`.

### 1.4 Прод-данные

Пользователь подтвердил (комментарий к KS-3127, 2026-05-20): на проде
нет пользовательских студий, препрод-окружения тоже нет. Дамп/бэкап
перед drop таблиц не требуется. Миграция просто DROP TABLE.

---

## 2. Inventory

### 2.1 Backend (`apps/api`) — удаление целиком

```
apps/api/src/study/                                    # весь каталог
├── broadcast/
│   ├── broadcast-service.client.ts
│   ├── from-broadcast-round.spec.ts
│   ├── study-broadcast-mirror.controller.ts
│   ├── study-broadcast-mirror.service.spec.ts
│   ├── study-broadcast-mirror.service.ts
│   └── sync-broadcast-round.spec.ts
├── dto/
│   ├── gamebook.dto.spec.ts
│   ├── gamebook.dto.ts
│   ├── study.dto.spec.ts
│   └── study.dto.ts
├── catalog.spec.ts
├── from-analysis.spec.ts
├── liked-by-me.spec.ts
├── optional-jwt-auth.guard.ts
├── study-access.guard.ts
├── study-by-user.controller.ts
├── study-catalog.controller.ts
├── study-chapters.service.spec.ts
├── study-chapters.service.ts
├── study-contributor.guard.ts
├── study-guards.spec.ts
├── study-invites.service.spec.ts
├── study-invites.service.ts
├── study-lifecycle.spec.ts
├── study-likes.service.spec.ts
├── study-likes.service.ts
├── study-limits.ts
├── study-members.controller.spec.ts
├── study-members.controller.ts
├── study-members.service.spec.ts
├── study-members.service.ts
├── study-owner.guard.ts
├── study-permissions.spec.ts
├── study-public.controller.spec.ts
├── study-public.controller.ts
├── study-slug.service.ts
├── study-visibility.util.ts
├── study.controller.spec.ts
├── study.controller.ts
├── study.module.ts
├── study.service.spec.ts
├── study.service.ts
└── viewer-role.spec.ts
```

### 2.2 Backend (`apps/api`) — точечные правки

| Файл | Правка |
|---|---|
| `apps/api/src/app.module.ts` | Удалить `import { StudyModule } from './study/study.module'` (строка 39) и строки 103-105 (комментарий + регистрация). |
| `apps/api/src/feature-flags/feature-flags.service.ts` | Удалить ключ `studiesEnabled` в `KNOWN_FEATURE_FLAGS` (строка 41) и в `FEATURE_FLAG_METADATA` (строки 77-80). |
| `apps/api/src/feature-flags/feature-flags.service.spec.ts` | Убрать assertions со `studiesEnabled`. |
| `apps/api/src/feature-flags/admin-feature-flags.controller.spec.ts` | То же. |
| `apps/api/src/ai-chat/system-prompt.spec.ts` | Удалить блоки с `studiesEnabled: true/false` и assertion `expect(ids).toContain('studies')` (строки 48, 58, 125). |

**REST-эндпоинты, исчезающие вместе с модулем** (`/api/...`):

```
GET    /studies?mine=0|1
POST   /studies
GET    /studies/:slug
PATCH  /studies/:slug
DELETE /studies/:slug
POST   /studies/:slug/chapters
GET    /studies/:slug/chapters/:chapterId
PATCH  /studies/:slug/chapters/:chapterId
DELETE /studies/:slug/chapters/:chapterId
PATCH  /studies/:slug/chapters/:chapterId/order
POST   /studies/:slug/import-pgn
GET    /studies/:slug/export.pgn
GET    /studies/:slug/chapters/:chapterId/export.pgn
GET    /studies/public
GET    /studies/public/c/:chapterId
GET    /studies/catalog
GET    /studies/by/:userId
POST   /studies/:slug/like
GET    /studies/:slug/members
POST   /studies/:slug/members
DELETE /studies/:slug/members/:userId
POST   /studies/:slug/invite-link
GET    /studies/invites/:token
POST   /studies/invites/:token/accept
POST   /studies/from-analysis
POST   /studies/from-broadcast-round       (internal-auth)
POST   /studies/sync-broadcast-round       (internal-auth)
```

**Упоминания в комментариях (трогать не обязательно, опционально по желанию исполнителя)**:

- `apps/api/src/lessons/dto/pgn-normalize.ts` — упоминание «lichess studies» в комментарии (строка 10);
- `apps/api/src/puzzle/daily-puzzle.service.ts` — «endgame studies» в комментарии (строка 51);
- `apps/api/src/mcp/class-validator-to-jsonschema.ts` — «StudyA → StudyA[]» в примере (строка 88).

Это не зависимости, текстовые ссылки на внешнее понятие шахматных
этюдов / Lichess. Удаления требуют только если уберут с zero-effort.

### 2.3 Prisma — `packages/db/prisma/schema.prisma`

**Модели к удалению** (целиком):

- `Study` (строки 1449-1518) — таблица `studies`.
- `StudyChapter` (строки 1520-1575) — таблица `study_chapters`.
- `StudyMember` (строки 1577-1599) — таблица `study_members`.
- `StudyLike` (строки 1601-1615) — таблица `study_likes`.
- `StudyInvite` (строки 1617-1641) — таблица `study_invites`.

**Relations в `User`** (строки 113-122):

- `ownedStudies Study[] @relation("OwnedStudies")` — удалить.
- `studyMemberships StudyMember[]` — удалить.
- `studyLikes StudyLike[]` — удалить.
- `studyInvitesCreated StudyInvite[] @relation("StudyInvitesCreated")` — удалить.

**Миграции уже применённых изменений в БД** (новые миграции должны
их откатить через DROP TABLE / DROP INDEX, сами файлы старых миграций
не удаляем):

```
packages/db/prisma/migrations/20260512090000_ks2817_studies_init/
packages/db/prisma/migrations/20260512110000_ks2857_studies_phase2_extend/
packages/db/prisma/migrations/20260512111500_ks2859_study_invites/
packages/db/prisma/migrations/20260513170000_ks2884_study_chapter_from_ref/
```

**Новая миграция** (тикет B2):

```sql
DROP TABLE IF EXISTS study_invites;
DROP TABLE IF EXISTS study_likes;
DROP TABLE IF EXISTS study_members;
DROP TABLE IF EXISTS study_chapters;
DROP TABLE IF EXISTS studies;
```

Cascade onDelete у FK на `users.id` снимется автоматически вместе с
таблицами — отдельный шаг не нужен.

### 2.4 Prisma — `packages/broadcasts-db/prisma/schema.prisma`

**Модель `BroadcastRound`** (строки 81-102) — удалить:

- поле `mirrorToStudy Boolean @default(false) @map("mirror_to_study")`;
- поле `mirroredStudySlug String? @map("mirrored_study_slug")`;
- индекс `@@index([mirrorToStudy], map: "broadcast_rounds_mirror_to_study_idx")`.

**Старая миграция** (не удаляем):

```
packages/broadcasts-db/prisma/migrations/20260513173000_ks2883_round_mirror_to_study/
```

**Новая миграция** (тикет B2):

```sql
DROP INDEX IF EXISTS broadcast_rounds_mirror_to_study_idx;
ALTER TABLE broadcast_rounds DROP COLUMN IF EXISTS mirrored_study_slug;
ALTER TABLE broadcast_rounds DROP COLUMN IF EXISTS mirror_to_study;
```

### 2.5 Broadcast-service (`apps/broadcast-service`) — точечные правки

| Файл | Правка |
|---|---|
| `apps/broadcast-service/src/sync/broadcast-sync.service.ts` | Удалить блок с `if (upserted.mirrorToStudy && !upserted.mirroredStudySlug)` и связанные ветки create/sync (строки 1073-1095). Удалить блок `if (round.mirrorToStudy && round.mirroredStudySlug)` (строки 1627-1630). |
| `apps/broadcast-service/src/sync/kingside-api.client.ts` | Удалить методы `fromBroadcastRound`, `syncBroadcastRound`, типы `FromBroadcastRoundResponse`, `SyncBroadcastRoundResponse`. |
| `apps/broadcast-service/src/sync/kingside-api.client.spec.ts` | Удалить describe-блоки тестов этих методов. |
| `apps/broadcast-service/src/sync/broadcast-internal.controller.ts` | Удалить упоминания в docstring заголовка. |

### 2.6 Frontend (`apps/web`) — удаление целиком

**Страницы:**

```
apps/web/src/pages/StudiesPage.tsx
apps/web/src/pages/StudiesPage.test.tsx
apps/web/src/pages/StudyPage.tsx
apps/web/src/pages/StudyPage.test.tsx
apps/web/src/pages/UserStudiesPage.tsx
apps/web/src/pages/UserStudiesPage.test.tsx
apps/web/src/pages/StudyInviteAcceptPage.tsx
apps/web/src/pages/StudyInviteAcceptPage.test.tsx
```

**Компоненты:**

```
apps/web/src/components/studies/                       # весь каталог
├── ChapterList.tsx
├── ChapterList.test.tsx
├── CreateChapterDialog.tsx
├── CreateStudyDialog.tsx
├── CreateStudyDialog.test.tsx
├── ImportPgnDialog.tsx
├── ImportPgnDialog.test.tsx
├── LikeButton.tsx
├── LikeButton.test.tsx
├── StudyCatalogCard.tsx
├── StudyCatalogCard.test.tsx
├── StudyMembersDialog.tsx
└── StudyMembersDialog.test.tsx
```

**API-клиент:**

```
apps/web/src/api/studiesApi.ts
apps/web/src/api/studiesApi.test.ts
```

**Стили:**

```
apps/web/src/styles/studies.css                        # 2172 строки, весь файл
```

### 2.7 Frontend — точечные правки

| Файл | Правка |
|---|---|
| `apps/web/src/App.tsx` | Удалить lazy-импорты `StudiesPage`/`StudyPage`/`UserStudiesPage`/`StudyInviteAcceptPage` (строки 121-145) и 4 `<Route>` на `/studies*` (строки 388-430). Комментарии «KS-2825/2826/2889/2893» уйдут вместе с блоками. |
| `apps/web/src/styles.css` | Удалить `@import './styles/studies.css';` (строка 25). |
| `apps/web/src/styles/workshop.css` | Удалить блоки `.analysis-page[data-analysis-context='study']` (строки 986-1015). |
| `apps/web/src/styles/responsive.css` | Удалить блок mobile-study (строки 272-291): `.analysis-page--study .analysis-breadcrumbs`, `.analysis-breadcrumbs__right-slot`, `.analysis-study-mode-switcher`. |
| `apps/web/src/components/Sidebar.tsx` | Удалить пункт навигации `/studies` (строки 187-199) и связанный комментарий. |
| `apps/web/src/components/Sidebar.test.tsx` | Удалить блок тестов «dev/prod + studiesEnabled / /studies/<id>» (строки 590-630) и `flagControls.studies` (строки 28, 38, 50, 99). |
| `apps/web/src/context/FeatureFlagsContext.tsx` | Удалить ключ `studiesEnabled` из `DEFAULT_FLAGS` (строки 74-78). |
| `apps/web/src/App.featureFlag.test.tsx` | Удалить `studiesEnabled: false` (строки 443, 467). |
| `apps/web/src/hooks/useNavStats.test.ts` | Удалить `studiesEnabled: false` (строки 42-43). |
| `apps/web/src/pages/PlayerProfilePage.tsx` | Удалить блок ссылки «Studies» в профиль (строки 267-272). Перевод `playerProfile.studies` тоже убрать. |
| `apps/web/src/pages/AnalysisPage.tsx` | Подчистить комментарии-следы (строки 65-67, 669, 1374, 1684) — там уже нет логики, только текст про study. |
| `apps/web/src/pages/analysis/AnalysisHeader.tsx` | Подчистить комментарии-следы про `AnalysisStudyModeSwitcher` (строки 53-58, 144-146). Сам `rightSlot` оставить — это generic-проп, study был одним из use-case. |
| `apps/web/src/pages/analysis/AnalysisSidebar.tsx` | Подчистить комментарий-след про gamebook-editor (строки 337-339). |
| `apps/web/src/pages/analysis/AnalysisContext.ts` | Подчистить комментарии о `kind='study'` (строки 17, 36, 65). |
| `apps/web/src/pages/analysis/AnalysisContext.test.ts` | Подчистить комментарий о `kind='study'` (строка 176). |
| `apps/web/src/i18n/locales/en/translation.json` | Удалить блок `"studies": {...}` (строки 25-138) — это весь корневой namespace со ~110 ключами. Удалить ключ `"nav.studies"` (строка 235) и `"playerProfile.studies"`. |
| `apps/web/src/i18n/locales/ru/translation.json` | Зеркально — блок `"studies": {...}` (строки 25-…), `"nav.studies"` (строка 243), `"playerProfile.studies"`. |

### 2.8 Shared (`packages/shared`)

**Удалить целиком:**

```
packages/shared/src/types/studies.ts
packages/shared/src/features-catalog/studies.ts
packages/shared/src/features-catalog/gamebook-reader.ts
```

**Точечные правки:**

| Файл | Правка |
|---|---|
| `packages/shared/src/index.ts` | Удалить `export * from './types/studies.js';` (строка 13). |
| `packages/shared/src/types/feature-flags.ts` | Удалить поле `studiesEnabled` из интерфейса `FeatureFlags` (строки 61-67). |
| `packages/shared/src/features-catalog/index.ts` | Удалить импорт `studies` (строка 28), запись в catalog (строка 59), а также `gamebook-reader` если он там подключён. |
| `packages/shared/src/features-catalog/analyze-lobby.ts` | В описании заменить «aggregates analysis-oriented sections (analysis board, workshop, studies, archive)» → без «studies» (строка 8). |

Артефакты сборки `packages/shared/dist/*` пересобираются автоматически
`npm run build` — руками не трогаем.

### 2.9 Документация

**Помечаются `Status: Superseded by ADR-067`, не удаляются:**

- `docs/adr/059-studies-module.md`
- `docs/adr/060-studies-phase-2-full-parity.md`

**Остаются как историческое research-чтиво (не правим):**

- `docs/architecture/KS-2792-studies-research.md`
- `docs/architecture/KS-2815-studies-standalone.md`
- `docs/architecture/KS-3126-study-chapter-page.md`

**Удаляются как неактуальные:**

- `docs/qa/studies-acceptance.feature` (Gherkin acceptance для
  Studies — фича уходит, тесты не нужны).

### 2.10 Feature-flags — сводка

Единственный флаг, относящийся только к Studies:

- `studiesEnabled` — удаляется из:
  - whitelist `apps/api/src/feature-flags/feature-flags.service.ts`;
  - типа `FeatureFlags` в `packages/shared/src/types/feature-flags.ts`;
  - `DEFAULT_FLAGS` в `apps/web/src/context/FeatureFlagsContext.tsx`;
  - всех spec-файлов выше.

После удаления одна запись `feature_flags.studiesEnabled` останется в
БД, она будет проигнорирована (whitelist в bootstrap'е). Опциональный
SQL `DELETE FROM feature_flags WHERE key='studiesEnabled';` можно
включить в миграцию B2 для чистоты.

---

## 3. Зависимости и порядок работ

### 3.1 Жёсткие зависимости

1. **B1 (backend code) запускает за собой B3 (frontend code)** — после
   удаления REST-роутов фронтовые экраны не смогут грузиться, поэтому
   к моменту мерджа B1 в main фронтовый код должен быть либо удалён,
   либо хотя бы под `Navigate to="/"` (см. §3.2).
2. **B2 (Prisma migration) должна идти ПОСЛЕ B1** — снос модуля
   удаляет код, который читал таблицы; миграция дропает таблицы.
   Обратный порядок (миграция первая) даст 500 на любом обращении к
   API между деплоями.
3. **B2 безопасно идёт параллельно с B3** — фронт уже не делает
   запросов к удалённым роутам.
4. **A1 (этот ADR-апдейт + superseded-метки)** — независим от
   остальных, но логически делается первым (фиксация плана).

### 3.2 Рекомендованный порядок

```
A1 (architect)        ──► merge сразу
                          │
B1 (backend code)     ──┼─► merge
B3 (frontend code)    ──┘
                          │
B2 (prisma migration) ──► merge после деплоя B1
                          │
B4 (deploy api)       ──► devops запускает migrate deploy
```

Возможна полная одновременность B1 + B3 в одном PR/коммите (мы в
main без feature-веток): сначала фронт перестаёт показывать `/studies`
(404/redirect), затем backend сносит роуты, затем миграция дропает
таблицы. На time-window между деплоями API и миграцией оставшиеся
запросы к `/studies/*` отдадут 404 (роут не зарегистрирован), а не
500 — это приемлемо.

### 3.3 Параллельная работа

- B1 и B3 — независимы по файлам, могут идти параллельно у backend
  и frontend агентов соответственно.
- B2 — отдельный backend-тикет, не блокирует B3, но идёт после B1.
- A1 (этот документ) — уже выполнен в этом коммите.

---

## 4. Тикеты

| Ключ | Кто | Summary | Содержание |
|---|---|---|---|
| **A1** | architect | ADR-067 + superseded-метки | Этот документ; правка шапок ADR-059/060 → `Status: Superseded by ADR-067`. **Выполнено этим коммитом.** |
| **B1** | backend | Удалить модуль Studies (код, регистрация, feature-flag) | `apps/api/src/study/**` целиком; `apps/api/src/app.module.ts` (импорт + `StudyModule`); ключ `studiesEnabled` в `feature-flags.service.ts` + `FEATURE_FLAG_METADATA` + тесты feature-flags; тесты `ai-chat/system-prompt.spec.ts`; зачистить `apps/broadcast-service/src/sync/{broadcast-sync.service.ts,kingside-api.client.ts,kingside-api.client.spec.ts,broadcast-internal.controller.ts}` от mirror-логики. Удалить `docs/qa/studies-acceptance.feature`. |
| **B2** | backend | Prisma migration: drop Studies + broadcast mirror | Новые миграции в `packages/db/prisma/migrations/` (DROP TABLE 5 студийных таблиц + удаление relations из `User`) и в `packages/broadcasts-db/prisma/migrations/` (DROP колонок `mirror_to_study`/`mirrored_study_slug` + DROP индекса). Опционально `DELETE FROM feature_flags WHERE key='studiesEnabled';`. Удаление полей из обоих `schema.prisma`. Прогон `prisma generate`. |
| **F1** | frontend | Удалить страницы/компоненты/маршруты/API-клиент/стили/переводы Studies | `apps/web/src/pages/Stud*`, `apps/web/src/components/studies/**`, `apps/web/src/api/studiesApi.{ts,test.ts}`, `apps/web/src/styles/studies.css`, импорт в `styles.css`. Маршруты и lazy-импорты в `App.tsx`. Пункт Sidebar + тесты. Флаг `studiesEnabled` в `FeatureFlagsContext` + `App.featureFlag.test.tsx` + `useNavStats.test.ts`. Блоки `studies.*`, `nav.studies`, `playerProfile.studies` в обоих `translation.json`. Блоки `data-analysis-context='study'` в `workshop.css` и `.analysis-page--study` в `responsive.css`. |
| **F2** | frontend | Убрать интеграцию Studies из AnalysisPage / PlayerProfile | Подчистить комментарии-следы про `kind='study'` / `study-route` в `AnalysisPage.tsx`, `analysis/AnalysisHeader.tsx`, `analysis/AnalysisSidebar.tsx`, `analysis/AnalysisContext.ts`, `analysis/AnalysisContext.test.ts`. В `PlayerProfilePage.tsx` удалить ссылку «Studies» (строки 267-272). |
| **S1** | backend | Удалить Studies из packages/shared | `packages/shared/src/types/studies.ts`, `features-catalog/studies.ts`, `features-catalog/gamebook-reader.ts`; правки в `src/index.ts`, `types/feature-flags.ts`, `features-catalog/index.ts`, `features-catalog/analyze-lobby.ts`. Прогон `npm run build` в `packages/shared`. По ownership: shared делает backend (на нём же висит B1/B2). |
| **D1** | devops | Деплой api + миграция БД | После мерджа B1/B2: `deploy({scope:'api'})`, затем `prisma migrate deploy` на prod-БД (KS-приложение) и broadcasts-БД. На препроде проверка не нужна — препрод-окружения нет. |

**Жёстко:**

- A1 готов, тикеты создавать после ревью пользователем.
- D1 запускается только после успешного мерджа B1+B2+F1+F2+S1.
- B1, F1, F2 могут лететь параллельно одной партией; S1 и B2 — в той
  же партии.

---

## 5. Риски и потеря функционала

### 5.1 Потеря фич (нет аналога в Lessons)

| Фича Studies | Состояние в Lessons | Комментарий |
|---|---|---|
| Многоглавный контейнер с UI каталога | Курсы есть, но интерфейс другой; «студия» как user-owned PGN-сборник без курсовой структуры исчезает. | Lessons-курсы — это структурированный учебный материал (с прогрессом SM-2). Свободные «коллекции анализа» отсутствуют. |
| **Gamebook reader/editor** (interactive PGN с подсказками/успех/неудача) | Нет. | Полная потеря. Самая близкая фича в Lessons — «interactive lesson step», но контракт другой и без переноса данных не сработает. |
| **Practice mode** (validate user's move = main line) | Нет. | Потеря. |
| **Conceal mode** (hide moves after ply N) | Нет. | Потеря. |
| Multi-PGN import (одним блобом N глав) | Есть импорт PGN в Lessons (через editor), но не одним вставленным мега-блобом. | Частичная потеря удобства. |
| Public catalog studies (community share) | Есть Discover Courses, но это система курсов. Свободного user-share PGN-коллекций нет. | Потеря community-share для PGN. |
| Likes / topics / sort=popular | Нет. | Потеря. |
| **Invites + contributors** (совместное редактирование) | Нет. | Полная потеря. В Lessons author=ownerId, без многопользовательского редактирования. |
| **Broadcast → study mirror** (auto-зеркало раунда) | Нет. | Потеря. После удаления админ-флаг `mirror_to_study` тоже исчезает; раунды останутся доступны только в основном broadcast-разделе. |
| Save-to-study из AnalysisPage | Нет аналога Save-to-lesson. | Потеря short-cut'а. AnalysisPage сохраняет в analyses-таблицу — отдельное место. |

Перечисленные потери **зафиксированы и не переносятся в Lessons этим
тикетом**. Решение о выборочном переносе — отдельное обсуждение.

### 5.2 Эксплуатационные риски удаления

- **Internal-эндпоинты `POST /api/studies/from-broadcast-round` и
  `/sync-broadcast-round`** дёргаются из broadcast-service. После
  мерджа B1 эти роуты исчезнут; B1 ОБЯЗАТЕЛЬНО включает в себя
  зачистку клиента в broadcast-service. Если зачистку забыть —
  broadcast-service на каждом round-update будет логать ошибки
  POST→404 (не падать, но мусорить в логи).
- **На прод-БД нет данных** (подтверждено пользователем). Это
  убирает риск accidental data-loss и снимает необходимость в
  отдельном dump-тикете.
- **Feature-flag row `studiesEnabled` останется в `feature_flags`
  до явного DELETE.** Опционально включить в B2-миграцию `DELETE
  FROM feature_flags WHERE key='studiesEnabled'` — bootstrap про
  unknown ключ ничего не делает, так что строка просто будет лежать
  и игнорироваться.
- **Старые миграции `20260512090000_..._studies_init`,
  `20260512110000_..._studies_phase2_extend`,
  `20260512111500_..._study_invites`,
  `20260513170000_..._study_chapter_from_ref`,
  `20260513173000_..._round_mirror_to_study` не удаляем** — Prisma
  ведёт миграции append-only через `_prisma_migrations` таблицу.
  Новая drop-миграция дополнит, а не заместит.
- **JS-чанки в dev-кэше у пользователей**, у кого `/studies` была
  открыта в момент деплоя, могут попытаться сделать запрос на
  удалённый роут. Получат 404, фронт уйдёт в общий `*` → `Navigate
  to="/"` (последняя строка `<Routes>`). Это приемлемо.

### 5.3 Метрики использования

Метрик по проду нет (пользователь не давал — фичу пользователи не
успели полноценно поиспользовать). Отдельной задачи на сбор метрик
перед удалением не нужно.

---

## 6. Acceptance ADR-067

- [x] Этот документ создан.
- [x] ADR-059 шапка отмечена `Status: Superseded by ADR-067`.
- [x] ADR-060 шапка отмечена `Status: Superseded by ADR-067`.
- [ ] Тикеты B1, B2, F1, F2, S1, D1 заведены координатором по списку
  выше (координатор делает по этому ADR; architect код не правит).
