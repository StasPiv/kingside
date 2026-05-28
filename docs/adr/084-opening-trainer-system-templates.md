# ADR-084. Opening Trainer — готовые (системные) дебютные репертуары

Статус: предложен (2026-05-28)
Связано: KS-3390 (этот ADR), ADR-077 (Opening Trainer, RepertoireTree),
ADR-078 (multi-source репертуары), ADR-072 (snapshot vs live-link).

## 1. Контекст

Сейчас источник тренировки дебюта — только пользовательский:
`sourceKind ∈ { pgn-upload, workshop-analysis, legacy-import }`
(`apps/api/src/opening-trainer/dto/repertoire.dto.ts`). Готовой базы
нет — пользователь сам приносит PGN. Запрос: платформа должна
отдавать **готовые** дебютные репертуары.

Текущая модель:
- `OpeningRepertoire.userId` — **NOT NULL** (всегда привязан к
  пользователю), `side` (white/black), `pgn`, `tree` (RepertoireTree).
- `OpeningRepertoireSource` (multi-source, ADR-078) — N источников
  на репертуар.
- `OpeningLineProgress(userId, repertoireId, pathHash)` — прогресс
  + SM-2.

## 2. Решение — каталог шаблонов + клонирование (не read-only системные)

### 2.1 Выбор подхода

Два варианта:

**A. Read-only системные репертуары** (общие, `userId=NULL`/`isSystem`).
Все тренируют одну запись. Минусы: нельзя дополнять своими линиями;
прогресс на общем репертуаре; миграция `userId` на nullable;
спец-логика «нельзя редактировать».

**B. Каталог шаблонов + клонирование** (выбран). Отдельная сущность
`OpeningTemplate`. Пользователь жмёт «Тренировать» → создаётся его
личный `OpeningRepertoire(userId=his)` с копией PGN/tree. Дальше он
полный владелец.

**Выбран B**, потому что:
1. Согласуется с существующей моделью — клон = обычный
   `OpeningRepertoire`, вся инфра (multi-source ADR-078, progress,
   SM-2, tree-view) работает БЕЗ изменений.
2. Пользователь дополняет готовый дебют своей подготовкой (ADR-078
   multi-source).
3. Прогресс чистый per-user, без composite-сложностей на общей
   записи.
4. Не трогаем `userId` NOT NULL.
5. Read-only-вариант потребовал бы спец-обработку «нельзя
   редактировать» + прогресс на общей записи + миграцию — больше
   edge-cases.

Минус клонирования (нет авто-обновления шаблона у клонов) — для
дебютной теории несущественен (теория стабильна). «Обновить из
шаблона» — опционально в M2. Паттерн snapshot уже принят в ADR-072.

### 2.2 Модель данных — `OpeningTemplate`

Новая таблица (НЕ флаг в `OpeningRepertoire` — чтобы не смешивать
каталог с пользовательскими записями и не плодить NULL userId):

```prisma
model OpeningTemplate {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slug        String   @unique          // 'sicilian-najdorf-black'
  title       String                    // «Сицилианская: Найдорф»
  description String?
  side        String                    // 'white' | 'black'
  eco         String?                   // 'B90' — для фильтра
  family      String                    // «Сицилианская» — группировка каталога
  level       String                    // 'beginner'|'intermediate'|'advanced'
  pgn         String   @db.Text         // источник истины для клонирования
  tree        Json                      // RepertoireTree (preview без re-parse)
  nodeCount   Int      @default(0)
  edgeCount   Int      @default(0)
  maxDepth    Int      @default(0)
  order       Int      @default(0)      // порядок в family
  isPublished Boolean  @default(false)  // draft до проверки chess-expert
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([family, order])
  @@index([side, level])
  @@map("opening_templates")
}
```

Расширение `OpeningRepertoireSource`:
- `sourceKind` whitelist += `'system-template'`.
- Новое поле `sourceTemplateId String? @db.Uuid` — трассировка
  «из какого шаблона клонировано» (для M2 «обновить из шаблона» и
  аналитики популярности).

### 2.3 Клонирование

`POST /opening-trainer/templates/:slug/clone`:
1. Создаёт `OpeningRepertoire(userId=me, title=template.title,
   side=template.side, pgn=template.pgn, tree=template.tree,
   nodeCount/edgeCount/maxDepth=template.*)`.
2. Создаёт `OpeningRepertoireSource(repertoireId=new,
   sourceKind='system-template', sourceTemplateId=template.id,
   name=template.title)`.
3. Возвращает созданный репертуар. Дальше — обычный пользовательский.

**Дубликат-защита:** не enforce'им unique. Если пользователь уже
клонировал — UI показывает «у вас есть копия → [Открыть]», но
повторный clone разрешён (свежая копия). Бэк не блокирует.

### 2.4 Каталог API

- `GET /opening-trainer/templates?side=&level=&family=` —
  каталог, метаданные БЕЗ tree (lightweight). `OptionalJwtGuard`
  (гость видит, клонировать не может). Группировка по family на
  фронте.
- `GET /opening-trainer/templates/:slug` — детали + tree (preview
  дерева перед клонированием).
- `POST /opening-trainer/templates/:slug/clone` — `JwtAuthGuard`,
  клонирование (см. §2.3). Если уже есть копия — в response
  `existingRepertoireId` (UI решает открыть/создать ещё).

### 2.5 UX

- На `/opening-trainer` (лобби) — таб/кнопка «Каталог готовых
  дебютов» рядом с «Мои репертуары» / «+ Загрузить PGN».
- `/opening-trainer/catalog` — каталог: группировка по family
  (Сицилианская / Испанская / …), фильтры side (♔/♚) + level.
- Карточка шаблона: title, ECO, side-бейдж, число линий, level,
  кнопка «Тренировать» (= clone + редирект на `/opening-trainer/:id`)
  или «Открыть мою копию» если уже клонирован.
- Опц. (M2) — preview дерева перед клонированием.

### 2.6 Что НЕ делаем

- НЕ делаем read-only общие репертуары (см. §2.1).
- НЕ копируем комментарии/компоновку из защищённых книг (§3).
- НЕ делаем авто-обновление клонов при изменении шаблона (M2).
- НЕ enforce'им unique-клон (UI-предупреждение достаточно).
- НЕ делаем рейтинг/лидерборды по шаблонам (M3).
- НЕ строим admin-UI для шаблонов в M1 — заливка через seed (§5).

## 3. Источник материала + лицензия

**Решение: курируем сами (chess-expert).**

Правовая основа:
- **Последовательность ходов** (1.e4 c5 2.Nf3 …) — это факты, НЕ
  объект авторского права. Сами линии свободно используемы.
- **Названия дебютов и ECO-коды** — общественное достояние
  (можно опираться на Lichess opening names, CC0).
- **Комментарии/аннотации** — пишем СВОИ (chess-expert). НЕ
  копируем тексты из книг (Modern Chess Openings и т.п.) — это
  нарушение copyright.
- **Подбор и компоновка** из существенной чужой БД (database right
  ЕС) — не берём; составляем репертуары самостоятельно.

Итог: chess-expert составляет PGN основных дебютов из своих знаний
+ общеизвестных линий, с авторскими комментариями. Полностью чисто
по лицензии, плюс контроль качества/методики. Названия/ECO — из
открытых источников.

## 4. Объём M1

Минимальный каталог за обе стороны, один «первый ход» белых для
связности:

**За белых (после 1.e4):**
1. Испанская партия (основная) — `ruy-lopez-white`.
2. Против Сицилианской (Открытый вариант) — `sicilian-open-white`.

**За чёрных:**
3. Сицилианская: Найдорф (против 1.e4) — `sicilian-najdorf-black`.
4. Каро-Канн (против 1.e4, альтернатива) — `caro-kann-black`.
5. Защита Нимцовича (против 1.d4) — `nimzo-indian-black`.

**M1 = 5 шаблонов** (2 за белых, 3 за чёрных). Каждый — основная
линия + 2-3 ключевых варианта, глубина ~12-16 полуходов, ~30-80
nodes. Цель — «дать готовое для старта», не полнота.

M2 — расширение до 20+, уровни сложности, больше вариантов;
балансировка first-move (добавить 1.d4-репертуар за белых).

## 5. Кто наполняет контент

- **chess-expert:** составляет/проверяет PGN каждого шаблона
  (выбор линий, методика, авторские комментарии, family/eco/level/
  slug). Источник истины — его PGN.
- **backend:** seed-инфраструктура — скрипт `prisma/seed` или
  отдельный `scripts/seed-opening-templates.ts`, парсит PGN→tree
  (`pgn-to-tree.service`) при заливке, пишет `opening_templates`.
- **content:** готовит финальные PGN-файлы по материалам
  chess-expert, запускает seed (или передаёт backend'у). Если
  появится admin-UI (M2) — заливка через него.

## 6. Влияние на ADR-077 / ADR-078

- ADR-077 (RepertoireTree) — шаблон использует тот же shape и
  парсер. Без изменений.
- ADR-078 (multi-source) — клон = обычный репертуар; multi-source
  применим (можно добавить свои PGN после клонирования). Новый
  `sourceKind='system-template'`.
- `OpeningLineProgress` — без изменений (клон = userId-репертуар).

Аддитивное расширение, существующее не ломает.

## 7. Риски

1. **Дублирование tree при клонах.** Каждый клон — копия (≤ 270 КБ).
   На тысячи пользователей — мегабайты. Приемлемо; tree уже
   хранится per-репертуар.
2. **Качество/методика шаблонов.** Зависит от chess-expert.
   Митигация: `isPublished=false` до проверки; QA-чек линий
   (валидность PGN, разумная глубина).
3. **Лицензия.** Снята кураторским подходом (§3) — только свои
   комментарии + факты-ходы + публичные названия.
4. **Расхождение клонов и шаблона** при обновлении шаблона.
   Принято (snapshot, ADR-072). M2 — «обновить из шаблона» через
   `sourceTemplateId`.
5. **side-консистентность.** Шаблон за чёрных → клон с `side=black`.
   Тренировка играет правильной стороной (KS-3302). Проверить при
   клонировании.
6. **Дубликат-клоны** засоряют «Мои репертуары». Митигация — UI
   «уже есть копия». Не блокируем.

## 8. Реализация — follow-up задачи

Зависимости: S1 → B1 → B2 → (C1 ∥ F1) → C2 → L1.

### KS-3391 (S1) — shared types для шаблонов

**Assignee:** backend (shared owner). **Labels:** `onboarding`, `puzzle`.
- `OpeningTemplateDto` (метаданные), `OpeningTemplateDetailDto`
  (+ tree), `OpeningTemplateCatalogResponse` (group by family),
  `CloneTemplateResponse` (`{ repertoire, alreadyExisted,
  existingRepertoireId? }`).
- `sourceKind` union += `'system-template'`; `sourceTemplateId?`
  в source-DTO.
- Acceptance: TS-сборка чистая; union narrowing.

### KS-3392 (B1) — миграция Prisma

**Assignee:** backend. **Labels:** `onboarding`, `puzzle`, `prisma`.
**Зависит:** KS-3391.
- Таблица `opening_templates` (§2.2). `OpeningRepertoireSource.
  sourceTemplateId String? @db.Uuid`. CHECK для sourceKind
  расширить значением `'system-template'`.
- Acceptance: `prisma:migrate` чистый; repository CRUD-тест.

### KS-3393 (B2) — endpoints каталога + seed-инфраструктура

**Assignee:** backend. **Labels:** `onboarding`, `puzzle`.
**Зависит:** KS-3392.
- `GET /templates`, `GET /templates/:slug`, `POST /templates/:slug/clone`.
- Clone: создание `OpeningRepertoire` + `OpeningRepertoireSource`
  (`system-template`), owner=me, side из шаблона. Возврат
  existing если уже клонировал.
- Seed-скрипт: PGN-файл → `pgn-to-tree` → INSERT template.
- Acceptance: каталог фильтруется по side/level/family; clone
  создаёт владельческую копию; повторный clone отдаёт existing;
  гость не клонирует (401).

### KS-3394 (C1) — подготовка PGN 5 шаблонов M1

**Assignee:** chess-expert. **Labels:** `onboarding`, `puzzle`.
- 5 шаблонов (§4): PGN с основной линией + 2-3 варианта, авторские
  комментарии, метаданные (slug/title/family/eco/level/side).
- Acceptance: PGN валиден (chess.js loadPgn), глубина 12-16
  полуходов, методически корректные линии, свои комментарии (не
  копипаст из книг).

### KS-3395 (C2) — заливка шаблонов

**Assignee:** content. **Labels:** `onboarding`, `puzzle`.
**Зависит:** KS-3393, KS-3394.
- Прогнать seed-скрипт (B2) с PGN от chess-expert. Проверить
  `isPublished=true` после валидации.
- Acceptance: 5 шаблонов в БД, видны в каталоге, клонируются.

### KS-3396 (F1) — страница каталога + клонирование

**Assignee:** frontend. **Labels:** `onboarding`, `puzzle`.
**Зависит:** KS-3391, KS-3393.
- `/opening-trainer/catalog` + таб/кнопка на `/opening-trainer`.
- Карточки (title, ECO, side-бейдж, level, число линий),
  группировка по family, фильтры side/level.
- «Тренировать» → clone → редирект на `/opening-trainer/:id`;
  «Открыть мою копию» если existing.
- Acceptance: каталог рендерится; clone работает; existing-флоу;
  гость видит каталог без clone.

### KS-3397 (L1) — CSS каталога + mobile

**Assignee:** layout. **Labels:** `onboarding`, `puzzle`, `mobile`.
**Зависит:** KS-3396.
- CSS карточек, group-секций по family, фильтр-чипов, side-бейджей.
- Mobile: карточки стеком, фильтры компактно.
- Acceptance: viewport 360×844 без горизонтального скролла; обе
  темы.

## 9. M2 (отложено)

- Расширение каталога (20+, баланс 1.d4 за белых).
- «Обновить из шаблона» (через `sourceTemplateId`).
- Admin-UI для шаблонов (вместо seed).
- Preview дерева перед клонированием.
- Уровни/теги, поиск по каталогу.
- Популярность шаблонов (аналитика по clone-count).

## 10. Откат

- Таблица `opening_templates` + endpoints — additive. Скрыть таб
  «Каталог» на фронте → фича невидима, данные остаются.
- Клоны — обычные `OpeningRepertoire`, переживают откат каталога
  (пользователь продолжает владеть копией).
- `sourceKind='system-template'` остаётся валидным значением.
