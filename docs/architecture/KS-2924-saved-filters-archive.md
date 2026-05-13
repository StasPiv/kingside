# KS-2924 — Сохранённые фильтры в Архиве + редизайн UX списка

**Дата:** 2026-05-13
**Статус:** Предложение, ожидает согласования
**Задача:** KS-2924
**Связанные:**
- ADR-011 — Мастерская как раздел
- ADR-013 / ADR-014 / ADR-033 — Архив (схема, by-position, UI)
- KS-2210 — последние применённые фильтры архива (`user.archive_filters`)

> Документ-план. Кода не пишем; на основе этого документа координатор нарежет задачи на backend / frontend / layout.

---

## 1. Контекст и проблема

В Мастерской (`/workshop`, секция «Мои анализы») у пользователя есть **именованные сохранённые фильтры**: отфильтровал по категории / тегам / поисковой строке → нажал «Save filter» → ввёл имя → набор появился чипом. Чип кликабельный (применить) и удаляемый (×). Реализовано в `WorkshopAnalysisList.tsx` + таблица `saved_filters` (см. §2.1).

В Архиве (`/archive/games`) такой функциональности **нет**. Есть только автосохранение **последнего** применённого набора в JSONB-поле `user.archive_filters` (KS-2210) — оно восстанавливается при следующем заходе, но **именованные пресеты** (например, «партии Карлсена против Каруаны» и «B90 Najdorf после 2020») между собой не переключаются.

Параллельная UX-проблема: на странице Мастерской чипы сохранённых фильтров рендерятся **в потоке** перед списком анализов (CSS `.workshop-saved-filters { flex-wrap; margin-bottom }`). При количестве 8–20 чипов они переносятся на 2–3 строки и **оттесняют список анализов вниз** — основной контент закрыт.

Цель — закрыть **обе** проблемы за один проход и сделать единый механизм для двух разделов.

---

## 2. Текущая реализация — что есть

### 2.1. Backend (Мастерская)

**Таблица** `saved_filters` (миграция `20260405130000_add_saved_filters`):

```
id          UUID  PK
user_id     UUID  FK → users.id  (RESTRICT, индекс)
name        TEXT  NOT NULL
category    TEXT? NULLABLE          -- 'analysis' | 'game_review' | 'puzzle' | ''
tags        TEXT? NULLABLE          -- CSV строка: "endgame,training"
search      TEXT? NULLABLE          -- поисковая подстрока
sort_order  TEXT? NULLABLE          -- 'newest' | 'oldest' | 'title_asc' | 'title_desc' | ''
created_at  TIMESTAMP DEFAULT now()
```

**Контракт API** (`/api/analyses/filters`, контроллер `apps/api/src/analysis/analysis.controller.ts`):

- `GET    /analyses/filters` — список фильтров пользователя (desc by createdAt)
- `POST   /analyses/filters` — создать (валидация в `CreateSavedFilterDto`)
- `PATCH  /analyses/filters/:filterId` — обновить
- `DELETE /analyses/filters/:filterId` — удалить

**Бизнес-правила** (`SavedFilterService`): лимит `MAX_FILTERS_PER_USER = 20`, проверка ownership по `userId`.

### 2.2. Frontend (Мастерская)

`apps/web/src/components/workshop/WorkshopAnalysisList.tsx`:

- Локальный тип `SavedFilter` — точное зеркало backend-модели.
- Состояние `[savedFilters, setSavedFilters]` загружается через `api.get('/analyses/filters')` в `useEffect` (с миграцией старого `localStorage['workshopSavedFilters']` в БД).
- Создание: `handleSaveFilter` — POST с текущими `categoryFilter`, `selectedTags.join(',')`, `searchQuery`.
- Применение: `handleApplyFilter` — обратное преобразование (CSV → массив, пустая `category` → `'all'`), `updateUrl(...)` синхронизирует URL.
- Удаление: `handleDeleteFilter` — DELETE.

UI-блок:

```
| filter tabs (category) |
| search input           |
| selected tag chips     |
| [Save filter] ←─ row    │  ← workshop-save-filter-row
| Saved: [chip][chip][chip][chip] …  ←─ flex-wrap, до 20 чипов
| [+ New analysis] [Select] …
| ── список анализов ──
```

### 2.3. Архив

**Фильтры** (`apps/web/src/pages/ArchiveGamesPage.tsx`, dto `apps/api/src/user/dto/archive-filters.dto.ts`):

| Поле | Тип | Источник |
|---|---|---|
| `players[]` | `string[]` | мульти-значение в URL `?player=A&player=B` |
| `event` | `string` | произвольная подстрока |
| `eco` | `string` | код дебюта (B90, …) |
| `result` | `'1-0' \| '0-1' \| '1/2-1/2' \| '*' \| 'any'` | результат |
| `minElo` | `number?` | мин. средний рейтинг |
| `since` / `until` | `YYYY-MM-DD?` | период |
| `minPly` / `maxPly` | `number?` | длина партии |
| `timeControlCategory[]` | `('bullet'\|'blitz'\|'rapid'\|'classical'\|'unknown')[]` | мульти-значение |
| `sort` | `'recent' \| 'topElo' \| 'oldest'` | сортировка |

**Сохранение последнего набора** (KS-2210):
- Таблица `users.archive_filters JSONB` (nullable).
- `GET/PUT /api/user/preferences/archive-filters`.
- Дебаунс 1 сек на изменение, fallback в `localStorage['archive_metadata_filters_v1']` при 401/сетевой ошибке.
- **Хранится один набор, без имени** — это не «пресеты», а «последнее состояние».

### 2.4. Разрыв между двумя моделями

| Аспект | Мастерская | Архив |
|---|---|---|
| Хранение | таблица `saved_filters`, плоские строки | `user.archive_filters` JSONB, один набор |
| Именование | да (`name`) | нет |
| Количество | до 20 | один |
| Состав | category, tags, search, sortOrder | 10+ параметров, часть массивы |
| API | `/analyses/filters` (CRUD) | `/user/preferences/archive-filters` (GET/PUT) |

Прямое расширение текущей таблицы `saved_filters` плоскими полями архива (`player`, `eco`, `event`, `result`, `time_control`, `min_elo`, …) приведёт к ~15 NULL-колонкам и жёстко свяжет схему БД с любым добавлением фильтра в архиве. Это не масштабируется.

---

## 3. Предлагаемое решение

### 3.1. Единая схема данных

Расширить таблицу `saved_filters` двумя колонками — `section` и `params` (JSONB), плоские текстовые поля **депрекейтить** (оставить read-only для legacy-чтения и миграции, потом удалить).

```
-- AlterTable
ALTER TABLE saved_filters
  ADD COLUMN section TEXT NOT NULL DEFAULT 'workshop',
  ADD COLUMN params  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT now();

-- Индекс под выборку «фильтры пользователя в разделе»
CREATE INDEX saved_filters_user_section_idx
  ON saved_filters (user_id, section, created_at DESC);

-- Чек на список допустимых разделов (расширяем при появлении нового)
ALTER TABLE saved_filters
  ADD CONSTRAINT saved_filters_section_check
  CHECK (section IN ('workshop','archive'));
```

`section` — дискриминатор раздела. На сегодня — `workshop`, `archive`. На будущее (puzzle browser, broadcasts, players list…) добавляем значение в CHECK и одну строку валидации на бэке, схема при этом не меняется.

`params` — JSONB с произвольным набором параметров секции. Валидация на стороне backend-сервиса (см. §3.2).

`name` оставляем колонкой (он семантичен и должен быть индексируемо-уникальным в перспективе).

`category` / `tags` / `search` / `sort_order` — depreкейтятся: новые записи кладём в `params`. Для legacy-чтения (см. §3.4) добавляем mapper «плоские поля → params для section=workshop».

Структура `params` по секциям:

- `section='workshop'` — `{ category, tags: string[], search, sortOrder }`
  (`tags` — массив, а не CSV-строка; sort вынесен из плоского `sort_order`).
- `section='archive'` — `{ players: string[], event, eco, result, minElo, since, until, minPly, maxPly, timeControlCategory: string[], sort }`
  (зеркало `ArchiveMetadataFilterValues` без UI-only-полей).

Контракт JSONB описывается в `packages/shared/src/types/api-contracts.ts` дискриминированным union'ом:

```ts
type SavedFilterParams =
  | { section: 'workshop'; category: string | null; tags: string[]; search: string | null; sortOrder: string | null }
  | { section: 'archive'; players: string[]; event: string | null; eco: string | null; result: ArchiveResult | null; minElo: number | null; since: string | null; until: string | null; minPly: number | null; maxPly: number | null; timeControlCategory: TimeControlCategory[]; sort: ArchiveSort | null };
```

Лимит — `20 фильтров на (user_id, section)`. Общий потолок на пользователя — `40` (два раздела × 20). Поднимать не нужно — это бытовой инструмент, не складирование.

### 3.2. API-контракт

Старый `/analyses/filters` депрекейтим, оставляем 3 релиза как proxy. Новые эндпоинты — секционные, с единым контроллером.

```
GET    /api/user/saved-filters?section=workshop|archive
       → SavedFilterDto[]                 (по умолчанию сорт desc by createdAt)

POST   /api/user/saved-filters
       body: { section, name, params }
       → SavedFilterDto

PATCH  /api/user/saved-filters/:id
       body: { name?, params? }           (section неизменяем)
       → SavedFilterDto

DELETE /api/user/saved-filters/:id
       → { deleted: true }
```

`SavedFilterDto`:

```ts
{
  id: string;
  section: 'workshop' | 'archive';
  name: string;
  params: SavedFilterParams;
  createdAt: string;
  updatedAt: string;
}
```

Валидация на стороне `SavedFilterService`:
- `section ∈ { workshop, archive }`,
- `name`: 1–100 символов, trim, unique per `(user_id, section)` (мягкая проверка с 400 на дубль),
- `params`: класс-валидатор по дискриминатору; неизвестные поля отбрасываются;
- лимит 20 на секцию.

Бэкенд `analysis-module` теряет `SavedFilterService` (или оставляет тонкую proxy-обёртку), новый сервис живёт в `user-module` рядом с `UserPreferencesService` — это user-scoped функция, не «analysis».

### 3.3. Связь с «последним применённым» (KS-2210)

`users.archive_filters` JSONB **не трогаем**. Это два разных сценария:
- KS-2210 — «продолжить там, где остановился» (автосейв последнего состояния, восстанавливается без явного действия).
- KS-2924 — «явный пресет с именем», который пользователь хочет вызывать сознательно.

Оба механизма сосуществуют: при загрузке `ArchiveGamesPage` сначала смотрим URL (deep-link имеет приоритет); если URL пустой — восстанавливаем из `user.archive_filters` (как сейчас); пресеты применяются только по клику пользователя в UI.

### 3.4. Миграция данных

Существующие записи (`section='workshop'` по умолчанию из миграции) одним SQL-апдейтом переносим в `params`:

```sql
UPDATE saved_filters
SET params = jsonb_build_object(
  'category',  NULLIF(category, ''),
  'tags',      CASE WHEN COALESCE(tags,'') = '' THEN '[]'::jsonb
                    ELSE to_jsonb(string_to_array(tags, ','))
               END,
  'search',    NULLIF(search, ''),
  'sortOrder', NULLIF(sort_order, '')
)
WHERE section = 'workshop' AND params = '{}'::jsonb;
```

Плоские колонки `category / tags / search / sort_order` оставляем как nullable до релиза N+2 (Phase C), потом удаляем отдельной миграцией. Это снижает риск отката (rollback восстанавливает старый код, который читает плоские поля).

### 3.5. URL-сериализация пресета

Применение пресета на frontend — это `applyFilter(filter)`, который пишет params в URL (через существующие `metadataFiltersToUrl` / `updateUrl` в Мастерской). Пресет НЕ становится частью URL — URL содержит сам набор фильтров. Это даёт shareable-ссылку без зависимости от пресетов получателя.

Опционально (Phase B): добавить `?savedFilter=<id>` как hint для подсветки текущего активного пресета в UI. Сам список фильтров всё равно сериализуется в URL.

---

## 4. UX-варианты для списка сохранённых фильтров

Базовая цель: список не должен закрывать основной контент при 20 пресетах; должен поддерживать выбор / переименование / удаление / создание; должен ощущаться как часть фильтр-панели, а не отдельный «инвентарь».

### Вариант A — Dropdown-меню «Saved filters ▾»

Кнопка в строке фильтр-тулбара (рядом с «Reset», «Save current»). При клике — выпадающее меню с прокручиваемым списком пресетов, поиск по имени, иконки переименовать/удалить на hover каждой строки. Активный пресет помечен галкой.

```
[ filters … ]  [Save current]  [Saved filters ▾]  [Reset]
                                  └──────────────┐
                                  | 🔎 search    |
                                  | ✓ Najdorf 90 |  ⋮
                                  |   Carlsen v.K|
                                  |   …          |
                                  | (scroll)     |
                                  └──────────────┘
```

**Плюсы.** Один клик до списка, нулевое влияние на контент страницы, естественно масштабируется до 20+, привычная UX-метафора (как «Bookmarks» в браузере). Хорошо живёт на мобильном (popover на тачнехе).
**Минусы.** Скрытый список — пользователь должен открыть меню, чтобы вспомнить, что у него сохранено. Это устранимо подписью на кнопке: «Saved filters (5)».

### Вариант B — Боковая выезжающая панель (drawer)

Кнопка «Saved filters» открывает выезжающую справа панель (≈ 280px), которая остаётся открытой пока пользователь работает; в ней — поиск, чипы / список пресетов, drag-and-drop для упорядочивания. Закрывается крестиком / тем же тоглом.

**Плюсы.** Видна постоянно, удобно для активного переключения между 5+ пресетами.
**Минусы.** Откусывает ≈280px ширины основного контента (на ноутбуке 1440px это терпимо, на 1280px и меньше — заметно). На мобильном — fullscreen-drawer, добавляет ещё одно состояние интерфейса. Требует места под кнопку-тогл и стейт «открыта / закрыта» (с сохранением в `localStorage`).

### Вариант C — Чипы в свёрнутой строке («Saved: …»)

Сохраняем текущую модель (чипы в потоке), но:
- одна строка max-height, `overflow-x: auto` (горизонтальная прокрутка с инерцией);
- после 3–5 чипов «show all (N)» — раскрытие в `<details>` или popover.

**Плюсы.** Минимум кода — это эволюция текущего решения. Чипы видны без клика.
**Минусы.** Горизонтальный скролл на десктопе неудобен (нет инерции у мыши); на мобильном работает, но всё равно при 15+ чипах превращается в «карусель», по которой надо листать. Не решает проблему «список нашёл и закрыл контент» при коротком экране, где даже одна строка чипов + строка save занимает заметную долю первого экрана.

### Сравнительная таблица

| Критерий | A (dropdown) | B (drawer) | C (чипы) |
|---|---|---|---|
| Не закрывает контент | да | да (на десктопе) / нет (мобиле) | частично |
| Видимость списка по умолчанию | низкая | высокая | средняя |
| Сложность реализации | низкая | средняя | низкая |
| Масштабирование до 20 пресетов | хорошо | хорошо | плохо |
| Унификация Мастерская + Архив | легко | легко | легко |
| Мобильный UX | хорошо | средне | хорошо |

### Рекомендация

**Вариант A (dropdown)** как основной. Он закрывает обе проблемы (контент не оттесняется, лимит 20 не ломает интерфейс), требует минимум кода, ведёт себя одинаково на двух разделах. Подпись на кнопке «Saved filters (N)» снимает основной недостаток (невидимость списка).

Если в ходе использования выяснится, что пресетов реально много и они нужны «всегда под рукой» — добавить вариант B как дополнительный (тогл «закрепить панель»). Это инкрементальное расширение, поверх dropdown.

Вариант C предлагаем отвергнуть: он не масштабируется и в нынешнем виде уже даёт жалобу из тикета.

### Эскиз dropdown (псевдо-вёрстка)

```mermaid
flowchart LR
  T[Toolbar: filters · search] --> Save([Save current ▸ inline name])
  T --> Saved[Saved filters (N) ▾]
  Saved --> Menu
  subgraph Menu[popover]
    direction TB
    Find["🔎 Find"]
    Item1["✓  Najdorf B90, since 2020   ⋮"]
    Item2["    Carlsen vs Caruana         ⋮"]
    Item3["    Endgames > 60 plies        ⋮"]
    Empty["(нет сохранённых)"]
  end
  Item1 --> Apply[применить → URL]
  Item1 -. ⋮ .-> Rename[Rename · Delete]
```

Поведение:
- Клик по строке — применить пресет (закрыть popover).
- ⋮ (kebab) на hover/long-press — `Rename`, `Delete`, `Update from current`. `Update from current` перезаписывает params текущим состоянием — частый сценарий, иначе пользователь руками удаляет и пересохраняет.
- Поиск по имени — фильтрация списка inline.
- Кнопка `Save current` рядом с тогл’ом — раскрывается в inline-input для имени (как сейчас в Мастерской), на Enter — POST, чип на месте `Save current` мигает «✓ Saved» и попадает в список.
- Активный пресет — галкой (по `?savedFilter=<id>` / эвристике совпадения params).
- Пустое состояние — подсказка «Save current filter to access it later».

---

## 5. План работ — разбивка на задачи

Phase A — данные и API (backend-only, без UI-эффектов):

1. **KS-####/A1 [backend]** Расширить схему `saved_filters`: миграция `add_section_and_params_to_saved_filters` — `section TEXT`, `params JSONB`, `updated_at`, индекс `(user_id, section, created_at desc)`, CHECK на section. Обновить Prisma-модель.
2. **KS-####/A2 [backend]** Data-migration: SQL UPDATE из §3.4 для существующих записей в `params`.
3. **KS-####/A3 [backend]** Новый модуль `user-saved-filters` (контроллер + сервис + DTO + class-validator с дискриминатором по `section`). Лимит 20 на секцию, валидация имени.
4. **KS-####/A4 [backend]** Контракты в `packages/shared`: `SavedFilterDto`, `SavedFilterParams` дискриминированный union.
5. **KS-####/A5 [backend]** Старые `/analyses/filters` оставить proxy с тонким мэппингом (новые поля ↔ плоские DTO) + deprecation-header `Sunset: …`.
6. **KS-####/A6 [backend]** Юнит-тесты сервиса (лимит, валидация params, uniqueness имени, ownership).

Phase B — UI: общий компонент + Мастерская:

7. **KS-####/B1 [frontend]** Хук `useSavedFilters(section)` — загрузка / создание / обновление / удаление через новый API, optimistic-update.
8. **KS-####/B2 [frontend]** Компонент `<SavedFiltersDropdown>` (общий) — кнопка-тогл, popover с поиском, элементы списка, kebab-меню. Принимает `params: T`, `onApply(params)`, `onCapture(): T`. Локализация i18n.
9. **KS-####/B3 [frontend]** Перевести `WorkshopAnalysisList` на новый хук + dropdown. Убрать `workshop-saved-filters` flex-блок и сопутствующий CSS. Старый ключ `localStorage['workshopSavedFilters']` — миграция уже в БД (в HTML-блоке load-эффекта), оставляем `removeItem` в финальной версии.
10. **KS-####/B4 [layout]** CSS для `<SavedFiltersDropdown>` (popover, поиск, ховеры, kebab, моб-адаптив, тёмная тема), стили активного пункта, transition popover/escape-close, фокус-trap a11y.
11. **KS-####/B5 [frontend]** Юнит-тесты: применение пресета, переименование, удаление, лимит, поиск.

Phase C — Архив:

12. **KS-####/C1 [frontend]** Интеграция `<SavedFiltersDropdown section="archive">` в `ArchiveMetadataMode` (рядом с «Reset filters»). `onCapture` сериализует текущие `ArchiveMetadataFilterValues`; `onApply` пишет в URL через `metadataFiltersToUrl`.
13. **KS-####/C2 [frontend]** Подсветка активного пресета: вычисление совпадения текущих filterValues с params пресета (deep-equal с нормализацией пустых значений). Опционально — `?savedFilter=<id>` в URL.
14. **KS-####/C3 [frontend]** Тесты: применение пресета не ломает KS-2210 автосейв; deep-link имеет приоритет; смена пресета сбрасывает cursor / page.
15. **KS-####/C4 [content/i18n]** i18n-ключи `archive.savedFilters.*` (ru/en): «Save current», «Saved filters (N)», «Rename», «Delete», «Update from current», пустое состояние.

Phase D — Чистка:

16. **KS-####/D1 [backend]** Удаление плоских колонок `category / tags / search / sort_order` из `saved_filters` (после 1–2 релизов в проде). Снятие proxy `/analyses/filters` (или Sunset-301 на `/user/saved-filters?section=workshop`).
17. **KS-####/D2 [qa]** Регрессионный прогон Мастерская + Архив: лимит 20, миграция legacy-фильтров, dropdown на мобильном и десктопе.

Зависимости: A1→A2→A3→A4; A→B; B2→B3, B2→C1; A5 параллельно B (нужен для backward-compat на время выкатки фронта); D после полного релиза.

Оценка трудоёмкости (для координатора, грубо):
- A: ~1 день backend (миграции + сервис + тесты + контракты)
- B: ~1.5 дня (хук + dropdown + рефактор Мастерской + CSS + тесты)
- C: ~0.5 дня (интеграция в архив + тесты)
- D: ~0.5 дня (snapshot после прода)

Итого: 3–4 дня одного исполнителя, при последовательном проходе. Phase A и Phase B2 (общий компонент) реалистично параллелить — это разные слои.

---

## 6. Риски и открытые вопросы

1. **Конфликт имени пресета** в пределах секции. Сейчас в Мастерской имени-уникальности нет — можно сохранить два «Carlsen» с разным составом. Предлагаю мягкую проверку уникальности (`409` на дубль) и подсказку «такое имя уже есть». Альтернатива — разрешить дубли (как сейчас). Нужно подтверждение от пользователя.
2. **«Update from current»** в kebab-меню. Это новый сценарий относительно текущего поведения Мастерской (там для обновления надо удалить и пересохранить). Если действие не нужно — снимаем, иконку не делаем.
3. **Подсветка активного пресета.** Если пользователь применил пресет и потом изменил один фильтр — считается «активный» или «модифицирован»? Предлагаю состояние `active` (точное совпадение) / `modified` (был активным, потом изменён) — последнее обозначается иконкой/курсивом. Это niceto-have, можно вынести во вторую итерацию.
4. **Доступ к пресетам с разных устройств.** После миграции в БД — всё работает «из коробки» (пресеты привязаны к userId). Локальный fallback на `localStorage` для гостей делать не предлагается: пресеты — фича для залогиненных, гостям показываем CTA «Sign in to save filters».
5. **Расширение на другие разделы** (puzzle browser, broadcasts, players). Схема через `section` + JSONB уже это поддерживает; UI-компонент `<SavedFiltersDropdown>` тоже generic. Если будут возражения по дизайну — лучше отловить сейчас, чем после релиза.

---

## 7. Definition of Done документа

- [x] Описано текущее состояние (Мастерская SavedFilter, Архив фильтры + KS-2210).
- [x] Предложена единая схема БД (`section` + `params` JSONB) с миграцией существующих данных.
- [x] Описан API-контракт (`/api/user/saved-filters`) и план депрекейта старого `/analyses/filters`.
- [x] Сравнены 3 UX-варианта с плюсами/минусами; есть рекомендация (Вариант A).
- [x] Разбито на задачи по фазам A/B/C/D с указанием роли (backend / frontend / layout / qa).
- [x] Перечислены открытые вопросы для согласования с пользователем.
