# ADR-078. Opening Trainer — мульти-источник PGN в одном репертуаре

Статус: предложен (2026-05-25)
Расширяет: ADR-077 (Opening Trainer)
Связано: KS-3323 (этот ADR), KS-3293 (конверсия `POST .../from-analysis`),
KS-M2-B8 (orphan-pruning при `PATCH pgn`).

## 1. Контекст

В ADR-077 один `OpeningRepertoire` = один PGN-строка. На практике
пользователю не хватает: он накапливает дебютную теорию из разных
источников (книги, свои анализы из мастерской, миниатюры из
broadcast'ов) и хочет собрать всё в **один** репертуар, без
ручного склеивания PGN'ов в большую простыню.

Текущее состояние кода:

- `OpeningRepertoire.pgn: String` (`packages/db/prisma/schema.prisma:~1552`).
- `RepertoireBuilderService.buildTree(pgn: string)` —
  `apps/api/src/opening-trainer/repertoire-builder.service.ts:336`.
  Tokenizer + рекурсивный обход вариантов, **транспозиции схлопываются
  по FEN внутри одного PGN** — это уже почти то поведение, которое мы
  хотим распространить на несколько PGN.
- Текущий tokenizer не разделяет multi-game PGN (несколько партий
  в одном файле): после `1-0` chess-instance не сбрасывается, и
  следующий `1.e4` применяется к финальной позиции предыдущей партии.
  Это **существующий баг**, который этот ADR заодно лечит через
  явный split.
- `OpeningLineProgress` ещё не реализован (это M2 / KS-M2-B1); в нём
  заложен механизм `orphaned`-флага для линий, исчезнувших из дерева
  (KS-M2-B8). Этот механизм одинаково работает и для добавления, и
  для удаления источников — нам не нужно изобретать новое.
- `POST /opening-trainer/repertoires/from-analysis` (KS-3293) уже даёт
  один способ «добавить PGN» — но он каждый раз создаёт новый
  репертуар.

## 2. Решение

### 2.1 Источники как отдельная сущность `OpeningRepertoireSource`

Заводим новую таблицу `opening_repertoire_sources`. Один репертуар →
N источников (1..`maxSourcesPerRepertoire`). Каждый источник хранит
свой PGN, опциональное имя (UI-подпись), `sourceKind`
(`'pgn-upload' | 'workshop-analysis' | 'legacy-import'`) и опц.
`sourceAnalysisId` для случая конверсии из мастерской.

```prisma
model OpeningRepertoireSource {
  id               String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  repertoireId     String   @map("repertoire_id") @db.Uuid
  order            Int      @default(0)                    // стабильный sort
  name             String?                                  // UI-имя или NULL → fallback на [Event] / "PGN N"
  pgn              String   @db.Text                        // исходный PGN этого источника
  sourceKind       String   @map("source_kind")             // 'pgn-upload' | 'workshop-analysis' | 'legacy-import'
  sourceAnalysisId String?  @map("source_analysis_id") @db.Uuid
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  repertoire OpeningRepertoire @relation(fields: [repertoireId], references: [id], onDelete: Cascade)

  @@index([repertoireId, order])
  @@map("opening_repertoire_sources")
}
```

В `OpeningRepertoire`:

- Добавляем relation `sources OpeningRepertoireSource[]`.
- Поле `pgn` оставляем как **denormalized cache** = `sources.map(s
  => s.pgn).join('\n\n')`. Это:
  - сохраняет backward-compat для `OpeningRepertoireDetailDto.pgn` и
    существующих потребителей export'а;
  - убирает необходимость JOIN при чтении детальной страницы;
  - пересчитывается синхронно при любом изменении `sources`.

Альтернатива — сделать `pgn` nullable и убрать из DTO. Отвергнуто:
требует обновления тестов, фронта, и нет ощутимой выгоды (этот
denorm безопасен — сервис единственный writer).

### 2.2 Миграция существующих репертуаров

Atomic-миграция в одном transaction'е:

1. Создать таблицу `opening_repertoire_sources`.
2. Для каждого существующего `opening_repertoires` ROW:
   - INSERT в `opening_repertoire_sources` один source с
     `pgn = repertoire.pgn`, `order = 0`, `name = NULL`,
     `sourceKind = 'legacy-import'`.
   - Перестроить tree через builder с новым `sourceId` (см. §2.3) —
     edges получают `sourceIds = [legacyId]`. Это нужно, иначе после
     первого editing операции потеряем привязку.
3. Поле `OpeningRepertoire.pgn` НЕ меняется (оно уже = concat одного
   источника).

Шаг 2.b — самая дорогая часть миграции (rebuild всех деревьев). При
текущем счёте репертуаров (несколько десятков на dev/staging, нет
prod-нагрузки) — это секунды, не часы. Если на prod-data будут
тысячи репертуаров — отдельный data-migration job через CLI.

### 2.3 Builder: PGN-массив → единое дерево + `sourceIds` на edges

`RepertoireBuilderService.buildTree` расширяется:

```ts
interface BuilderSource { sourceId: string; pgn: string; }

class RepertoireBuilderService {
  buildTree(sources: BuilderSource[]): RepertoireTree
  // (старая сигнатура `buildTree(pgn: string)` остаётся wrapper'ом
  //  для тестов: вызывает `buildTree([{ sourceId: '_', pgn }])`.)
}
```

Алгоритм:

1. Утилита `splitPgnIntoGames(pgn): string[]` — разрезает PGN-строку
   на отдельные партии по `[Event "..."]`-маркерам (или, если их нет,
   по результатам `1-0 / 0-1 / 1/2-1/2 / *` с пустой строкой после).
   Это **отдельно лечит существующий multi-game baг**.
2. Для каждого `source` из `sources`:
   - Расширяем `source.pgn` через `splitPgnIntoGames` → `games[]`.
   - Для каждой `game`:
     - Сбрасываем `chess` instance на root FEN.
     - Обходим toks как сейчас (tokenize + parseTokens).
     - При создании/нахождении edge:
       - Если edge новый — `edge.sourceIds = [source.sourceId]`.
       - Если edge уже существует (транспозиция/повтор) — пушим
         `source.sourceId` в `edge.sourceIds` (через Set,
         дедупликация).
     - NAG'и: union массивов (а не «first wins» как сейчас) —
       если два источника отметили `?` и `!?`, оба сохраняются.
     - Comment: keep-first (предсказуемо, без слипания строк).
3. Финальная sanity-проверка: `meta.edgeCount > 0`.

Поле `sourceIds` добавляется в `RepertoireEdge` (shared). Это
**breaking change для JSONB-tree**, но мы делаем единоразовый
rebuild в миграции — после неё все деревья содержат поле.

### 2.4 Транспозиции и «конфликты»

Транспозиция по позиции (одна и та же FEN, достигнутая через
разные ходы) — уже работает (FEN-keyed nodes). Multi-source не
меняет: nodes продолжают схлопываться.

Транспозиция по ходу (один и тот же UCI из одного FEN'а, пришёл из
двух источников) — это **не конфликт**, это успешная транспозиция.
Edge один, `sourceIds` содержит оба ID.

Конкурирующие варианты (в одной позиции одна сторона имеет
разные ходы) — это **не конфликт**, это нормальные варианты.
Несколько edges, бот выбирает random-without-repeat среди всех
(ADR-077 §2.3).

«Истинный конфликт» (один источник опровергает другой) — не
техническая проблема, а методическая. Пользователь сам решает,
оставить ли оба варианта или удалить «плохой» источник.

### 2.5 UX

#### Создание репертуара

`OpeningTrainerNewPage`:

- Поле `title` + опц. `description` — как сейчас.
- Секция «Источники» с динамическим списком блоков. Каждый блок:
  - Опц. `name` (короткое имя для UI; если пусто — fallback).
  - Textarea с PGN.
  - Кнопка «Удалить блок» (если блоков > 1).
- Кнопка «+ Ещё PGN» добавляет блок (до `maxSourcesPerRepertoire`).
- Submit отправляет `POST /opening-trainer/repertoires` с body
  `{ title, description?, sources: [{ pgn, name? }, ...] }`.

Backward-compat: backend принимает и старое body `{ pgn }` (создаёт
репертуар с одним source).

#### Страница репертуара

`OpeningTrainerRepertoirePage`:

- Новая секция «Источники» (между header и кнопками режимов
  тренировки):
  - Список карточек источников: `name`, иконка `sourceKind`
    (📄 pgn-upload / 🧪 workshop / 📦 legacy), количество ходов
    в source'е (derived: edge count в tree, помеченные этим
    sourceId), дата добавления.
  - Per-карточка actions: «✏ Редактировать» (PATCH), «🗑 Удалить»
    (DELETE). При удалении — confirm («Удалить N линий, из них
    M уникальных потеряются»), если последний источник —
    запрет (нужен хотя бы один).
- Кнопка «+ Добавить PGN» открывает модалку (textarea + опц. name),
  Submit → `POST /repertoires/:id/sources`.

#### Из мастерской

`AnalysisPage` (расширение KS-3293):

- Текущий пункт «Использовать как репертуар» создаёт новый репертуар.
- Добавляем второй пункт «Добавить в существующий репертуар…» →
  модалка выбора репертуара (dropdown с моими) → POST в
  `/repertoires/:repertoireId/sources` с
  `{ pgn: analysisPgn, name: analysisTitle, sourceKind:
  'workshop-analysis', sourceAnalysisId: analysisId }`.

Это **M3-добавление**, не блокер. В первой итерации (этой задачи)
доделаем только базовую multi-source поддержку для PGN-upload'а,
конверсию из мастерской в существующий репертуар вынесем в
follow-up.

### 2.6 Влияние на `OpeningLineProgress`

`OpeningLineProgress` per-path (sha1 от UCI-пути от root). Источник
линии не важен — линия определяется ходами, не PGN-файлом.

- **Добавлен источник с новыми линиями** → новые pathHash появятся
  при первой попытке (recordAttempt создаёт запись). Существующий
  прогресс не трогаем.
- **Добавлен источник, линии которого пересекаются с уже
  выученными** → существующие pathHash остаются. Это правильно:
  путь от root тот же, не важно откуда пришёл.
- **Удалён источник** → запускаем rebuild (без этого source'а) →
  применяем orphan-pruning (механизм KS-M2-B8): прогресс с pathHash,
  которого больше нет в новом наборе валидных линий, помечается
  `orphaned=true`. Линии, пришедшие из ещё одного источника —
  остаются (pathHash валиден).
- **Изменён источник (PATCH pgn)** → rebuild + orphan-pruning, как
  при удалении. Линии возвращаются — `orphaned=false`.

Никаких изменений в модели `OpeningLineProgress` не требуется —
механизм уже есть в KS-M2-B8. Расширяем только **триггер**: pruning
запускается на каждое изменение `sources`, не только на `PATCH
/repertoire { pgn }`.

### 2.7 API

#### Новые endpoints

```
POST /opening-trainer/repertoires/:id/sources
  body: { pgn, name? }
  → 201 OpeningRepertoireDetailDto
  Создаёт source, пересобирает tree, orphan-prunes прогресс.

PATCH /opening-trainer/repertoires/:id/sources/:sourceId
  body: { pgn?, name? }
  → 200 OpeningRepertoireDetailDto
  Меняет source (хотя бы одно поле), пересобирает tree, orphan-prunes.

DELETE /opening-trainer/repertoires/:id/sources/:sourceId
  → 200 OpeningRepertoireDetailDto
  Удаляет source, пересобирает tree, orphan-prunes.
  Запрет (409) если это последний source.

GET /opening-trainer/repertoires/:id/sources
  → { sources: OpeningRepertoireSourceDto[] }
  Список источников БЕЗ pgn (для UI-карточек). Сам PGN дёргается
  отдельно через `?include=pgn` или через PATCH для editing.

GET /opening-trainer/repertoires/:id/sources/:sourceId
  → OpeningRepertoireSourceDto (с pgn — для editing-модалки)
```

#### Изменения существующих endpoints

```
POST /opening-trainer/repertoires
  body OLD: { title, description?, pgn }
  body NEW: { title, description?, sources: [{ pgn, name? }, ...] }
                OR { title, description?, pgn } (legacy, → 1 source)
  Backward-compat: оба формата валидны.

PATCH /opening-trainer/repertoires/:id
  body OLD: { title?, description?, pgn? }
  body NEW: { title?, description? }
  Поле `pgn` deprecated. Если передан — replace all sources одним
  source'ом (для совместимости). UI новой версии его не использует.

POST /opening-trainer/repertoires/from-analysis (KS-3293)
  body OLD: { analysisId, title?, description? }
  body NEW: { analysisId, title?, description?, repertoireId? }
  Если `repertoireId` указан — добавляет analysis как source к
  существующему репертуару. Иначе создаёт новый (старое поведение).
```

#### Расширения DetailDto

```ts
interface OpeningRepertoireSourceDto {
  id: string;
  repertoireId: string;
  name: string | null;
  /** Не возвращается в списочных endpoints — только в GET .../sources/:id. */
  pgn?: string;
  sourceKind: 'pgn-upload' | 'workshop-analysis' | 'legacy-import';
  sourceAnalysisId: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

interface OpeningRepertoireDetailDto extends OpeningRepertoireDto {
  pgn: string;          // denorm concat — backward-compat
  tree: RepertoireTree; // с sourceIds на каждом edge
  sources: OpeningRepertoireSourceDto[]; // без pgn в массиве
}
```

### 2.8 Лимиты

Добавляем в `OPENING_REPERTOIRE_LIMITS`:

```ts
maxSourcesPerRepertoire: 20
```

Существующие лимиты дерева (`maxNodes: 2000`, `maxEdges: 5000`,
`maxDepthHalfMoves: 80`) применяются к **итоговому** дереву (после
merge всех sources), а не к каждому source отдельно. Если merge
выходит за лимит — 400, пользователь редактирует существующие
sources или удаляет.

Лимит `maxPgnBytes: 500 * 1024` остаётся **per source** — иначе
сложно дать осмысленную обратную связь («какой именно PGN
большой»).

## 3. Влияние на ADR-077

ADR-077 НЕ переписываем — ADR-078 расширяет его. Список ссылок:

- §2.1: «один PGN» → «один или несколько PGN-источников».
- §2.2: транспозиции теперь могут происходить и **между** источниками,
  не только внутри одного PGN. Поведение builder'а единое, добавлен
  `sourceIds` на edge.
- §2.5 (`OpeningLineProgress`): orphan-pruning срабатывает на
  изменение любого источника (не только на `PATCH /repertoire { pgn }`).
- §3 (API): добавлены 5 endpoints для sources; существующие
  расширены (см. §2.7).
- §6 (Риски): см. §4 этого ADR.

## 4. Риски

1. **Размер JSONB-tree растёт** на `sourceIds` массивах. Худший
   случай: 5000 edges × 1.5 sources × 36 UUID-байт ≈ 270 КБ
   дополнительно. Постгрес-JSONB до ~1 МБ — норма. При
   приближении к лимиту — оптимизация (mapping UUID → short int с
   lookup-таблицей в `meta.sourceIdMap`), но не сейчас.
2. **Rebuild на каждый source-edit** — синхронный, ~50–100ms для
   2000-node репертуара. Это admin-операция, не hot-path. На M3
   при повышении лимитов tree можно вынести в async-job.
3. **Существующий multi-game PGN bug** в tokenizer'е — этот ADR
   лечит его через `splitPgnIntoGames` перед builder'ом.
   Регрессий не ожидается: единичные PGN продолжают работать как
   были.
4. **Migration данных** — единоразовая операция, требует rebuild
   tree всех существующих репертуаров. На dev/staging — секунды.
   На prod (если будут тысячи репертуаров) — отдельный CLI-job с
   batch'ами по 100.
5. **NAG merge как union vs first-wins** — меняем поведение
   (раньше first-wins из-за дедупликации edge). Семантически
   union корректнее (`?` от одного источника + `!?` от другого =
   `?!?`-сомнение). Тесты обновить.
6. **Confirm на удаление последнего source** — backend возвращает
   409 + понятное сообщение. Frontend дополнительно показывает
   подтверждение. Альтернатива «удалить репертуар» — отдельная
   операция.
7. **`OpeningLineProgress` после удаления source'а** — orphan-pruning
   срабатывает корректно, потому что pathHash вычисляется от
   UCI-пути, а UCI-пути не привязаны к source'ам. Линия выпадает в
   orphaned если её pathHash больше не достижим из root в новом
   дереве.
8. **`from-analysis` с `repertoireId`** — owner-check двойной (и
   на analysis, и на repertoire). Если хоть один чужой — 404 (не
   светим существование).
9. **Backend rebuild при PATCH `sources/:id` — а если
   builder бросает limit-exception?** Транзакция откатывается,
   изменение source не сохраняется, пользователь видит 400 с
   указанием какой лимит и насколько превышен. Дерево остаётся в
   прежнем состоянии.

## 5. Реализация — follow-up задачи

Зависимости: S1 → B1 (миграция + builder) → B2 → B3 → F1 + F2 → L1.

### KS-3324 (S1) — shared types для multi-source

**Assignee:** backend (shared owner).
**Labels:** `puzzle`, `onboarding`.
**Описание:**
- В `packages/shared/src/types/opening-trainer.ts`:
  - Добавить поле `sourceIds: string[]` в `RepertoireEdge`.
  - Новый `OpeningRepertoireSourceDto` (см. §2.7).
  - Расширить `OpeningRepertoireDetailDto.sources: OpeningRepertoireSourceDto[]`.
  - `CreateOpeningRepertoireRequest`: поддержать оба варианта body
    (legacy `pgn` или новый `sources[]`).
  - Новые типы: `AddRepertoireSourceRequest`, `UpdateRepertoireSourceRequest`,
    `OpeningRepertoireSourceListResponse`.
  - `OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire = 20`.
  - В `CreateOpeningRepertoireFromAnalysisRequest` добавить
    `repertoireId?: string`.
**Acceptance:**
- TS-сборка `packages/shared` без ошибок.
- Юнит-тест на narrowing union'а body (legacy vs sources).

### KS-3325 (B1) — миграция + builder для multi-source

**Assignee:** backend.
**Labels:** `puzzle`, `onboarding`, `prisma`.
**Зависит:** KS-3324.
**Описание:**
- Prisma миграция: новая таблица `opening_repertoire_sources` (см.
  §2.1). Relation в `OpeningRepertoire`.
- Data-migration в той же миграции (или скрипт `scripts/`):
  каждый существующий `OpeningRepertoire` → 1 source с
  `sourceKind='legacy-import'`, rebuild tree через builder с этим
  sourceId → tree с заполненным `sourceIds: [legacyId]` на edges.
- Расширить `RepertoireBuilderService.buildTree(sources:
  BuilderSource[])`. Сохранить старую сигнатуру `buildTree(pgn:
  string)` как wrapper для существующих тестов.
- Утилита `splitPgnIntoGames(pgn): string[]` —
  `apps/api/src/opening-trainer/pgn-splitter.ts`. Тесты на: одна
  партия; две через `[Event]`; две через результаты; пустые
  блоки.
- NAG merge: union (а не first-wins). Comment: keep-first.
**Acceptance:**
- `npm run prisma:migrate` создаёт таблицу, мигрирует данные.
- 8 тестов builder'а: один source; два source с пересечением; два
  source без пересечения; конкурирующие edges из разных source'ов;
  multi-game PGN внутри одного source; NAG union; comment first-wins;
  лимит maxSourcesPerRepertoire→400.
- `splitPgnIntoGames` отдельные тесты (4 фикстуры).

### KS-3326 (B2) — endpoints sources + orphan-pruning

**Assignee:** backend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3325.
**Описание:**
- 5 новых endpoints (§2.7). Owner-check, лимиты, rate-limit
  (`@UserRateLimit(20, 60)` на write-операции).
- В сервисе при любом изменении sources (add/edit/delete):
  rebuild tree → синхронизация `OpeningRepertoire.pgn` (concat) →
  orphan-pruning через `OpeningLineProgressService` (KS-M2-B8).
- 409 при удалении последнего source.
- 400 при превышении лимитов tree.
- Backward-compat в `POST /repertoires` и `PATCH /repertoires/:id`.
**Acceptance:**
- 12 endpoint-тестов (happy + 4xx для каждого endpoint).
- Тест orphan-pruning при удалении source с уникальной линией.
- Тест восстановления orphan при возврате source (PATCH вернул
  удалённую линию).

### KS-3327 (B3) — расширение `from-analysis` для добавления в существующий

**Assignee:** backend.
**Labels:** `puzzle`, `analysis`, `onboarding`.
**Зависит:** KS-3325.
**Описание:**
- В `POST /opening-trainer/repertoires/from-analysis` принять
  опц. `repertoireId`. Если указан — двойной owner-check
  (analysis + repertoire), создание source с
  `sourceKind='workshop-analysis'`, `sourceAnalysisId=analysisId`.
  Без `repertoireId` — старое поведение (новый репертуар).
**Acceptance:**
- Создание нового — 201 DetailDto (как было).
- Добавление в существующий — 200 DetailDto.
- Чужой `repertoireId` или чужой `analysisId` — 404.

### KS-3328 (F1) — multi-source форма создания

**Assignee:** frontend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3324, KS-3326.
**Описание:**
- `OpeningTrainerNewPage`: динамический список блоков
  PGN+name, кнопка «+ Ещё PGN» (до 20), кнопка «Удалить блок»
  (если > 1). Submit отправляет `sources[]`.
- Backward-compat: если у пользователя 1 блок — UI выглядит
  идентично текущему single-PGN.
**Acceptance:**
- Создание репертуара с 1, 3, 20 источниками.
- Лимит 20 — кнопка «+» disabled на 20-м.
- На сервере получается N sources.

### KS-3329 (F2) — секция «Источники» на странице репертуара

**Assignee:** frontend.
**Labels:** `puzzle`, `onboarding`.
**Зависит:** KS-3326.
**Описание:**
- На `OpeningTrainerRepertoirePage` секция «Источники» со списком
  карточек. Per-карточка actions: edit, delete (с confirm).
  Кнопка «+ Добавить PGN» открывает модалку.
- При delete последнего — disabled с tooltip «Нужен хотя бы один
  источник».
- При успешной операции — refetch detail + UI обновляется.
**Acceptance:**
- Список соответствует `sources[]` из API.
- Add/edit/delete работают, после операции карточки и tree-view
  обновляются.

### KS-3330 (L1) — стили секции «Источники» + multi-source форма

**Assignee:** layout.
**Labels:** `puzzle`, `onboarding`, `mobile`.
**Зависит:** KS-3328, KS-3329.
**Описание:**
- Compact-list для карточек источников (desktop — таблица, mobile
  — стек карточек). Иконки для `sourceKind`. Кнопки actions —
  иконки.
- Multi-source форма: collapsible-блоки PGN'а (схлопнуты по
  умолчанию, раскрываются на focus textarea).
- Mobile: + Add btn — FAB или sticky-bottom.
**Acceptance:**
- На viewport 360×844 секция «Источники» читается без
  горизонтального скролла.
- Multi-source форма помещает 5+ блоков без проблем.

### KS-3331 (F3, опционально для этой итерации) — добавление из мастерской в существующий

**Assignee:** frontend.
**Labels:** `puzzle`, `analysis`, `onboarding`.
**Зависит:** KS-3327.
**Описание:**
- На `AnalysisPage` actions-menu — два пункта вместо одного:
  «Использовать как новый репертуар» (как было) и «Добавить в
  существующий репертуар…» (новый — dropdown с моими, target →
  POST `/from-analysis` с `repertoireId`).
**Acceptance:**
- Оба пункта работают.
- Dropdown показывает только мои репертуары.

## 6. Что НЕ в этом ADR

- Sharing репертуаров между пользователями (M3 ADR-077 §5).
- Bulk-import .cbf/.cbe (M3).
- Async-rebuild при превышении threshold'а (M3).
- Tree-view с покраской per-source (показ источника на edge'е) —
  при реализации tree-view (KS-M2-F2) можно добавить tooltip
  «Источник: X», но это nice-to-have, не блокер.
- Drag-reorder источников (для контроля «какой первый при NAG
  merge» — не нужно, NAG union ассоциативный).
- Lock'и при concurrent rebuild — single-user-per-repertoire,
  гонок нет.

## 7. Откат

- Можно откатить только до прохождения миграции данных. После —
  не имеет смысла: `OpeningRepertoire.pgn` остался корректным
  (denorm концат), legacy-импорт сохранён как один source.
- Frontend-чейнджи под feature-flag не вводим — это additive
  изменения, не breaking.
- В крайнем случае можно скрыть кнопки add/edit/delete на UI и
  оставить legacy-single-source поведение, но без сноса таблицы.
