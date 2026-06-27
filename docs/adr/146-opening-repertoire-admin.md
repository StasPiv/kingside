# ADR-146: Модель данных и админ-API дебютных репертуаров (демо-набор)

**Статус:** Черновик на ревью координатором
**Дата:** 2026-06-27
**Задача:** KS-4675 (для реализации KS-4674)
**Связанные ADR / задачи:** ADR-128 §10 (`/opening-trainer/demo*`, KS-4162), ADR-139 (service-account auth, KS-4455), ADR-137 rev2 (BlogAdminController как образец), KS-3270/3325 (модель `OpeningRepertoire`/`OpeningRepertoireSource`).

## 1. Контекст

`OpeningRepertoire` уже хранит пользовательские репертуары: `userId NOT NULL`, `onDelete: Cascade`, дерево в JSONB, denormalised counters, soft-delete (`deletedAt`, 30-дн окно), боковые таблицы `OpeningRepertoireSource` и `OpeningLineProgress`.

Демо-репертуары для публичных `/opening-trainer/demo[/:id]` сейчас живут вне БД: PGN-файлы в `apps/api/src/opening-trainer/seeds/demo-repertoires/*.pgn` + опциональные `*.meta.json`. На `onModuleInit` `DemoRepertoireSeedService` строит in-memory registry через общий `RepertoireBuilderService.buildTree` и отдаёт ту же форму `OpeningRepertoireDetailDto`. В коде registry уже используется фиктивный owner `'00000000-0000-0000-0000-000000000000'` (NIL UUID), но в БД это никак не отражено.

KS-4674 хочет полноценный админский CRUD по образцу `BlogAdminController` (ADR-137 rev2 + ADR-139): JWT-админ ИЛИ service-account со scope. KS-4675 фиксирует 4 развилки до миграции.

## 2. Решения

### 2.1 Вопрос 1 — хранилище демо: **вариант (a) — расширение `OpeningRepertoire`**

Добавить в существующую таблицу:
- `slug String?` — стабильный человекочитаемый идентификатор демо-репертуара (URL `/opening-trainer/demo/<slug>` сохраняется, slug = имя PGN-файла без расширения).
- `isDemo Boolean @default(false)` — флаг «админский/публичный».
- `isPublished Boolean @default(false)` — для админских черновиков (как в блоге).

Уникальность slug — **partial unique index по миграции**, не Prisma `@@unique`:
```sql
CREATE UNIQUE INDEX opening_repertoires_demo_slug_uniq
  ON opening_repertoires (slug)
  WHERE is_demo = true;
```
Pure-Prisma `@@unique([slug])` не подходит (slug всегда NULL у пользовательских — нужен partial). В schema.prisma делается `@@index([slug])` + raw SQL миграция для UNIQUE с предикатом.

Также:
- `@@index([isDemo, isPublished, createdAt(sort: Desc)])` — для публичной выборки `/opening-trainer/demo` (`WHERE is_demo=true AND is_published=true ORDER BY created_at DESC`).
- Существующий `@@index([userId, createdAt(sort: Desc)])` остаётся; пользовательская лобби-выборка `WHERE user_id=$1 AND deleted_at IS NULL ORDER BY ...` не меняется (NULL `user_id` админских в эту выборку не попадёт автоматически — то, что нужно).

**Почему не (b) — отдельная таблица.** Дубль схемы (tree JSONB, denormalised counters, sources, lineProgress) → дубль сервисов, дубль parser-pipeline'а, дубль forms на админке. Текущий контракт `/demo/:id` уже сейчас один-в-один совпадает с личным `/repertoires/:id` (KS-4162) — это сигнал, что сущность одна, отличается только владелец/режим. Разные жизненные циклы решаются application-level (см. §2.5), без дробления БД.

### 2.2 Вопрос 2 — владелец демо: **вариант (i) — `userId nullable` + `onDelete: SetNull`**

В Prisma:
```prisma
userId String? @map("user_id") @db.Uuid
user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)
```
- Админский репертуар: `userId = NULL`, `isDemo = true`.
- Пользовательский: `userId = <uuid>`, `isDemo = false` (старые строки).
- `SetNull` для административных нерелевантен (у них и так нет user), но защитит, если ошибкой проставят `userId` у `isDemo=true` записи и user потом удалится.

**Почему не (ii) — служебный user с NIL UUID.** Текущая константа `DEMO_OWNER_ID = '00000000-...'` в `DemoRepertoireSeedService` — заглушка in-memory, не запись в `users`. Реальный «фантомный» user означает:
- запись в `User` с особым username/email, login которого нужно явно заблокировать;
- везде в коде проверять «это не служебный»: профиль не рендерить, FriendsList не показывать, rating не считать;
- ту же UNIQUE-проблему slug это не решает.

NULL — стандартный SQL-sentinel «без владельца», без побочных усилий. После миграции:
- `OpeningRepertoireDetailDto.ownerId` для админских **не отдаётся** (`undefined` / опускается из DTO). Поле остаётся опциональным в shared-типе.
- В `DemoRepertoireSeedService` (если останется как bootstrap, см. §2.3) NIL UUID уходит — пишем сразу `userId: null`.

### 2.3 Вопрос 3 — судьба `DemoRepertoireSeedService`: **убрать из runtime, оставить как одноразовый bootstrap-script**

- Из `OpeningTrainerModule.providers` сервис удаляется. `OpeningTrainerPublicController.GET /demo[*]` больше не зависит от файловой системы — читает из БД (`WHERE is_demo=true AND is_published=true`).
- Логика чтения PGN+meta переезжает в **standalone-script** `apps/api/src/scripts/seed-demo-repertoires.ts` (запускается через `nest start --entryFile scripts/seed-demo-repertoires` или прямой ts-node, по аналогии с другими scripts в `apps/api/src/scripts/`). Скрипт идёт по `seeds/demo-repertoires/*.pgn`, для каждого `upsert` по `(isDemo=true, slug=<file>)`, source `sourceKind='legacy-import'`.
- Скрипт выполняется один раз — для миграции существующего демо-контента в БД. После — админ правит контент через UI.
- PGN-файлы в репо **остаются** до явного решения убрать (git-история, возможность повторного импорта/отката). README в `seeds/demo-repertoires/` обновляется: «исторический snapshot до KS-4674; источник истины — БД».

**Почему не fallback на пустой БД.** Смешение источников (часть в БД, часть на диске) даёт рассинхрон при первой же admin-правке: админ обновил title через UI → в БД одна версия, на диске другая → на свежем dev-инстансе fallback подгрузит старую с диска. Для локальной разработки проще: `npm run seed:demo-repertoires` после `prisma migrate dev`.

### 2.4 Вопрос 4 — scope `repertoire:write`: **остаётся строкой + лёгкая централизация через TS-константный реестр**

Текущая архитектура (ADR-139) **уже допускает** добавление точечных scope'ов без централизованного whitelist'а: `ServiceAccountGuard` принимает любую строку из `account.scopes` (БД-поле), `@RequiredScope('blog:write')` сверяет точное совпадение или wildcard (`blog:*`, `*`). Никаких изменений в guards не нужно.

Что добавить, чтобы вырасти аккуратно: **константный реестр scope'ов в TS**, без runtime-валидации.
```ts
// apps/api/src/auth/scopes.ts
export const SCOPES = {
  BLOG_WRITE: 'blog:write',
  REPERTOIRE_WRITE: 'repertoire:write',
} as const;
export type ScopeString = (typeof SCOPES)[keyof typeof SCOPES];
```
Использование: `@RequiredScope(SCOPES.REPERTOIRE_WRITE)` вместо строкового литерала.

Что это даёт:
- опечатки `@RequiredScope('reportoire:write')` ловятся компилятором (TS);
- админ-CLI выдачи токена (T4 из ADR-139) и админ-UI получают единый источник списка scope'ов;
- runtime-проверка не меняется (строки + wildcards в БД остаются как есть — обратная совместимость с уже выданными токенами и с будущими scope'ами, ещё не попавшими в SCOPES);
- НЕ вводим жёсткий whitelist на guard: legacy/новые scope'ы по-прежнему работают без перевыкатки кода.

Это лёгкая централизация, не требующая ADR-139 rev2 — фиксируется в этом ADR как «соглашение по соседству» (рядом с `required-scope.decorator.ts`).

### 2.5 Жизненный цикл админских записей (как следствие из §2.1)

Поскольку соединяем в одной таблице, делаем явные application-level правила (NestJS-service-level, не БД-CHECK):

- **Soft-delete** действует только для `isDemo=false` (пользовательские). `OpeningRepertoireRepository.softDelete()` выбрасывает при `isDemo=true`.
- **Hard-delete** для `isDemo=true` — обычный `DELETE`, каскадит зависимые `OpeningRepertoireSource` (уже `onDelete: Cascade`), `OpeningTrainerSession`, `OpeningLineProgress` (все три FK уже Cascade).
- **Hard-delete** админского репертуара, у которого есть активные пользовательские сессии/прогресс — допустим (каскад). Альтернатива «запретить delete если есть сессии» избыточна: админ удаляет демо осознанно, потеря прогресса по удалённому контенту ожидаема.
- **Public-выборка** (`GET /opening-trainer/demo`): `WHERE is_demo=true AND is_published=true ORDER BY created_at DESC`.
- **Admin-list** (новый `GET /admin/opening-trainer/repertoires`): `WHERE is_demo=true ORDER BY updated_at DESC` (черновики тоже видны).
- **Личный лобби-список** (`GET /opening-trainer/repertoires`): `WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC` — **не меняется**.
- **Уникальность slug** среди `isDemo=true` гарантирована partial unique index'ом.

## 3. Что это значит для KS-4674 (backend)

Миграция:
1. `ALTER TABLE opening_repertoires`:
   - `ALTER COLUMN user_id DROP NOT NULL`,
   - `ADD COLUMN slug TEXT NULL`,
   - `ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT false`,
   - `ADD COLUMN is_published BOOLEAN NOT NULL DEFAULT false`.
2. FK `opening_repertoires_user_id_fkey` — пересоздать с `ON DELETE SET NULL` (вместо `CASCADE`). Пользовательские репертуары при удалении user'а теперь не удаляются, а становятся «осиротевшими» (`userId=NULL`, `isDemo=false`). **Уточнение:** если это нежелательно, можно оставить `ON DELETE CASCADE` (для админских FK не сработает — у них `userId=NULL`). Рекомендация: **оставить `CASCADE`** — текущее семантическое правило «удалил аккаунт → удалил его репертуары» сохраняется; `SET NULL` нужен только для «защиты от ошибки» и здесь не оправдан.
3. `CREATE UNIQUE INDEX opening_repertoires_demo_slug_uniq ON opening_repertoires (slug) WHERE is_demo = true`.
4. `CREATE INDEX opening_repertoires_demo_published_created_idx ON opening_repertoires (is_demo, is_published, created_at DESC) WHERE is_demo = true`.
5. Один-в-один CHECK: `CHECK ((is_demo = true AND user_id IS NULL) OR (is_demo = false AND user_id IS NOT NULL))` — гарантирует инвариант на уровне БД.

Код (порядок):
1. Prisma schema + миграция (см. выше).
2. Bootstrap-script `seed-demo-repertoires.ts`: переносит существующие PGN-файлы в БД с `isDemo=true`, `isPublished=true`, `userId=null`, `slug=<file>`. Запускается один раз (локально + на прод-релизе).
3. `DemoRepertoireSeedService` удалён из `OpeningTrainerModule.providers`. `OpeningTrainerPublicController.GET /demo*` переписан на чтение из БД.
4. Новый `OpeningTrainerAdminController` по образцу `BlogAdminController`: `AdminOrServiceGuard` + `@RequiredScope(SCOPES.REPERTOIRE_WRITE)` на mutating-эндпоинтах (POST/PUT/PATCH/DELETE).
5. `apps/api/src/auth/scopes.ts` — добавить `REPERTOIRE_WRITE`.
6. Service-account `agent-content` (или новый `agent-coach-admin`) получает scope `repertoire:write` через админ-CLI.

Уточнение по п.2 выше: рекомендация — **оставить FK `ON DELETE CASCADE`** для `user_id`. Партиальная NULL-семантика админских репертуаров не требует SetNull (у них и так `userId=NULL` — FK не сработает на delete user). Тогда §2.2 «(i) + SetNull» меняется на «(i) + Cascade оставить как есть»; смысл решения не меняется (nullable + NULL для админских).

## 4. Что НЕ в скоупе

- Sharing пользовательских репертуаров (`is_public` для не-демо) — отдельный тикет.
- Версионирование slug демо-репертуара (`slug-v2`) — пока не нужно, переименование slug закрывает.
- UI админ-страницы — отдельный frontend-тикет после backend'а.
- Перенос лекционного / уроки-аналог админ-CRUD на тот же паттерн — отдельно.
