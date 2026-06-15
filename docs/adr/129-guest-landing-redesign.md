# ADR-129 — Редизайн гостевого лендинга `FeaturesPage` (`/` для гостя)

- Статус: **Proposed** (2026-06-15)
- Задача: KS-4154
- Связанные ADR / задачи:
  - ADR-128 — политика публичных маршрутов; гостевой `/` уже отдаёт
    `<FeaturesPage variant="home" />`, маршрутизация в этом ADR
    не пересматривается.
  - KS-4116 / KS-4117 — prerender + CloudFront-маппинг (`/`
    индексируется ботами как реальный HTML, не SPA-скелет).
  - KS-4144 — клиентская партия гостя с ботом (`/play/local-bot`,
    Stockfish WASM, без backend) — используется как primary CTA
    (см. §6).
  - KS-4104 — кнопка YouTube-канала в подвале (текущая, сохраняется).
- Авторы: architect.

---

## 1. Контекст и проблема

Гость, открывая `kingside.site/`, видит компонент `FeaturesPage`
(`apps/web/src/pages/FeaturesPage.tsx`) в режиме `variant='home'`
(см. `App.tsx:351-356`, функция `HomePage`). Маршрутизация работает
корректно: авторизованный пользователь перенаправляется на `/play`,
гость остаётся на лендинге.

Сам лендинг — плохой. Структурно это **гид по фичам с длинными how-to
инструкциями**, а не маркетинговая страница. Что выходит на экран:

1. **Hero** — h1 «Play chess. Analyze. Improve.» Это общие слова,
   ничем не отличающие Kingside от Chess.com, Lichess, Chessable и
   любого другого шахматного сайта. Подзаголовок — «User Guide».
   Подзаголовок «User Guide» на главной странице сразу даёт гостю
   понять: это документация, а не продукт.
2. **Секция «Menu reorganized (May 2026)»** — changelog по навигации.
   Бесполезный гостю мусор, ниже Hero съедает первый экран после
   скролла.
3. **Quick links** — 5 иконок-плиток (Play, Puzzles, Analysis,
   Broadcasts, Live Games). Полезно, но не объясняет ценность.
4. **8 секций фич** (`features.{play,analyze,puzzles,workshop,
   broadcasts,social,customize,rating}`) — каждая с полем `.guide`,
   которое содержит пошаговую инструкцию по 10–30 строк
   (см. i18n-снимок в §11). Это документация продукта, развёрнутая
   на главной. Гостю, который ещё не понимает, нужен ли ему сервис,
   читать инструкцию по PGN-import'у бессмысленно.
5. **CTA-footer** — призыв «Create free account» + кнопка YouTube.
   После 8 простыней инструкций гость до этого блока, скорее всего,
   не дочитал.
6. **Социального доказательства нет** — ни счётчиков, ни упоминаний
   уникальных фич, ни отзывов.

Кнопка primary-CTA в Hero сейчас ведёт `<Link to="/register">`. Это
**barrier-CTA**: гость, ещё не понимающий, что за сервис, обязан
заполнить форму регистрации, чтобы хоть что-то попробовать.

Цель этого ADR — спроектировать новую структуру содержания
`FeaturesPage` (компонент тот же, маршрут тот же), которая:

- объясняет за один экран чем Kingside отличается;
- даёт гостю **сделать что-то на сайте за один клик без регистрации**
  (frictionless-CTA);
- показывает живые цифры платформы вместо changelog'а навигации;
- выбрасывает развёрнутую документацию (её место — на `/features`
  как отдельной странице, либо в `/help/*`).

ADR **не пишет код**, **не дизайнит экран в Figma**, **не пишет
финальные тексты** — кодифицирует структуру, контракт CTA, SEO,
i18n-ключи и декомпозицию на тикеты.

---

## 2. Аудит текущего `FeaturesPage`

Источник — `apps/web/src/pages/FeaturesPage.tsx:37-179`. По блокам:

| Блок | Файл / строки | Решение |
|---|---|---|
| Hero (h1 + subtitle + 2 кнопки) | `:39-47` | Переписать содержательно (§5.1). Кнопки заменить (§6). |
| Section #navigation (changelog меню май 2026) | `:53-103` | **Удалить.** Якорь `#navigation` (под ссылку из старого `NavOnboardingTooltip`, KS-2814) больше не используется — `<NavOnboardingTooltip>` сам исчез в KS-3070 (см. комментарий `:49-52`). На лендинге это место занимает changelog внутренней навигации — гостю он не нужен. |
| Quick links (5 плиток) | `:106-129` | Удалить как отдельный блок. Релевантные ссылки переехать в Hero (вторичный ряд) и в блок «Что есть на платформе» (§5.2). Существование отдельного «грид быстрых ссылок» противоречит идее одного primary-CTA. |
| 8 секций `.guide` | `:132-146` | **Удалить с лендинга.** Развёрнутые how-to оставить как контент страницы `/features` — она остаётся отдельным маршрутом (`App.tsx:476`) и предназначена ровно для этого. См. §3.2. На лендинг ставится компактный блок «Что есть на платформе» (§5.3) — 5 карточек с одним предложением каждая. |
| CTA-footer (h2 + Register + YouTube) | `:149-177` | Сохранить структурно, переписать тексты (§5.6). YouTube-кнопка остаётся (KS-4104). |

**Итог**: из 6 блоков 2 удаляем целиком, 1 (Hero) переписываем,
2 (quick links, guides) переносим / убираем, 1 (CTA-footer) — переписываем
тексты.

---

## 3. Разделение `/` и `/features`

### 3.1. `/` (гостевой лендинг) — компонент `FeaturesPage` с `variant='home'`

Новая структура (§5):

1. Hero.
2. Уникальное позиционирование (1–2 пункта УТП).
3. Что есть на платформе (компактные карточки).
4. Социальное доказательство.
5. Призыв к регистрации.
6. Подвал.

Без `.guide`-секций и без changelog'а навигации.

### 3.2. `/features` — компонент `FeaturesPage` с `variant='features'`

Текущая страница как Help-каталог. Оставить **существующие 8 секций
с `.guide`** — это полезная документация, просто не на главной.
Hero меняется на «Features» / «Everything Kingside has to offer»
(уже есть в `features.page.title/subtitle`).

Маршрут уже отдельный (`App.tsx:476`), `prerender` обрабатывает
оба пути (ADR-128 §3.4). С разными h1 — каноникал-конфликт, описанный
в ADR-128 §3.4, закрывается этим ADR: `/` отдаёт лендинг с УТП,
`/features` — Help-каталог. Это разные страницы и для SEO, и для
пользователя.

### 3.3. Что НЕ меняется

- Маршрутизация в `App.tsx` (`HomePage`, `<FeaturesPage>` с
  `variant`-prop) — без изменений.
- Авторизованный пользователь по-прежнему редиректится на `/play`.
- Компонент `<FeaturesPage>` остаётся один для обоих маршрутов
  (через `variant`). Альтернатива — расщепить на `GuestLandingPage`
  + `FeaturesPage` — не нужна; `variant` уже даёт чёткое разделение
  поведения, и `FeaturesPage` уже импортируется в `App.tsx` с
  `variant='home'`. Расщепление компонента — лишняя работа без
  выигрыша.

---

## 4. Уникальное позиционирование Kingside

Гостю нужно за 5 секунд понять, что Kingside даёт такого, чего нет
на Chess.com, Lichess, Chessable. Аудит фич проекта (по ADR и коду):

### 4.1. Список потенциальных УТП (с пояснением)

| # | Фича | Где это видно в коде / ADR | Конкуренты |
|---|---|---|---|
| A | **AI-комментарии к ходам и позициям** — Maia (human-like) + Stockfish + LLM-комментарии текстом, не только цифрами | ADR-066 (WDL classification), ADR-096/097 (Maia panel), ADR-102/103 (LLM move comments MVP1/2), ADR-105 (post-processing), ADR-108 (AI position comment UX), ADR-114 (anti-hallucination) | Chess.com даёт цифры + классификацию хода. Lichess даёт цифры. AI-текст «почему ход хороший/плохой» — Kingside-only. |
| B | **Свои партии → пазлы автоматически** — импорт PGN, генерация задач из ваших ошибок | ADR-041 (tactical puzzle gen), ADR-050 (client puzzle gen unification), ADR-068/069/070 (delta-w / convert vs save / Elo filter) | На Chess.com / Lichess нельзя из своих партий сгенерировать пазлы. Только chosen learn modes. |
| C | **Stockfish 18 локально без paywall'а** — WASM в браузере + опционально свой engine через bridge для unlimited depth | `apps/web/src/workers/` + ADR-010 (browser plugin research) + кнопка «External engine» (`ExternalEngineHelpPage`) | Chess.com лимитирует depth/MultiPV за подпиской. Lichess даёт Stockfish бесплатно, но без локального WASM в браузере уровня Kingside. |
| D | **Тренажёры под анализ слабых мест** — Precision (play-vs-engine с Glicko-1), Drill Sprint, Opening Trainer (SRS), Blind board, Guess-the-move | ADR-035/044/047/048/056/077/088/093/094 | Chess.com лессоны/пазлы — есть. Drill Sprint, Opening SRS, Guess-the-move + blind board как набор — Kingside-уникально (на Chess.com часть в подписке, часть нет вообще). |
| E | **Live-трансляции с AI-комментариями** | ADR-023/110/111 (live broadcasts + viewer) | Lichess Broadcast, Chess.com TV — есть. AI-комментарии текстом на live-партиях — Kingside-only. |
| F | **Платформа тренеров** — coach pages, lectures, live + replay, чат | ADR-113/115/116/118/119/120/121 | Chessable / Chess.com похожее предлагают через partner-программы. Открытая платформа любому тренеру — Kingside-фича. |
| G | **Полностью бесплатно** | по факту — все фичи доступны без подписки | Lichess тоже бесплатный, но без AI-комментариев и без coach-платформы. Не дифференцирующий пункт сам по себе. |

### 4.2. Рекомендация — два пункта в Hero

Гость в Hero видит **2 пункта УТП** (больше — расфокусирует):

1. **«AI объясняет ходы»** (A) — главное отличие. Сильный визуальный
   образ: «не просто +1.5, а почему именно».
2. **«Тренируйся на своих партиях»** (B) — конкретная польза.
   Импорт PGN → пазлы → анализ.

Бесплатность (G) и Stockfish (C) — упомянуть текстом в одном
предложении после Hero, без отдельного hero-пункта. Тренажёры (D),
лекции (F), live (E) — в блоке «Что есть на платформе» (§5.3),
не в Hero.

### 4.3. Если маркетинг возразит

Окончательный выбор УТП — за маркетингом (KS-MK-1 в §10). Архитектор
фиксирует **рамку**: «не больше 2 пунктов в Hero, обязательно
конкретные, не «play. analyze. improve.»». Конкретный текст
формулирует маркетинг с опорой на §4.1.

---

## 5. Структура нового лендинга

Без визуального дизайна — только смысловая структура и контракт
содержания. Дизайн — задача layout (§10).

### 5.1. Блок 1 — Hero

| Что | Содержание |
|---|---|
| h1 | Лозунг (2 пункта УТП §4.2 в одной фразе или h1+h2). Примеры для маркетинга: «Шахматы с AI, который объясняет ходы», «Анализируй партии и играй с ботом без регистрации». **Финальный текст — за маркетингом (§10)**, не за архитектором. |
| подзаголовок | 1 предложение, раскрывающее h1. «User Guide» — убрать. |
| primary CTA | Кнопка «Сыграть с ботом» → `/play/local-bot` (KS-4144, frictionless, без регистрации). См. §6. |
| secondary CTA | Кнопка «Создать аккаунт» → `/register`. Visual — secondary (контурная или ghost). |
| текстовая ссылка | «Уже есть аккаунт? Войти» → `/login`. Третий уровень иерархии. |

`features-quick-links` (Play / Puzzles / Analysis / Broadcasts / Live
Games) из текущей версии удаляется — фичи отражаются в блоке 3 (§5.3),
primary-action один.

### 5.2. Блок 2 — Уникальное позиционирование

Сразу под Hero, до карточек фич. 2 пункта (§4.2) в визуально-выраженном
блоке: иконка + h3 + 1–2 предложения.

| Пункт | h3 (черновик, финал — маркетинг) | Раскрытие |
|---|---|---|
| 1 | «AI объясняет ходы» | 1–2 предложения: «Не просто +1.5, а почему. Maia + Stockfish + LLM дают понятный текстовый разбор каждого хода.» |
| 2 | «Пазлы из ваших партий» | 1–2 предложения: «Импортируй PGN — Kingside сгенерирует задачи из ваших ошибок.» |

### 5.3. Блок 3 — Что есть на платформе

5 карточек, на каждой: иконка + название + **одно** предложение.
Длинные `.guide` НЕ выводим. Источник содержания на эти карточки —
тексты от маркетинга, опираясь на текущие `features.{key}.description`
(`features.play.description`, `features.analyze.description`, и т. д. —
у них уже есть короткие, в 1–2 предложения).

| key | Текущее поле i18n | Источник короткого текста |
|---|---|---|
| `play` | `features.play.description` | «Challenge players worldwide… Play against bots (8 levels)…» — годится, сократить до 1 предложения |
| `analyze` | `features.analyze.description` | «Stockfish 18 runs in your browser…» — годится |
| `puzzles` | `features.puzzles.description` | «Solve puzzles matched to your rating… Generate custom puzzles from any PGN…» — годится, обрезать |
| `broadcasts` | `features.broadcasts.description` | «Watch top tournament games…» — годится |
| `social` | `features.social.description` | «Add friends, see who's online…» — годится |

`workshop`, `customize`, `rating` — снимать с лендинга. Workshop —
часть «analyze» по смыслу. Customize и Rating — мелочи для
маркетингового первого экрана, упоминать не нужно.

Карточка ведёт по клику на соответствующий раздел (см. §6.4) — это
заменяет `features-quick-links`.

### 5.4. Блок 4 — Социальное доказательство

| Что | Источник данных | Доступность сейчас |
|---|---|---|
| «N партий сыграно» | `total games played` — нужен счётчик в БД | **Нет публичного эндпоинта.** В рамках ADR-128 §6.8 backend имеет `GET /games/live/count` (счётчик идущих партий — годится для «Сейчас играют N»), но total — нет. Нужен новый. |
| «N задач решено» | `total puzzle attempts` | Нет публичного. Прокинуть из `puzzleAttempt` — sum. |
| «N пользователей» | `total registered` | Нет публичного. Прокинуть из `user` count. |
| «Сейчас онлайн N» | `players/online` count | **Есть** — `GET /players/online` уже public (ADR-128 §6.8.2, OK-список). Используется в Sidebar header'е. |
| «Идёт N партий» | `games/live/count` | **Есть** — open (ADR-128 §6.8.2, OK-список). |
| Отзывы пользователей | quote'ы реальных пользователей | **Нет.** Сбор — отдельная задача (KS-MK-2 в §10). До сбора блок отзывов не выводится. |

**План для блока:**

- На MVP (минимально, что можно отрендерить уже сейчас) — две живые
  цифры: «Онлайн **N**» (через `GET /players/online`) и «Идёт **N**
  партий» (через `GET /games/live/count`). Уже доступно публично без
  изменений backend.
- Для полной версии (total games, total puzzles solved, registered
  users) — отдельный публичный эндпоинт `GET /landing/stats` (новый,
  backend-задача KS-BE-1 в §10). DTO: `{ totalGames, totalPuzzlesSolved,
  registeredUsers, onlineNow, gamesInProgress }`, кэш 60 сек на Redis,
  rate-limit 60 req/min на IP по правилам ADR-128 §6.8.4.
- Отзывы — сбор маркетингом, верстка отдельно (KS-MK-2 + KS-LL-1 в §10).
  До сбора блок отзывов в DOM не выводится (не «3 пустых slot'а»,
  а полное отсутствие блока — иначе бот заиндексирует пустоту).

**Контракт фронтенда для блока:**

- Если `GET /landing/stats` 200 → отрисовать цифры.
- Если 5xx / тайм-аут → блок не рендерим (не «—» и не «0»). На бот
  показывать «0 партий» хуже, чем не показывать ничего.
- На prerender (KS-4116) — мокать `/landing/stats` пустым ответом и
  отдавать снимок без блока (или с placeholders, заменяемыми JSом —
  это решается в реализации, KS-FE-1).

### 5.5. Блок 5 — Призыв к регистрации

Повтор primary CTA из Hero. Структура та же:

- h2: «Готовы играть? Создайте бесплатный аккаунт».
- Кнопка «Создать аккаунт» → `/register`.
- Кнопка YouTube (KS-4104) — сохраняется как сейчас.

Дублирование primary-CTA в конце страницы — стандарт для лендинга,
гостю не приходится скроллить вверх после прочтения карточек.

### 5.6. Блок 6 — Подвал

Минимальный, **не путать с глобальным footer'ом сайта** (он есть в
`MainLayout`). Если в `MainLayout` уже есть footer с ссылками
(Terms, Credits, Help) — повторять не нужно. Если нет — добавить
inline-блок:

- Ссылка «Правила использования» → `/terms`.
- Ссылка «Внешний движок» → `/help/external-engine`.
- Ссылка «Открытые ассеты» → `/credits`.
- Языки — селектор уже есть в шапке (`MainLayout`); если в подвале
  нужен дубль — обсудить с layout (низкий приоритет).

Уточнение по `MainLayout` — задача layout (KS-LL-2 в §10).

---

## 6. CTA-поток

### 6.1. Primary CTA — «Сыграть с ботом» → `/play/local-bot`

Frictionless: гость кликает и через 2 секунды играет с ботом, без
регистрации. Маршрут уже существует (KS-4144, `LocalBotGamePage`).
Stockfish-WASM локально, без backend.

Это **смена** относительно текущего поведения: сейчас primary-CTA
ведёт на `/register`. Новый primary-CTA снижает барьер на одну
ступень — гость пробует продукт до создания аккаунта.

**Контракт страницы `/play/local-bot`**: уже умеет работать без
авторизации (это содержание KS-4144). На странице — inline
guest-CTA «Залогиньтесь, чтобы сохранить статистику» (паттерн A
ADR-128 §6.1). После партии — модалка «Хотите сохранить результат?»
(паттерн B ADR-128 §6.2) **не вводится** в рамках этого ADR;
если решат вводить — отдельная задача.

### 6.2. Secondary CTA — «Создать аккаунт» → `/register`

Текущее поведение. На странице `/register` после успешной
регистрации редирект на `/play` (стандартный).

### 6.3. Третий уровень — «Войти» → `/login`

Текстовая ссылка под кнопками. `GuestRoute` уже обрабатывает
автологина (`App.tsx:291-302`).

### 6.4. Карточки фич (Блок 3) — ссылки на разделы

| Карточка | Куда ведёт | Что увидит гость |
|---|---|---|
| Play | `/play` | Лобби (PF по ADR-128 §4.2): выбор time-control, играть с ботом. Online matchmaking — модалка логина. |
| Analyze | `/workshop` (либо `/analysis`) | Workshop с Stockfish-WASM, локально (PF). |
| Puzzles | `/puzzles` | Каталог задач (PF). Решает локально, прогресс не сохраняется. |
| Broadcasts | `/broadcasts` | Список live-турниров (PR). |
| Social | `/players` | Лидерборд (PR). |

Все целевые маршруты — публичные по ADR-128. У гостя по клику открыт
функционал.

### 6.5. Что НЕ делает CTA

- Не открывает inline-форму логина прямо на лендинге.
- Не делает «продолжить как гость» — это уже сделано через
  `/play/local-bot` как primary CTA.
- Не делает modal-overlay поверх лендинга — все navigations.

---

## 7. SEO

### 7.1. `<title>`

Per language. Через `react-helmet` / `<title>` управляется в самом
`FeaturesPage` (текущий компонент не ставит title — это сейчас
ставится prerender'ом или дефолтным `index.html`; проверить и
выставить явно).

| variant | en | ru |
|---|---|---|
| `home` | `Kingside — Play chess with AI move commentary` | `Kingside — Шахматы с AI-комментариями ходов` |
| `features` | `Features — Kingside` | `Возможности — Kingside` |

Финальные тексты — задача маркетинга (KS-MK-3 в §10).

### 7.2. `<meta name="description">`

160 символов, бенефит + ключевое слово.

| variant | Шаблон |
|---|---|
| `home` | «Играй в шахматы онлайн. AI разбирает каждый ход словами. Пазлы из своих партий. Бесплатно, без подписки.» |
| `features` | «Все возможности Kingside: игра онлайн, анализ Stockfish, пазлы, тренажёры, лекции тренеров, трансляции.» |

### 7.3. Open Graph / Twitter Cards

```
og:type = website
og:url = https://kingside.site/
og:title = (= <title>)
og:description = (= meta description)
og:image = https://kingside.site/og/landing-{lang}.png   (1200×630, бренд + позиционирование)
og:locale = en_US / ru_RU
og:locale:alternate = ru_RU / en_US

twitter:card = summary_large_image
twitter:title = (= og:title)
twitter:description = (= og:description)
twitter:image = (= og:image)
```

OG-картинки — задача content (KS-CT-1 в §10). До их появления —
fallback на текущую `/og-default.png` (если есть; иначе пустой
og:image — это допустимо, не критично для индексации).

### 7.4. H1 и H2

| h1 | h2 |
|---|---|
| **Один** на странице — в Hero (лозунг УТП) | Заголовки блоков 2–6 (§5.2–§5.6) |

H1 на `/` ≠ H1 на `/features` (см. §3.2) — каноникал-конфликт
ADR-128 §3.4 закрывается.

### 7.5. JSON-LD

Структурированные данные в `<script type="application/ld+json">`
для богатых сниппетов:

```jsonc
// WebSite — для sitelinks-search-box в Google
{ "@context": "https://schema.org", "@type": "WebSite",
  "url": "https://kingside.site/", "name": "Kingside",
  "potentialAction": { "@type": "SearchAction",
    "target": "https://kingside.site/players?search={query}",
    "query-input": "required name=query" } }

// Organization — для knowledge panel
{ "@context": "https://schema.org", "@type": "Organization",
  "url": "https://kingside.site/", "name": "Kingside",
  "logo": "https://kingside.site/logo.png",
  "sameAs": ["https://www.youtube.com/@kingside_site"] }
```

### 7.6. `<link rel="canonical">` и `hreflang`

```
<link rel="canonical" href="https://kingside.site/" />
<link rel="alternate" hreflang="en" href="https://kingside.site/?lang=en" />
<link rel="alternate" hreflang="ru" href="https://kingside.site/?lang=ru" />
<link rel="alternate" hreflang="x-default" href="https://kingside.site/" />
```

Текущая SPA-стратегия языков — через i18next в localStorage + `?lang=`
query. Если в проекте сейчас языки в pathname (`/ru/`, `/en/`) — этот
блок пересматривается под фактическую схему URL (frontend KS-FE-2 в §10
сверяет факт с настройкой i18next).

### 7.7. Ключевые слова (для текстов маркетингу)

Релевантные русскоязычные:
«играть в шахматы», «онлайн шахматы», «шахматы с AI», «анализ партий»,
«разбор партии», «шахматные задачи», «пазлы из своих партий»,
«играть с ботом», «бесплатные шахматы», «Stockfish онлайн».

Английские: «play chess online», «chess AI commentary»,
«chess analysis with explanations», «chess puzzles from own games»,
«stockfish in browser», «play chess vs bot», «free chess platform».

Использование — в `<meta description>`, в h1/h2, в alt-картинок,
в первых предложениях карточек. Не насиловать — естественно
вписать. Финальное распределение — маркетинг (KS-MK-3 в §10).

### 7.8. `noindex` / `nofollow`

Не использовать. `/` индексируется как primary-страница.
`/features` — индексируется отдельно с собственным h1 (см. §3.2).

---

## 8. Многоязычность (i18next)

### 8.1. Что менять в i18n

В текущем `apps/web/src/i18n/locales/{en,ru}/translation.json` есть
ветка `features.*` со следующими подузлами:

- `features.navigation.*` (changelog меню май 2026) — **удалить**.
- `features.hero.{title,subtitle,ctaPlay,ctaLearn}` — переписать
  тексты под новый лендинг. Структуру ключей сохранить, чтобы не
  ломать `variant='home'` логику в компоненте.
- `features.page.{title,subtitle}` — сохранить (`/features` тоже
  меняет h1, но текст «Features» / «Everything Kingside has to offer»
  можно переформулировать; маркетингу решить).
- `features.{play,analyze,puzzles,workshop,broadcasts,social,
  customize,rating}.{title,description,guide}` — сохранить как есть,
  они используются на `/features` (Help-каталог).
- На лендинге `/` карточки фич (Блок 3, §5.3) используют **только**
  `features.{key}.title` и `features.{key}.description` — `guide`
  не зовётся (компонент в режиме `variant='home'` его не
  рендерит).
- `features.cta.{title,button,youtube}` — сохранить, переписать
  тексты под новый Hero-tone.

### 8.2. Новые ключи (если нужно)

Если маркетинг решит вынести «уникальное позиционирование» (Блок 2,
§5.2) под отдельную ветку — добавить:

```
features.usp.title           // h2 блока
features.usp.point1.title    // «AI объясняет ходы»
features.usp.point1.text     // 1–2 предложения
features.usp.point2.title    // «Пазлы из ваших партий»
features.usp.point2.text     // 1–2 предложения
```

Если социальное доказательство (Блок 4, §5.4) выносится — ключи:

```
features.social.online       // «Online: {{count}}»
features.social.gamesInProgress  // «Games in progress: {{count}}»
features.social.totalGames   // «Played: {{count, number}} games»
features.social.totalUsers   // «{{count, number}} chess players»
features.social.totalPuzzles // «{{count, number}} puzzles solved»
```

Ключ `features.social` уже занят (`Community` секцией §5.3) —
**конфликт**. Переименовать новый namespace в `features.proof.*`
или `landing.proof.*`. Рекомендация: использовать `landing.proof.*`
(новый namespace для лендинг-блоков, не пересекается с существующим
`features.*`).

### 8.3. Полный набор новых ключей (свод для frontend)

```
landing.hero.title           // h1
landing.hero.subtitle        // подзаголовок
landing.hero.ctaPlay         // «Play vs bot» (primary)
landing.hero.ctaRegister     // «Create free account» (secondary)
landing.hero.ctaLogin        // «Sign in» (text link)

landing.usp.point1.title
landing.usp.point1.text
landing.usp.point2.title
landing.usp.point2.text

landing.cards.title          // h2 блока «What's on Kingside»
landing.cards.play           // короткое описание Play (1 предложение)
landing.cards.analyze        // Analyze
landing.cards.puzzles        // Puzzles
landing.cards.broadcasts     // Broadcasts
landing.cards.social         // Community

landing.proof.title          // h2 блока «Real numbers»
landing.proof.online
landing.proof.gamesInProgress
landing.proof.totalGames
landing.proof.totalUsers
landing.proof.totalPuzzles

landing.cta.title            // h2 финального призыва
landing.cta.button           // «Create free account»

landing.seo.title            // <title> для variant='home'
landing.seo.description      // <meta description> для variant='home'
```

Существующие `features.navigation.*` — удалить целиком из обоих
языковых файлов.

### 8.4. Что с текущим `features.hero.*`

Если компонент после редизайна перестаёт обращаться к
`features.hero.*` (вместо них `landing.hero.*`) — старые ключи
удалить. Если в компоненте оставлены оба варианта (по `variant`) —
ключи `features.hero.*` остаются для `/features` (там Hero тоже
есть, h1 «Features»). Решение — фронтенд при реализации (KS-FE-1).

---

## 9. Что НЕ входит в этот ADR

- Визуальный дизайн: цвета, типографика, межблочные отступы,
  иллюстрации, графика, OG-картинки. Это layout (KS-LL-1) и content
  (KS-CT-1).
- Финальные тексты для h1/h2/cards/usp/cta — это маркетинг (KS-MK-3).
- A/B-тестирование вариантов лендинга. Можно потом отдельно.
- Поведение `/features` за пределами «не сломалось при разделении
  h1 с `/`». Содержательная переработка `/features` как Help-каталога
  — отдельная задача (KS-MK-4 опционально).
- Маршрутизация (`HomePage`, `<FeaturesPage variant>` пропс,
  `App.tsx`) — не меняется.
- Новые маршруты — не вводятся.

---

## 10. Декомпозиция на тикеты

### 10.1. Frontend

| Тикет | Что | Зависит от |
|---|---|---|
| **KS-FE-1** | Переписать `apps/web/src/pages/FeaturesPage.tsx` под новую структуру (§5). Удалить блоки `#navigation`, `features-quick-links`, цикл по `SECTIONS` для `variant='home'`. Добавить блоки Hero (новые тексты + новый primary CTA на `/play/local-bot`), USP (Блок 2), Cards (Блок 3), Proof (Блок 4), CTA-footer (Блок 5), inline-Footer (Блок 6 — после сверки с `MainLayout`). Использовать ключи `landing.*` (§8.3). Сохранить `variant='features'` поведение для `/features` (h1 «Features» + `.guide`-секции). | KS-MK-3 (тексты), KS-BE-1 (эндпоинт `/landing/stats`) |
| **KS-FE-2** | SEO: `<title>`, `<meta description>`, `<meta og:*>`, `<meta twitter:*>`, `<link rel="canonical">`, `<link rel="alternate" hreflang>` через `react-helmet-async` (или текущий механизм проекта — проверить). Разные значения для `variant='home'` и `variant='features'` (§7.1–§7.6). Сверить факт схемы URL для языков (path vs query) с настройкой `i18next` — поправить `hreflang` под факт. | — |
| **KS-FE-3** | JSON-LD WebSite + Organization (§7.5). | — |
| **KS-FE-4** | Обновить prerender (`apps/web/scripts/prerender.mjs`): мок `/landing/stats` → пустой ответ (Блок 4 в bot-снимке скрыт или с placeholder'ами). Убедиться, что `/` и `/features` отдают разные h1 после редизайна — каноникал-конфликт ADR-128 §3.4 закрывается. | KS-FE-1 |

### 10.2. Backend

| Тикет | Что |
|---|---|
| **KS-BE-1** | Публичный `GET /landing/stats` — open эндпоинт по правилам ADR-128 §6.8. DTO: `{ totalGames, totalPuzzlesSolved, registeredUsers, onlineNow, gamesInProgress }`. Источник `onlineNow` — внутренний `players/online` count (уже есть). `gamesInProgress` — `games/live/count` (уже есть). `totalGames`, `totalPuzzlesSolved`, `registeredUsers` — агрегат из БД, кэш в Redis на 60 сек. Rate-limit 60 req/min на IP. Без `JwtAuthGuard`, с `OptionalJwtGuard` (на случай если когда-нибудь захотим кастомизировать ответ авторизованному). Skip-fields для гостя нет (все цифры публичные). |

### 10.3. Layout (CSS)

| Тикет | Что |
|---|---|
| **KS-LL-1** | Стили для новых блоков (§5.1–§5.6): Hero, USP, Cards, Proof, CTA-footer, Inline-Footer. Адаптив (mobile/tablet/desktop). Анимации появления блоков при скролле — на усмотрение. Старые стили `features-section--changelog`, `features-quick-links`, `features-section--{key}` для secret`guide`-секций — оставить (они используются `/features`). |
| **KS-LL-2** | Сверить с `MainLayout` нужен ли inline-Footer в `FeaturesPage` (§5.6) или достаточно глобального footer'а. Если глобальный footer уже есть и подходит — Блок 6 в KS-FE-1 убирается. |

### 10.4. Marketing

| Тикет | Что |
|---|---|
| **KS-MK-1** | Принять/изменить два пункта УТП (§4.2) — финальные формулировки h3 и текстов под них. |
| **KS-MK-2** | Сбор отзывов реальных пользователей (3–5 quotes). Источник — Telegram-сообщество, тренеры, обратная связь от players/coaches. Без отзывов блок не выводится. |
| **KS-MK-3** | Финальные тексты для всех ключей `landing.*` (§8.3): h1/subtitle/cards/usp/cta. По-русски и по-английски. Тон — без маркетингового лишнего. SEO-keywords (§7.7) учитывать. |
| **KS-MK-4** (опц.) | Переработать тексты `/features` (`features.{key}.guide`) — текущие how-to-инструкции местами устарели (упоминают «Home page» как лобби, что не соответствует ADR-058 §6.5 T13). Не блокирует KS-4154. |

### 10.5. Content

| Тикет | Что |
|---|---|
| **KS-CT-1** | OG-картинки `og/landing-en.png` и `og/landing-ru.png` (1200×630). Тема: бренд + позиционирование. До появления — fallback в KS-FE-2 указать без `og:image` (приемлемо) или дефолтный логотип. |
| **KS-CT-2** (опц.) | Иконки для блока USP (§5.2) и для карточек блока 3 (§5.3) — если layout-у нужны кастомные SVG. Текущие emoji-иконки (`features-section__icon`) — допустимы как placeholder. |

### 10.6. Зависимости между тикетами

```
KS-BE-1  ──┐
KS-MK-1 ──┐│
KS-MK-3 ──┼┼──> KS-FE-1 ──> KS-FE-4
KS-LL-2  ─┤│
          │└──> KS-LL-1 (стили) — параллельно с KS-FE-1
          │
KS-CT-1 ──┴──> KS-FE-2 (SEO) — независимо
KS-MK-2 ───────> KS-FE-1 (отзывы добавляются, если есть)
```

Порядок старта: KS-BE-1 + KS-MK-1 + KS-MK-3 + KS-LL-2 → KS-FE-1 + KS-LL-1 (параллельно) → KS-FE-4. KS-FE-2 / KS-FE-3 — независимо в любом порядке. KS-MK-2 / KS-CT-1 / KS-CT-2 — необязательны для первого выкатывания, добавляются follow-up'ом.

### 10.7. Acceptance Criteria для KS-4154

ADR принят, когда:
- Файл `docs/adr/129-guest-landing-redesign.md` опубликован.
- Список тикетов (§10.1–§10.5) создан координатором в трекере.
- Маркетинг прошёл KS-MK-1, KS-MK-3 (это блокирует frontend).

---

## 11. Приложение: текущие i18n-снимки (для контекста)

Снимок секции `features` из `apps/web/src/i18n/locales/en/translation.json`
на момент ADR — см. §8.1. Удалению подлежит ветка `features.navigation.*`
целиком. Остальная часть `features.*` сохраняется для `/features`.

Снимок `features.hero` (en):

```json
"hero": {
  "title": "Play chess. Analyze. Improve.",
  "subtitle": "User Guide",
  "ctaPlay": "Start playing",
  "ctaLearn": "Learn more"
}
```

Замена (для `/`) — в новый namespace `landing.hero.*` (§8.3) с
финальными текстами от маркетинга (KS-MK-3).
