# ADR-032: Перенос «Дневника ошибок» из `/lessons` в раздел паззлов

**Дата:** 2026-04-25
**Статус:** Предложено
**Задача:** KS-1926
**Связанные:**
- [ADR-025 Lessons SM-2](./025-lessons-sm2.md) — `ReviewsDueBlock` остаётся на `/lessons` как часть SM-2 системных уроков
- [ADR-031 Lessons lobby redesign](./031-lessons-lobby-redesign.md) — обновляется в части L2 «Daily focus»
- KS-1802 — оригинальная фича «Дневник ошибок»

---

## 1. Контекст

### 1.1 Что есть сейчас

«Дневник ошибок» — функциональность анализа ошибок пользователя в
шахматных задачах:

- **Источник данных:** `Puzzle.themes` (системная Lichess puzzle БД).
  Запись через `MistakesService.recordPuzzleMistake(userId, puzzleId)`
  при каждом неудачном `PuzzleAttempt`. Дополнительно
  `recordGameMistake` при анализе партии.
- **UI-блок:** `MistakesDiaryBlock.tsx` в
  `apps/web/src/components/lessons/` — топ-5 тем, по которым юзер чаще
  всего ошибается, с CTA «Practice mistakes».
- **Полный список:** `MistakesPage` на маршруте `/lessons/mistakes` —
  все темы с counters.
- **Тренировка по теме:** `MistakesPracticePage` на
  `/lessons/mistakes-practice?theme=<...>` — тот же puzzle UI
  с фильтром по выбранной теме.
- **Backend API:** `MistakesController` (`apps/api/src/lessons/`),
  endpoints под префиксом `/api/lessons/mistakes/aggregates` и
  `/api/lessons/mistakes/recommendations`.
- **Подключение:** в `LessonsPage.tsx` блок рендерится в L2 «Daily
  focus» рядом с `ReviewsDueBlock` (по ADR-031 §2.2).

### 1.2 Семантическая проблема

Дневник ошибок никак не связан с курсами:
- Не использует ни `Course`, ни `Lesson`, ни `UserCourse`.
- Не записывается при прохождении уроков. Только при puzzle-attempts и
  game-review.
- Тренировка ошибок — это решение **обычных задач** с фильтром по теме,
  идентично puzzle-flow.
- Логически dataset — `PuzzleAttempt` + `Puzzle.themes` — целиком
  в puzzle-домене.

Пребывание блока на `/lessons` и под `/api/lessons/mistakes/*` —
исторический shortcut от KS-1802 («блок поставили там, где было удобно
пользователю на момент запуска»), а не семантически правильное
размещение.

### 1.3 `ReviewsDueBlock` остаётся

Чтобы избежать путаницы — `ReviewsDueBlock` (SM-2 «к повторению
сегодня», KS-1799) к курсам относится **по существу**: датасет —
`LessonReview`, привязка через FK `Lesson.id`. ADR-025 §2.5 явно
зафиксировал это. Не трогаем.

---

## 2. Целевое размещение блока в разделе паззлов

### 2.1 Изучение текущей структуры puzzle-страниц

В разделе паззлов (по `apps/web/src/App.tsx` и страницам):

| URL | Страница | Назначение |
|---|---|---|
| `/puzzle` | `PuzzlePage` | Решить случайную задачу |
| `/puzzle/:id` | `PuzzlePage` | Решить конкретную задачу |
| `/puzzles` | `PuzzleBrowserPage` | Каталог сгенерированных задач |
| `/puzzles/stats` | `PuzzleStatsPage` | Личная статистика (рейтинг, история, попытки) |
| `/puzzles/rush` | redirect → `/puzzle-rush` | Rush-режим |
| `/puzzle-rush` | `PuzzleRushPage` | Тайм-аттак |
| `/daily-puzzle` | `DailyPuzzlePage` | Ежедневная задача |

**Ключевое наблюдение:** в разделе паззлов **нет lobby-страницы**.
`/puzzle` сразу открывает доску с задачей; общего хаба «вот всё, что
есть про паззлы» нет. Это отличает раздел паззлов от `/lessons`
(LessonsPage = lobby).

### 2.2 Рассмотренные варианты встройки

| Вариант | Где | Плюсы | Минусы |
|---|---|---|---|
| **A** | На `/puzzle` (solve) — top-bar или sidebar | Юзер сразу видит после открытия | Нарушает focus solving flow; маленькое место |
| **B** | На `/puzzles` (PuzzleBrowserPage) — отдельная секция | Browser уже про список задач | Browser специализирован под сгенерированные задачи; mistakes-flow тут вне темы |
| **C** | На `/puzzles/stats` (PuzzleStatsPage) — отдельная секция «Слабые темы» | Stats уже про прогресс/анализ; дневник ошибок естественно дополняет | Юзер должен сам зайти на `/puzzles/stats` — не виден из solve flow |
| **D** | Создать новый lobby `/puzzles/home` или сделать `/puzzle` без id показывал хаб | Системно правильно, на будущее | Большой объём редизайна, вне скоупа задачи |
| **C+a** | Primary на `/puzzles/stats` + secondary компактный link на `/puzzle` (solve) | Discovery + не нарушает solve flow | Чуть больше работы, два места |

### 2.3 Принимаем — **C + secondary link**

**Primary:** на `/puzzles/stats` (PuzzleStatsPage) — большая секция
«Слабые темы» (полный аналог текущего `MistakesDiaryBlock`, с топ-5
тем + CTA «Practice mistakes»).

**Secondary:** компактный hint на `/puzzle` (solve) — небольшая
плашка под доской или в sidebar'е: «Слабые темы: pin (12) →
Тренировать», link на `/puzzles/mistakes-practice?theme=pin` (или на
полный список `/puzzles/mistakes`). Открывается **только** для юзеров
с накопленным дневником (≥1 тема).

**Полный список:** `/puzzles/mistakes` — отдельная страница
(переименованный аналог текущего `/lessons/mistakes`, см. §3).

**Тренировка:** `/puzzles/mistakes-practice` — отдельная страница
(переименованный аналог текущего `/lessons/mistakes-practice`).

### 2.4 Почему именно C+secondary, а не C один

Чисто C решает «семантическую» сторону, но **discoverability** падает:
юзер заходит на `/puzzle` (через sidebar `🧩` Puzzles), решает задачи,
не знает, что есть «Слабые темы» — переход на `/puzzles/stats`
неочевиден. Compact-link на `/puzzle` решает это: пользователь видит
«вот ты слаб в pin — иди потренироваться» прямо в solve flow, не
требуя дополнительного клика по навигации.

### 2.5 Почему не D (lobby для паззлов)

Создание `/puzzles/home` — это редизайн **всего раздела паззлов**, а не
перенос одного блока. Это **отдельная архитектурная задача**, которую
имеет смысл решать после стабилизации `/lessons` (ADR-031). Сейчас
`/puzzle` (solve) — главная точка входа, и этого достаточно. Потенциал
для будущего lobby отмечаем как **follow-up** (см. §6).

### 2.6 Почему не A (на /puzzle solve top-bar)

`PuzzlePage` — focus-страница: одна задача, один ход. Любой блок,
конкурирующий с доской за внимание, ухудшает UX решения. Compact-link
из §2.3 — крайний минимум, который не нарушает focus.

---

## 3. Маршруты — переименовать

### 3.1 Решение

| Старый маршрут | Новый маршрут | Действие |
|---|---|---|
| `/lessons/mistakes` | `/puzzles/mistakes` | Rename + 301-redirect |
| `/lessons/mistakes-practice?theme=...` | `/puzzles/mistakes-practice?theme=...` | Rename + 301-redirect |

Конвенция выбора `/puzzles/*` (plural):
- `/puzzles/stats` (plural) уже существует.
- `/puzzles/browse` тоже plural.
- Singular `/puzzle/*` зарезервирован под solve (`/puzzle/:id`).
- Mistakes — analytics + practice flow, не конкретная задача → plural.

Это согласуется с существующей конвенцией раздела (admin/list URLs —
plural, single-resource URLs — singular).

### 3.2 Redirects

В `App.tsx`:

```tsx
<Route path="/lessons/mistakes" element={<Navigate to="/puzzles/mistakes" replace />} />
<Route path="/lessons/mistakes-practice" element={<Navigate to="/puzzles/mistakes-practice" replace />} />
```

`<Navigate replace>` сохраняет query-параметры (`?theme=pin`),
React-Router передаёт их автоматически в target route. SEO-нюанс
(301 vs client-side redirect) для нашего профиля иррелевантен —
internal user pages, не индексируются явно.

### 3.3 Почему не оставить старые URL

Аргументы за rename:
- **Семантическая чистота URL** — сейчас юзер заходит «на курс»
  (`/lessons/`) и попадает в puzzle-flow. URL врёт о домене.
- **Отказ от `/lessons/*` как зоны mixing** — удерживаем `/lessons`
  для курсов (системные + user-course), `/puzzles` для паззлов.
- **Будущее расширение** — если добавим `/puzzles/themes` (каталог
  тем) или `/puzzles/recommendations` (что решать дальше) — они
  станут естественными соседями `/puzzles/mistakes`.

Аргументы против (отвергаем):
- Сложность миграции — мизерная (rename + 2 redirects).
- Закладки юзеров — покрываются 301 redirects.

---

## 4. Backend пути — переименовать

### 4.1 Решение

| Старый путь | Новый путь |
|---|---|
| `/api/lessons/mistakes/aggregates` | `/api/puzzle/mistakes/aggregates` |
| `/api/lessons/mistakes/recommendations` | `/api/puzzle/mistakes/recommendations` |

Также **переносим backend код**:

| Откуда | Куда |
|---|---|
| `apps/api/src/lessons/mistakes.controller.ts` | `apps/api/src/puzzle/mistakes.controller.ts` |
| `apps/api/src/lessons/mistakes.service.ts` | `apps/api/src/puzzle/mistakes.service.ts` |
| `apps/api/src/lessons/mistakes.service.spec.ts` | `apps/api/src/puzzle/mistakes.service.spec.ts` |
| `apps/api/src/lessons/mistakes.module.ts` | `apps/api/src/puzzle/mistakes.module.ts` |

`@Controller('lessons/mistakes')` → `@Controller('puzzle/mistakes')`.

### 4.2 Решение по конвенции `puzzle` vs `puzzles`

Backend-controller уже использует **singular `puzzle`** в существующих
маршрутах (`@Controller('puzzle')` для `PuzzleController`). Чтобы не
плодить parallel namespaces — берём **`puzzle/mistakes`** (singular,
как в существующем `puzzle/...` namespace).

Frontend URL остаётся **plural `/puzzles/mistakes`** — это разные
конвенции для разных слоёв (frontend tends to plural, backend follows
existing controller). Это нормально для нашего проекта (см. existing
inconsistency `/puzzles` (frontend) vs `@Controller('puzzle')`
(backend) — оно уже есть).

### 4.3 Почему не оставить как есть

API внутренний (никто кроме нашего FE его не вызывает). Аргумент
«не трогаем работающее» — pragmatic, но мы и так делаем breaking
change для FE (rename routes). Cost ребейза ≈ 0 (move file + change
controller decorator string). Получаем семантическую чистоту:
backend код архива, lessons, puzzle логически разделён.

### 4.4 Что НЕ меняется в backend

- **Логика mistake-агрегации и recommendations** — без изменений.
  Только move + rename controller-prefix.
- **Схема БД** (`Mistake` table, FK на `User`/`Puzzle`) — без
  изменений.
- **Запись ошибок** (`recordPuzzleMistake`, `recordGameMistake`) —
  вызывается из `PuzzleService` и `AnalysisService` тех же слов;
  лишь импортируется из нового пути.

---

## 5. Sidebar и навигация (follow-up)

### 5.1 Текущее состояние

В sidebar навигации (по KS-1919 скрину) у иконки `🧩 Puzzles` —
прямая ссылка на `/puzzle` (solve). Никаких подменю, sub-nav'а нет.
Юзер из `/puzzle` не может попасть на `/puzzles/stats` или
`/puzzles/mistakes` без знания URL'а.

### 5.2 Что предлагаю — отдельной задачей

В рамках ADR-032 это **не делаем**. Вне скоупа задачи. Но фиксируем
для координатора как **follow-up**:

- На `/puzzle` (solve) добавить header-link «Stats / Browse / Mistakes»
  — компактная вторичная навигация в шапке страницы.
- Альтернатива — sub-nav в sidebar при наведении на `🧩` (раскрывается
  меню с ссылками).
- Главный архитектурный вопрос (тоже follow-up) — стоит ли создавать
  `/puzzles` как полноценное **lobby для паззлов** (вариант D из §2.2)
  с разделами Solve/Stats/Browse/Mistakes/Rush. Это редизайн,
  отдельный ADR.

Для ADR-032 достаточно: discoverability mistakes из solve flow
обеспечивается **compact-link'ом на `/puzzle`** (§2.3 secondary).

---

## 6. Влияние на ADR-031 (lessons lobby redesign)

В ADR-031 §2.2 был зафиксирован уровень L2 «Daily focus» с двумя
блоками:

| Блок | Назначение | Источник данных |
|---|---|---|
| `ReviewsDueBlock` | SM-2 повторения системных уроков | `LessonReview` |
| `MistakesDiaryBlock` | Слабые puzzle-темы | `Mistake` (PuzzleAttempt-derived) |

После ADR-032 в L2 остаётся только `ReviewsDueBlock`.

**Влияние на структуру:** ничего не ломается.
- Wireframe ADR-031 §5.1 (desktop) показывал `Reviews due` и
  `Mistakes diary` рядом в одной row. После ADR-032 — только
  `Reviews due` (single block, full-width).
- Wireframe §5.3 (mobile) — то же.
- Hero-логика (`useLessonsHeroContext`) не зависит от
  `MistakesDiaryBlock` — не трогается.

**Что обновляется в ADR-031:** §2.2, §5.1, §5.3 — убирается упоминание
`MistakesDiaryBlock`. Это **не пересмотр ADR-031**, а консистентная
правка после переноса блока. Делаем правку отдельным коммитом в рамках
KS-1926 implementation (см. §7 D-1).

**Что не обновляется:** план задач ADR-031 §6 — он не упоминает
mistakes отдельно (Reviews/Mistakes были как часть «daily focus»);
смежные FE-задачи рефакторинга не затрагиваются.

---

## 7. План реализации

Без оценок сроков — это зона координатора.

### 7.1 Backend

| Код | Описание | Зависит от |
|---|---|---|
| BE-1 | `git mv` файлов: `apps/api/src/lessons/mistakes.{controller,service,service.spec,module}.ts` → `apps/api/src/puzzle/`. | — |
| BE-2 | `@Controller('lessons/mistakes')` → `@Controller('puzzle/mistakes')` в `mistakes.controller.ts`. | BE-1 |
| BE-3 | Обновить `LessonsModule` (убрать `MistakesController/Service` из providers/imports) и `PuzzleModule` (добавить). | BE-1, BE-2 |
| BE-4 | Обновить вызовы `recordPuzzleMistake`/`recordGameMistake` в `PuzzleService`, `AnalysisService` — поменять импорт пути. | BE-1 |
| BE-5 | Прогнать unit + e2e тесты — проверить, что endpoint работает на новом URL. Если есть e2e на `/api/lessons/mistakes/*` — обновить URL. | BE-1..4 |

### 7.2 Frontend

| Код | Описание | Зависит от |
|---|---|---|
| FE-1 | API-клиент: переименовать пути `userCoursesApi` или `lessonsApi.getMistakeAggregates/getMistakeRecommendations` (как они сейчас называются) — на `/api/puzzle/mistakes/*`. | BE-2 |
| FE-2 | `git mv` `apps/web/src/components/lessons/MistakesDiaryBlock.tsx` → `apps/web/src/components/puzzle/MistakesDiaryBlock.tsx`. (Если в `puzzle/` нет директории — создать.) | — |
| FE-3 | `git mv` `apps/web/src/pages/MistakesPage.tsx` → `apps/web/src/pages/PuzzleMistakesPage.tsx` (опционально rename для namespacing). | — |
| FE-4 | `git mv` `apps/web/src/pages/MistakesPracticePage.tsx` → `apps/web/src/pages/PuzzleMistakesPracticePage.tsx`. | — |
| FE-5 | Удалить `MistakesDiaryBlock` из `LessonsPage.tsx`. | FE-2 |
| FE-6 | Встроить `MistakesDiaryBlock` (full) на `/puzzles/stats` (`PuzzleStatsPage.tsx`) — отдельная секция «Слабые темы» под существующими блоками stats. | FE-2 |
| FE-7 | Compact-вариант на `/puzzle` (`PuzzlePage.tsx`) — `MistakesHintCompact` компонент (1-2 темы + link). Виден только если `aggregates.length >= 1`, lazy load после first puzzle solve. | FE-1 |
| FE-8 | Routing в `App.tsx`: добавить `/puzzles/mistakes` → `PuzzleMistakesPage`, `/puzzles/mistakes-practice` → `PuzzleMistakesPracticePage`. Старые `/lessons/mistakes*` — `<Navigate replace>` на новые. | FE-3, FE-4 |
| FE-9 | i18n-ключи: переименовать namespace `lessons.mistakes.*` → `puzzle.mistakes.*` в en/ru locales. | FE-2..7 |
| FE-10 | Тесты vitest — обновить пути импортов и URL'ы redirects. | FE-1..9 |

### 7.3 Layout

| Код | Описание | Зависит от |
|---|---|---|
| L-1 | Стиль для compact-варианта `MistakesHintCompact` — отличие от full-блока (меньше, неавтономнее визуально). | FE-7 |
| L-2 | Section header на `/puzzles/stats` — если стилистика `MistakesDiaryBlock` отличается от соседних блоков stats, выровнять. | FE-6 |

### 7.4 Документация

| Код | Описание | Зависит от |
|---|---|---|
| D-1 | Обновить `docs/adr/031-lessons-lobby-redesign.md` §2.2, §5.1, §5.3 — убрать упоминание `MistakesDiaryBlock` из L2 «Daily focus». Добавить ссылку на ADR-032. Оформить как committee единым коммитом вместе с релизом. | После релиза FE-10 |

### 7.5 Что не делаем в этой задаче

- **Sidebar sub-nav для паззлов** — follow-up (см. §5).
- **Lobby `/puzzles` (вариант D)** — отдельный ADR.
- **Пользовательская документация** (`docs/features/`) — нет
  пользовательской документации по mistakes сейчас. Если появится —
  будет ссылаться на новые URL.

---

## 8. Риски и reversibility

| Риск | Митигация |
|---|---|
| Юзер с закладкой `/lessons/mistakes` теряет доступ | 301-redirect через `<Navigate replace>` сохраняет query-параметры |
| Нагрузка на `/puzzles/stats`: страница уже плотная, ещё одна секция увеличит scroll | Под full-блоком оставить место — секцию можно collapse'ить (опция); MVP — просто внизу stats |
| Compact-link на `/puzzle` нарушает focus solving | Hint показывается только после **первого решения**, лимит 1 тема, минимальные размеры; off-by-default опция доступна (если потребуется) |
| Backend rename ломает существующие e2e | BE-5 явно требует прогон e2e и обновление URL'ов в тестах |
| ADR-031 разойдётся с реальностью если D-1 забудут | D-1 в плане как обязательная часть DoD задачи |
| Переименование `lessons.mistakes.*` → `puzzle.mistakes.*` ломает существующие i18n переводы | Оба языка (en, ru) обновляются одновременно в FE-9; missing keys → fallback, не падение |

### 8.1 Reversibility

- **Откат rename URL** — git revert + восстановление redirect'а в обратную сторону. Минут 15 работы.
- **Откат места размещения** — компонент не удаляется, лишь переустанавливается на странице. Frontend-only откат.
- **Откат backend rename** — git revert одного коммита (move + decorator change). API возвращается в `/api/lessons/mistakes/*`.

---

## 9. Что точно НЕ меняется

- **Логика записи ошибок** (`recordPuzzleMistake`, `recordGameMistake`)
  — без изменений.
- **Логика агрегации тем** — без изменений.
- **Схема БД** (`Mistake` table) — без изменений.
- **`ReviewsDueBlock`** на `/lessons` — остаётся.
- **`PuzzleAttempt`, `Puzzle`, `User.ratingPuzzle`** — без изменений.
- **API контракт** (request/response shape) — без изменений, только URL
  префикс.
- **PuzzlePage solve flow** — без изменений (compact-link добавляется
  как самостоятельный компонент в footer).

---

## Приложение A. Карта изменённых путей

### URL frontend

```
/lessons/mistakes              → /puzzles/mistakes               (rename + redirect)
/lessons/mistakes-practice     → /puzzles/mistakes-practice      (rename + redirect)
```

### URL backend

```
GET /api/lessons/mistakes/aggregates       → GET /api/puzzle/mistakes/aggregates
GET /api/lessons/mistakes/recommendations  → GET /api/puzzle/mistakes/recommendations
```

### Файлы

```
apps/web/src/components/lessons/MistakesDiaryBlock.tsx → apps/web/src/components/puzzle/MistakesDiaryBlock.tsx
apps/web/src/pages/MistakesPage.tsx                    → apps/web/src/pages/PuzzleMistakesPage.tsx
apps/web/src/pages/MistakesPracticePage.tsx            → apps/web/src/pages/PuzzleMistakesPracticePage.tsx
apps/api/src/lessons/mistakes.{controller,service,*}.ts → apps/api/src/puzzle/mistakes.{controller,service,*}.ts
```

### i18n namespace

```
lessons.mistakes.*  →  puzzle.mistakes.*    (en/ru)
```

---

## Приложение B. Точки доверия

ADR опирается на:
1. Чтение `apps/web/src/App.tsx` (строки 154–198) — структура routes
   разделов puzzle/lessons.
2. `apps/api/src/lessons/mistakes.controller.ts` — текущий префикс
   `@Controller('lessons/mistakes')`.
3. ADR-031 §2.2 — позиционирование `MistakesDiaryBlock` в L2.
4. ADR-025 §2.5 — `LessonReview` как датасет SM-2 (отделяет от Mistake).

Не опирается на:
- Реальные user-метрики (нет аналитики). Решение базируется на
  семантической чистоте + UX-гипотезе. Если после релиза traffic на
  `/puzzles/stats` упадёт — пересмотр secondary-link на `/puzzle`.
