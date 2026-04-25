# ADR-031: UX-редизайн лобби `/lessons` — иерархия и современная подача

**Дата:** 2026-04-25
**Статус:** Предложено
**Задача:** KS-1921
**Связанные:**
- [ADR-026 User courses](./026-user-courses.md) — фича-родитель
- [ADR-030 Lobby latest+authors](./030-user-courses-lobby.md) — добавил блоки `LatestCoursesBlock` и `CourseAuthorsBlock` на лобби; этот ADR пересматривает их размещение
- KS-1840 — `MyCoursesBlock`
- KS-1882, KS-1884–1892 — карточки и индикаторы прохождения
- KS-1889/1890 — `EnrolledCoursesBlock`
- KS-1917 — лента и авторы
- KS-1799 — `ReviewsDueBlock`
- KS-1802 — `MistakesDiaryBlock`
- Скрин текущего состояния: `/tmp/KS-1919/desktop-lessons-full.png`, `/tmp/KS-1919/mobile-lobby.png`

---

## 1. Контекст и анализ проблемы

### 1.1 Что есть сейчас

`apps/web/src/pages/LessonsPage.tsx` рендерит блоки **последовательно
сверху вниз** в одной колонке:

1. Header — «Уроки / Структурированный курс шахмат».
2. `ReviewsDueBlock` — «К повторению сегодня».
3. `MistakesDiaryBlock` — «Дневник ошибок» (топ-5 тем).
4. `LevelGateBanner` — «Чтобы открыть уровень „Средний"».
5. `MyCoursesBlock` — «Мои курсы» с CTA «+ Создать свой курс» (KS-1840).
6. `EnrolledCoursesBlock` — «Курсы, которые я прохожу» (KS-1890).
7. `LatestCoursesBlock` — «Последние курсы» (10 карточек, KS-1917/1918).
8. `CourseAuthorsBlock` — «Авторы курсов» (12 карточек, KS-1917/1918).
9. Системные уровни — Beginner / Intermediate / Advanced.

### 1.2 Что не работает (по скрину `desktop-lessons-full.png`)

- **Иерархия отсутствует.** Все секции имеют одинаковый размер
  заголовка (h2), одинаковый межстрочный интервал, одинаковую
  плотность карточек. «Мои курсы», «Последние курсы», «Авторы курсов»,
  «Начинающий» — глаз не понимает, что важнее.
- **Длинная портянка.** ~7 экранов скролла даже у пустого юзера; у
  возвращающегося с 3+ enrolled курсами — больше 10.
- **Пустой `MyCoursesBlock` занимает гигантскую область.** На скрине
  плейсхолдер «Вы ещё не создали ни одного курса» — крупный блок с
  большим вертикальным паддингом, по визуальному весу равный реальному
  списку из 10 карточек.
- **Карточки авторов выглядят как карточки курсов.** Те же размеры,
  отступы, плотность сетки — глаз сначала не отличает «12 авторов» от
  «12 курсов».
- **`LevelGateBanner` подаётся текстом-маркером**, а не визуально
  отдельной карточкой — теряется на фоне.
- **Системные курсы внизу.** Новичок, пришедший «начать обучение»,
  видит сначала «Мои курсы» (которые у него пусты), потом «Последние
  курсы» от других, и только в конце — то, с чего объективно нужно
  начинать (Beginner).
- **На мобильном (`mobile-lobby.png`) тот же контент в один столбик** —
  ещё длиннее, без какого-либо breakdown'а; нет компактных
  representations для второстепенных секций.
- **Визуально устарело.** Нет акцентного цвета на CTA, нет глубины
  (всё плоско, без elevation/shadow), нет hero-области, нет
  визуального контраста между «main flow» и «discovery» — всё в
  одном «стопке карточек».

### 1.3 Это не баги, это рост

Каждый блок добавлялся отдельной задачей и был прав в своих рамках.
Накопительный эффект — экспоненциальное усложнение — это нормальный
эволюционный путь lobby-страниц. ADR-031 решает накопленную проблему,
а не «исправляет ошибку».

---

## 2. Иерархия информации

### 2.1 Целевые персоны и их приоритеты

| Персона | Что хочет от `/lessons` | Главное действие |
|---|---|---|
| **P1: Возвращающийся студент** (большинство DAU) | Продолжить с того, где остановился | «Continue last lesson» |
| **P2: Новый авторизованный юзер** (без прогресса) | Понять с чего начать | Найти Beginner / Discover |
| **P3: Гость** (не авторизован) | Посмотреть, что предлагается | Зарегистрироваться, посмотреть Beginner |
| **P4: Автор курсов** | Проверить свои курсы / метрики, идти в редактор | «My courses» с stats |

### 2.2 Иерархия блоков

В порядке приоритета на главной:

| Уровень | Блок | Для кого | Видимость |
|---|---|---|---|
| **L1 — Hero** | Continue learning / Start journey / Author summary | Контекстный (P1/P2/P3/P4) | Всегда |
| **L2 — Personal flow** | `MyCoursesBlock`, `EnrolledCoursesBlock` | P1, P4 | Только если есть содержимое |
| **L2 — Daily focus** | `ReviewsDueBlock`, `MistakesDiaryBlock` | P1 | Только если есть содержимое |
| **L3 — Curriculum** | Системные уровни (Beginner / Intermediate / Advanced) с `LevelGateBanner` встроенным как состояние | Все | Всегда |
| **L4 — Discovery (compact)** | Compact strip «Latest from community» + ссылка на discovery | P1, P2, P4 | Свёрнуто на главной |
| **L4 — Discovery (full)** | Full `LatestCoursesBlock`, `CourseAuthorsBlock` | Активно ищущие | На отдельной странице `/lessons/discover` |

**Принцип:** на главной — то, что нужно **большинству юзеров для
быстрого продолжения обучения**. Discovery-блоки сжимаем в ленту-strip
и выносим полные версии на отдельную страницу.

---

## 3. Структура страниц — выбор

Рассмотрены варианты A/B/C/D из задачи.

### 3.1 Принимаем вариант — **гибрид A+B**

- `/lessons` — main flow: Hero + Personal + Daily focus + Curriculum +
  compact «Latest from community» strip.
- `/lessons/discover` — full discovery: Latest courses (полная сетка) +
  Course authors (полная сетка) + future filters/search.

### 3.2 Почему не чистый A (всё на одной странице с иерархией)

Чистый A решает иерархию через размер/цвет, но **не решает «портянку»**.
12 карточек авторов всегда занимают 2 ряда даже после визуальных
улучшений. Mobile-эффект не уйдёт — горизонтальный strip компактнее, но
не делает blочка маленьким.

### 3.3 Почему не чистый B (полный split на 2 страницы)

P2 (новый юзер) не сразу поймёт, что есть community-контент. Главная
без discovery-намёка снижает discoverability. Compact-strip на главной с
ссылкой на full-страницу — компромисс: discovery виден, но не доминирует.

### 3.4 Почему не C (tabs)

- На lobby tabs — **антипаттерн**: главная задача lobby — показать **что
  важно сейчас** через визуальную иерархию, а не дать юзеру выбирать
  «что я хочу увидеть». Tabs скрывают контент за кликом и **прячут
  иерархию**.
- На мобильном tabs неудобны (свайп внутри страницы конфликтует со
  свайпом навигации).
- В наших uses cases юзер хочет «увидеть и continue learning, и есть ли
  что-то новое в community» — это два таба, между которыми придётся
  скакать. На одной странице с compact-strip — всё видно сразу.

### 3.5 Почему не D (что-то ещё, например drawer/modal)

Drawer/modal для discovery — нагрузка на mental model: «всё лобби — на
главной, а часть — в выезжающем drawer'е». Просто отдельная страница
`/lessons/discover` понятнее, индексируется поисковиками, имеет URL для
шеринга.

---

## 4. UX-паттерны (3 ключевых под наш контекст)

Из списка из задачи выбираю **три**, которые наибольше решают
конкретно нашу проблему. Остальные либо вне зоны архитектора (стили,
анимации), либо вне MVP (recommendations).

### 4.1 Контекстный hero

**Проблема:** сейчас вверху страницы — мелкий `LevelGateBanner`
текстом. Главного CTA нет; юзер не понимает, что делать.

**Решение:** **`LessonsHero`** — крупный блок наверху страницы,
адаптивный к состоянию юзера:

| Состояние юзера | Содержимое hero |
|---|---|
| **P1** Есть активный прогресс (enrolled или системный) | `Continue: <course> — <lesson>` + прогресс-бар + CTA «▶ Continue» |
| **P2** Новый авторизованный, без прогресса | `Welcome! Start with chess basics` + краткий list (Beginner level overview) + CTA «Start beginner course» |
| **P3** Гость | `Learn chess with structured courses` + CTA «Sign up» / «Browse Beginner» |
| **P4** Автор без активного прогресса | `You manage <N> courses · <M> students enrolled` + CTA «My courses» (anchor scroll) |

**Логика выбора состояния** (на FE, `useLessonsHeroContext`):
1. Если есть `enrolled` курсы — показать самый свежий по
   `lastActivityAt`.
2. Иначе — самый свежий незавершённый системный курс из
   `userLessonProgress`.
3. Иначе — если у юзера ≥ 1 публичный авторский курс (P4) — author
   summary.
4. Иначе — onboarding для P2.
5. Гость — public hero для P3.

**API:** новых endpoint'ов не нужно. Frontend агрегирует:
- `userCoursesApi.listEnrolled()` (ADR-026, KS-1889) — есть
  `lastActivityAt`.
- `lessonsApi.listCourses()` — системные с `progress`.
- `userCoursesApi.list({mine: true})` — для P4.

Все эти запросы уже выполняются на странице — Hero реюзает их
результаты через React Context (`LessonsDataContext`), без дублирования
сетевых вызовов.

### 4.2 Skeleton + lazy sections

**Проблема:** сейчас каждый блок делает независимый запрос, сначала
показывается empty, потом резко flash'ит контентом — layout shifts,
дёрганый initial-load. На мобильном — particularly bad.

**Решение:**

- **Skeleton-карточки** для всех блоков выше fold (Hero, MyCourses,
  Enrolled, ReviewsDue, Mistakes). Каждый блок имеет фиксированную
  высоту skeleton'а → нет layout shift'а при загрузке.
- **Lazy mount для discovery-strip** через `IntersectionObserver`:
  компонент монтируется только когда скрол доходит до зоны видимости.
  Это снимает initial load на бесполезные для P1 запросы.
- **На `/lessons/discover`** — то же самое, верхняя секция (Latest)
  загружается eager, нижняя (Authors) — lazy.

### 4.3 Размерная иерархия карточек (S/M/L)

**Проблема:** все карточки сейчас одного размера (`.lessons-course-card`).
Это лишает иерархию визуальных отличий.

**Решение — три варианта карточки:**

| Размер | Где | Содержимое |
|---|---|---|
| **L (large)** | Hero «Continue» | Mini-board preview + course title + lesson title + progress bar + 2 CTA |
| **M (medium)** | `MyCoursesBlock`, `EnrolledCoursesBlock`, system levels | Title + 2 строки описания + lessonCount + бейджи (Public/Pass/Stats) |
| **S (small)** | `LatestStrip` (на main) | Title + author + lessonCount, 1 строка |

Авторские карточки — **отдельный визуальный язык** (avatar-driven, не
text-driven), не путаются с карточками курсов.

### 4.4 Что НЕ берём в скоуп ADR-031

- **Animated transitions / hover micro-interactions** — зона
  layout-агента. Архитектура их не требует, упоминаем как направление.
- **Dark backgrounds / gradients** — стилистика, layout-зона.
- **Persistent search** — отдельная фича (вне MVP).
- **Recommendations** («Recommended courses based on your level») —
  отдельная задача, требует отдельного дизайна и сигнала о качестве
  курса. В hero для P2 даём **детерминированный** «Start with
  Beginner», без рекомендатора.
- **Tabs / drawer** — отвергнуты в §3.

---

## 5. Wireframe

### 5.1 Desktop `/lessons` (после редизайна)

```
┌─ /lessons ───────────────────────────────────────────────────────────┐
│                                                                       │
│  ╔═══════════════════════ HERO ═════════════════════════════════════╗ │
│  ║                                                                   ║ │
│  ║   ┌─────────────┐    Welcome back, @student                      ║ │
│  ║   │             │    Continue: Beginner — King and pawn endgames ║ │
│  ║   │   board     │    Lesson 5 of 8 · 3 of 7 steps complete       ║ │
│  ║   │   preview   │    ▓▓▓▓▓░░░ 43%                                 ║ │
│  ║   │             │                                                  ║ │
│  ║   └─────────────┘    [▶ Continue lesson]   [Browse community →]  ║ │
│  ║                                                                   ║ │
│  ╚═══════════════════════════════════════════════════════════════════╝ │
│                                                                       │
│  ┌─ Reviews due ────────┐ ┌─ Mistakes diary ──────────────────────┐ │
│  │ • Lesson 3 · 2d late │ │ pin (12) · fork (8) · skewer (6)      │ │
│  │ • Lesson 7 · today   │ │ → /lessons/mistakes                    │ │
│  └──────────────────────┘ └────────────────────────────────────────┘ │
│                                                                       │
│  ┌─ My courses (3)                          [+ New course]        ─┐ │
│  │  [m-card]  [m-card]  [m-card]                                     │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─ Continuing (4)                                                ─┐ │
│  │  [m-card]  [m-card]  [m-card]  [m-card]                           │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─ Curriculum ─────────────────────────────────────────────────────┐│
│  │                                                                   ││
│  │  Beginner ━━━━━ unlocked    Intermediate ─ ─ ─ locked            ││
│  │  [m-card] [m-card] [m-card]   gate: 0 lessons left,               ││
│  │                               6 games to play                     ││
│  │  Advanced ─ ─ ─ locked                                           ││
│  │  unlocks after Intermediate                                       ││
│  └───────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  ┌─ ✦ New from community                       [Browse all →] ────┐ │
│  │  [s-card]  [s-card]  [s-card]  [s-card]                           │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### 5.2 Desktop `/lessons/discover`

```
┌─ /lessons/discover ──────────────────────────────────────────────────┐
│                                                                       │
│  Discover community courses                              [← Back]    │
│                                                                       │
│  ─ Latest courses ─────────────────────────────────────────────────  │
│                                                                       │
│  [m-card] [m-card] [m-card] [m-card]                                  │
│  [m-card] [m-card] [m-card] [m-card]                                  │
│  [m-card] [m-card]                              [Load more]            │
│                                                                       │
│  ─ Course authors ──────────────────────────────────────────────────  │
│                                                                       │
│  [author] [author] [author] [author] [author] [author]                │
│  [author] [author] [author] [author] [author] [author]                │
│                                                  [All authors →]      │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

«All authors →» ведёт на `/players?tab=authors` (ADR-030).

### 5.3 Mobile `/lessons`

```
┌─ /lessons (mobile) ────┐
│                          │
│  ╔══ HERO ════════════╗ │
│  ║ Welcome back        ║ │
│  ║ Continue:           ║ │
│  ║ <course> · <lesson> ║ │
│  ║ ▓▓▓░░ 43%          ║ │
│  ║ [▶ Continue]        ║ │
│  ║ [Browse community]  ║ │
│  ╚════════════════════╝ │
│                          │
│  Reviews due (2)         │
│  • Lesson 3 · 2d late    │
│  • Lesson 7 · today      │
│                          │
│  Mistakes diary          │
│  pin · fork · skewer     │
│                          │
│  My courses (3)          │
│  ╶◀ horizontal scroll ▶╴│
│  [m-card][m-card][m-card]│
│                          │
│  Continuing (4)          │
│  ╶◀ horizontal scroll ▶╴│
│  [m-card][m-card][m-card]│
│                          │
│  Curriculum              │
│  ┌──────────────────┐    │
│  │ Beginner [open]  │    │
│  │ [m-card][m-card] │    │
│  └──────────────────┘    │
│  ┌──────────────────┐    │
│  │ Intermediate     │    │
│  │ Locked           │    │
│  │ 0 lessons · 6 g  │    │
│  └──────────────────┘    │
│  ┌──────────────────┐    │
│  │ Advanced  Locked │    │
│  └──────────────────┘    │
│                          │
│  ✦ New from community    │
│  ╶◀ horizontal scroll ▶╴│
│  [s-card][s-card][s-card]│
│  [Browse all →]          │
└──────────────────────────┘
```

Принцип mobile: **secondary секции (My/Continuing/New) — горизонтальный
scroll**, не stack. Это резко снижает суммарную высоту страницы.
Curriculum остаётся вертикальным (это «main offer»).

### 5.4 Mobile `/lessons/discover`

Простой стек: тулбар «Latest / Authors» (sticky) + secondary scroll
секции. Без радикальных отличий от текущего mobile.

---

## 6. План реализации

Без оценок сроков — это зона координатора.

### 6.1 Frontend

| Код | Описание | Зависит от |
|---|---|---|
| FE-1 | `LessonsHero` компонент с 5 состояниями (P1/P2/P3/P4 + loading skeleton). Контекст-провайдер для общих данных. | — |
| FE-2 | `useLessonsHeroContext` хук — агрегация `enrolled` + system progress + my courses, выбор состояния. Без новых endpoints. | FE-1 |
| FE-3 | Рефакторинг `LessonsPage.tsx` — новая структура секций (см. §5.1), удалить inline-тексты `LevelGateBanner` (мигрирует в Curriculum-секцию как состояние карточки уровня), вынести Latest+Authors с этой страницы. | FE-1, FE-2 |
| FE-4 | Новая страница `LessonsDiscoverPage` (`/lessons/discover`) — переиспользует существующие `LatestCoursesBlock` и `CourseAuthorsBlock` (KS-1917/1918), добавляет header. | — |
| FE-5 | `LatestCoursesStrip` (compact 4-card variant) — компактный strip для main, отличается от full `LatestCoursesBlock` (на discover). | — |
| FE-6 | `CurriculumSection` — обёртка для системных уровней с встроенным состоянием `LevelGateBanner` (карточка уровня показывает свой gate-state). | FE-3 |
| FE-7 | Skeleton-варианты всех блоков (фиксированные размеры, opacity-pulse animation в CSS — реализуется в Layout). | FE-1, FE-3, FE-5, FE-6 |
| FE-8 | Lazy mount для `LatestCoursesStrip` через `IntersectionObserver`. | FE-5 |
| FE-9 | i18n-ключи `lessons.hero.*`, `lessons.curriculum.title`, `lessons.discover.title/back`, `lessons.community.strip.title/browseAll` в en/ru. | FE-1, FE-3, FE-4, FE-5 |
| FE-10 | Routing: добавить `/lessons/discover` в `App.tsx`. | FE-4 |
| FE-11 | Тесты vitest: рендер 5 состояний Hero, рефакторинг `LessonsPage`-теста, страницы Discover. | FE-1..FE-10 |

### 6.2 Layout

| Код | Описание | Зависит от |
|---|---|---|
| L-1 | Hero-секция стилистика (large card with depth/elevation, gradient, large typography). | FE-1 |
| L-2 | Three card sizes (S/M/L) — общие переменные размеров и стили. | FE-3 |
| L-3 | `Curriculum` визуальный «pillar» — заголовок-разделитель, цветовые акценты для unlocked/locked. | FE-6 |
| L-4 | Mobile horizontal scroll strips для My/Continuing/Latest на главной. | FE-3, FE-5 |
| L-5 | Skeleton CSS animations (`@keyframes pulse`). | FE-7 |
| L-6 | Hover micro-interactions на карточках (subtle elevation на hover, чёткое active-state). | FE-3 |
| L-7 | Responsive breakpoints для hero (mobile-first stack vs desktop side-by-side). | FE-1 |

### 6.3 Backend

**Ничего не меняем.** Все данные доступны через существующие endpoints
(ADR-026 §2.5, ADR-030 §3, KS-1889, KS-1914, KS-1918). Никаких новых
схем БД, новых полей DTO.

### 6.4 Документация

| Код | Описание | Зависит от |
|---|---|---|
| D-1 | Обновить `docs/features/user-courses.md` (RU + EN) §2 «Главная страница „Уроки"» — описать новую структуру (Hero + main flow + Curriculum + community strip + Discover page). | После релиза FE-11 |

---

## 7. Риски и trade-off'ы

### 7.1 Риски выбранного подхода

| Риск | Митигация |
|---|---|
| Разработчик усложняет логику `useLessonsHeroContext` (5 состояний) | Чёткий приоритетный switch (см. §4.1), unit-тесты на каждое состояние |
| `IntersectionObserver` для lazy mount — несовместимость со старыми браузерами | Поддержка IE/старые браузеры не цель; современные all-in |
| Layout shift при загрузке — skeleton фиксирует размер блока, реальный контент может отличаться (например, описание курса длиннее) | Skeleton с min-height, content overflow-hidden для предсказуемого layout |
| Discovery (compact strip) на главной не дотягивается scroll'ом — юзер не увидит ленту | Lazy-mount через IntersectionObserver с подгрузкой при appearance в viewport; визуально strip всё равно ниже Curriculum, видим при дополнительном scroll'е |
| Новый юзер (P2) сразу нажмёт «Browse community» из hero и не увидит Curriculum | CTA в hero для P2 — `Start beginner course` напрямую (не «Browse community»). «Browse community →» — secondary link для P2 |
| Перенос Latest/Authors на отдельную страницу `/lessons/discover` снижает discovery | Compact strip + ссылка на главной, ссылка с явным CTA «Browse all» |
| Refactor `LessonsPage.tsx` ломает существующие e2e-тесты | Перепрогон e2e после FE-11; обновление test-id'ов в одном месте |

### 7.2 Что отбрасываем

- **Полный split** на отдельные страницы для каждого блока — лишняя
  навигация без выгоды.
- **Tabs-based** — антипаттерн на lobby, скрывает иерархию.
- **Custom search/recommendations** — вне MVP, нужны отдельные дизайны.
- **Animated transitions** — зона layout, не блокирует архитектуру.
- **Dark mode / gradients** — зона layout, не блокирует архитектуру.

### 7.3 Reversibility

- **`/lessons/discover` → откат на главную:** если страница окажется
  непопулярной (низкий traffic), можно вернуть `LatestCoursesBlock` и
  `CourseAuthorsBlock` обратно на `/lessons` под Curriculum'ом —
  компоненты остаются переиспользуемыми, разница в их размещении на
  странице.
- **Hero-секция → fallback на header:** если `useLessonsHeroContext`
  не определит состояние (загрузка, ошибки) — рендерится header
  старого вида (`<h1>Lessons</h1>`).
- **Skeleton states:** если skeleton окажется визуально хуже, чем
  старый «mini-loader», feature-флагуется и откатывается.

---

## 8. Метрики успеха (для будущей оценки)

Задача архитектора — проектировать измеряемое решение. Для будущей
ретроспективы эффективности редизайна предлагаются метрики (фактический
сбор — отдельная задача аналитики / marketing-агента):

| Метрика | Текущее состояние (baseline) | Цель |
|---|---|---|
| Bounce rate на `/lessons` (P1 возвращающиеся) | TBD — нужно измерить до релиза | Снизить |
| Click-through на «Continue lesson» из hero | 0% (нет hero) | > 50% от P1 |
| Скролл-глубина на `/lessons` | Среднее ~7 экранов | < 3 экрана medium percentile |
| Trafic на `/lessons/discover` | 0 (страницы нет) | TBD — измерим после релиза |
| Time-to-first-meaningful-action на `/lessons` | TBD | Снизить |

Эти метрики **не блокируют выкатку** ADR — это критерии для решения
«удался ли редизайн через 2-4 недели после релиза».

---

## 9. Что точно НЕ меняется

- **Backend контракты** (ADR-026 §2.5, KS-1889/1914/1918) — без
  изменений.
- **Архитектура user-courses** (модели, прогресс, threshold, etc.) —
  без изменений.
- **`LessonEditorPage` (системные курсы, /lessons/editor)** — не
  затрагиваем, это редактор админа.
- **`/lessons/my/:slug/edit` (редактор пользовательских курсов)** —
  не затрагиваем.
- **`/lessons/my/:slug` и `/lessons/my/:slug/:lessonId` (страницы
  прохождения)** — не затрагиваем.
- **`MyCoursesBlock`, `EnrolledCoursesBlock`, `ReviewsDueBlock`,
  `MistakesDiaryBlock`** — переиспользуем как есть, меняем только
  размещение на странице.
- **`LatestCoursesBlock`, `CourseAuthorsBlock`** — переиспользуем как
  full-варианты на `/lessons/discover`. На главной добавляется новый
  компонент `LatestCoursesStrip` (compact-вариант).

---

## Приложение A. Точки доверия

ADR опирается на:
1. Скрин `/tmp/KS-1919/desktop-lessons-full.png` — визуальное
   подтверждение проблемы «портянка без иерархии».
2. Скрин `/tmp/KS-1919/mobile-lobby.png` — мобильный вариант,
   подтверждает необходимость mobile-first.
3. Существующий контракт `EnrolledCoursesBlock` в коде — `lastActivityAt`
   на `UserCoursePlayProgress`, что даёт основу для контекстного hero.
4. `LessonsPage.tsx` — текущее состояние страницы, обоснование
   рефакторинга.
5. ADR-026 §2.5 (API) и ADR-030 §3 (новые endpoints) — шейпы данных
   подтверждают, что `useLessonsHeroContext` собирается из существующих
   запросов.

ADR не опирается на:
- Аналитические данные о реальном поведении юзеров (их сейчас нет).
  При появлении — пересмотр приоритетов в иерархии (§2.2) возможен без
  переписывания структуры.
