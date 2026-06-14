# ADR-128 — Политика публичных маршрутов и модель «гость пользуется функционалом / логин для записи в БД»

- Статус: **Proposed** (2026-06-14, ревизия §7+§10+§11 в тот же день по
  KS-4121, ревизия §4+§4.1+§5+§6+§8+§10+§11+§12 в тот же день по KS-4125,
  фиксация решений §11.12–§11.14 в тот же день по KS-4126)
- Задача: KS-4120 (исходный), KS-4121 (§7), KS-4125 (отказ от
  PM-лендингов, кодификация inline guest-CTA), KS-4126 (закрытие
  §11.12–§11.14, добавление KS-31/32 на seed-контент, явный запрет
  привлекать chess-expert — контент даёт пользователь)
- Связанные ADR / задачи:
  - KS-4116 — внедрение prerender (frontend, `apps/web/scripts/prerender.mjs`),
    реестр `apps/web/src/config/publicRoutes.ts`.
  - KS-4117 — CloudFront-маппинг `/route` → `/route/index.html` (devops).
  - KS-4118 — backend: открыть GET-эндпоинты витрин (`/broadcasts`,
    `/tournaments`, `/players`) + rate-limit. На паузе до этого ADR.
  - KS-4119 — frontend: снять `ProtectedRoute` с витрин, починить
    `/features`, пересобрать prerender. На паузе до этого ADR.
  - ADR-058 (sidebar restructure) — текущая навигация по разделам.
  - ADR-110 / ADR-119 — публичный режим зрителя live-анализа и лекций
    (прецеденты «гость видит контент, действия — за логином»).
- Авторы: architect.

---

## 1. Контекст и проблема

Технически инфраструктура для индексируемого HTML публичных страниц
готова (KS-4116 + KS-4117). По факту prerender приносит пользу только
на `/` и `/puzzles` — остальные маршруты, попавшие в реестр
`PUBLIC_ROUTES`, отдают одно из трёх:

- **дубль главной** (`/features` — баг роутинга, см. §3.4);
- **страницу логина** (`/play`, `/puzzle-rush` — обёрнуты в
  `ProtectedRoute`, который рендерит редирект на `/login`);
- **пустой layout** (`/broadcasts`, `/tournaments`, `/players`,
  `/workshop` — рендерятся без auth, но контент тянется через API,
  который требует JWT, и в SPA данные не приходят → бот видит только
  скелет/спиннер).

Продуктовое направление пользователя: **открывать для гостя
максимально много разделов на просмотр (read); требовать логин только
при попытке действия (write / интерактив)**. Пример из ТЗ: `/puzzles`
гость листает задачи без логина, при попытке решить — модалка логина.
`/broadcasts` гость смотрит список и читает партии трансляции, но
писать в чат не может.

До раздачи задач в backend / frontend нужно зафиксировать единый
контракт: какие маршруты открываются, какие данные гость видит,
какие действия требуют auth, как выглядит UX-точка перехода
«гость → пользователь».

ADR **не пишет код** (это сделают KS-4118 backend и KS-4119
frontend и дополнительные тикеты по §10), **не дизайнит модалку в
Figma** и **не пишет тексты лендингов** — даёт только инварианты и
декомпозицию.

---

## 2. Состав маршрутов под анализ

Источник истины — `apps/web/src/App.tsx` (фактический роутер) и
`apps/web/src/config/publicRoutes.ts` (реестр для prerender и
будущего sitemap). В описании KS-4120 перечислены 20 маршрутов, но
реальный роутер описывает значительно больше (lecture-namespace,
opening-trainer, archive, drills, precision, guess, blind-board, и т.
д.). Классификация в §4 покрывает **все существующие маршруты**,
включая namespace-семьи. Иначе следующая итерация откроет «гостю
больше», и придётся переписывать ADR на каждый раздел.

Сводно: 8 публичных read (контент гостю), 4 публичных marketing,
3 публичных-смешанных (контент + редирект на action), остальное —
private. Точные строки — §4.

---

## 3. Текущее состояние (факты)

### 3.1. Реестр `PUBLIC_ROUTES`

`apps/web/src/config/publicRoutes.ts`: 14 путей с приоритетом
sitemap. Реестр используется (а) скриптом prerender и (б) под будущий
sitemap. Защищённые маршруты в нём не учтены — это правильно.

Состав реестра на момент ADR:

```
/, /play, /lobby, /tournaments, /puzzles, /daily, /puzzle-rush,
/analysis, /workshop, /broadcasts, /players, /feedback, /features, /login
```

### 3.2. Prerender pipeline

`apps/web/scripts/prerender.mjs` поднимает Playwright headless, мокает
`/config` → дефолтные feature-flags, `/auth/me` → 401 (гость), любые
`/api/**` → пустой 200. На каждый путь снимает
`document.documentElement.outerHTML` после стабилизации `#root` и
пишет в `dist/<route>/index.html`.

Следствие: на public-read маршрутах prerender видит то, что отрендерит
SPA при `auth=null` и пустых ответах API. Сейчас это либо страница
логина (если `ProtectedRoute` обёртка), либо пустой layout.

### 3.3. Защита маршрутов на фронте

`apps/web/src/App.tsx:242-263` — `ProtectedRoute`:

```tsx
if (!user) {
  const returnUrl = `${location.pathname}${location.search}`;
  setAuthReturnUrl(returnUrl);                       // sessionStorage
  return <Navigate to="/login" state={{ returnUrl }} replace />;
}
```

Каждый защищённый маршрут оборачивается явно. Полу-публичные
обёртки (`GuestRoute`, `AdminRoute`) — отдельные. Hook `HomePage`
делает разветвление: гость → `<FeaturesPage>`, авторизованный → редирект на
`/play`.

`returnUrl` сохраняется в sessionStorage (`setAuthReturnUrl`,
`apps/web/src/utils/authReturnUrl.ts`) — переживает OAuth-флоу
(`window.location.href='/auth/google'`). После успешного логина
`consumeAuthReturnUrl()` забирает один раз.

### 3.4. Баг `/features`

prerender для `/features` отдаёт 21 КБ с h1 главной (`Play chess.
Analyze. Improve.`). Причина — гость на `/` редиректится на
`<HomePage>` → `<FeaturesPage>`, а явный маршрут `/features` рендерит
ту же `<FeaturesPage>`. Скорее всего prerender падает не на роутинг,
а на одинаковый компонент: и `/` и `/features` сейчас отдают
`FeaturesPage`. Это значит prerender по факту работает, но SEO-зеркало
бесполезно (одна и та же страница в двух местах = каноникал на одно из
них). Детально — KS-4119 п.2 для разбора фактом, в этом ADR
классифицируем `/features` как **public-marketing** с собственным
шаблоном и единым каноникалом.

### 3.5. Защита эндпоинтов на бэке

`@nestjs/passport` JWT, паттерн на 90% controller'ов:
`@UseGuards(JwtAuthGuard)` на уровне класса либо на каждом методе.
В `apps/api/src/puzzle/puzzle.controller.ts` уже используется
**`OptionalJwtGuard`** (например, для каталога задач) — гость
получает 200 без user-id, авторизованный — со своими данными
(прогресс, рейтинг). Этот паттерн станет основой для KS-4118.

Throttler глобально не подключён по умолчанию. При открытии
эндпоинтов гостю нужен `@nestjs/throttler` (или эквивалент) на
уровне модуля — это часть KS-4118.

### 3.6. Существующая модалка логина

Поиск по компонентам показал, что отдельной reusable
`<LoginRequiredModal>` сейчас нет. Все ProtectedRoute-кейсы делают
полный редирект на `/login`. На `/lecture/*` (ADR-119) есть отдельный
паттерн «недоступно» (`/lectures/:id/unavailable`) — он специфичен для
лекций и не подходит как универсальный.

Это значит: компонент модалки нужно завести впервые. Контракт —
§6.

---

## 4. Классификация маршрутов

> **Ревизия 2026-06-14 (KS-4125).** Предыдущая редакция выделяла
> отдельную категорию **Public-marketing (PM)** для тренажёров
> (`/play`, `/puzzle-rush`, `/precision`, `/workshop`, `/drills`,
> `/opening-trainer`, `/blind-board`) с показом гостю
> `<MarketingLanding>`-обёртки и CTA «войди чтобы попробовать».
>
> Решение пользователя: **PM-лендинги для тренажёров отменяются**.
> Гость использует функционал полноценно. Логин нужен только при
> записи в БД (прогресс, статистика, регистрация в турнире, отправка
> сообщения, добавление в друзья). Где запись идёт автоматически по
> факту прохождения — inline guest-CTA на странице («войди, чтобы
> сохранять прогресс»). Где запись — discrete-action с явной кнопкой
> (отправить, зарегистрироваться, сохранить) — модалка
> `<LoginRequiredModal>` через `useRequireAuth` (KS-4124, см. §6).
>
> Образец паттерна, уже сложившийся в коде на момент ревизии:
> - `apps/web/src/pages/PuzzlePage.tsx:900-903, 969-972` — inline
>   баннер `<Link to="/login">{auth.loginToSaveProgress}</Link>` под
>   шапкой.
> - `apps/web/src/pages/PrecisionStatsPage.tsx:53-91`,
>   `PrecisionHistoryPage.tsx` — `isGuest = !user`, секция CTA для
>   гостя, full content для авторизованного, всё с
>   `data-auth={isGuest ? 'guest' : 'user'}`.
> - `apps/web/src/pages/BlindBoardStatsPage.tsx:16, 32`,
>   `BlindBoardHistoryPage.tsx`, `GuessStatsPage.tsx` — тот же шаблон
>   `isGuest && <CTA>` / `!isGuest && <Content>`.
> - `apps/web/src/components/workshop/WorkshopAnalysisList.tsx:662-664`
>   — `{!user ? <p>{workshop.myAnalyses.loginRequired}</p> : <List/>}`.
> - `apps/web/src/pages/AnalysisPage.tsx:689, 792-797` — `isGuest`
>   проставляется в disabled-state кнопок «Сохранить в репертуар» и
>   подобных, с `disabledHint` для тултипа.
>
> Эта ревизия кодифицирует паттерн и распространяет его на тренажёры,
> которые сейчас под `ProtectedRoute`.

### 4.1. Категории

- **Public-full** (PF) — гость пользуется функционалом полноценно
  (читает + интерактив + локальная статистика в браузере / WASM).
  Записи в БД (прогресс, рейтинг, история попыток, лидерборд)
  требуют логина — закрываются inline guest-CTA + (при попытке
  явного write-action) `<LoginRequiredModal>`. Бот видит реальный
  скриншот тренажёра.
- **Public-read** (PR) — гость смотрит контент (список, профиль,
  трансляция, статья). Discrete write-action (написать в чат,
  зарегистрироваться, добавить в друзья, сохранить) — `<LoginRequiredModal>`.
- **Public-mixed** (PX) — публичный read-режим через `publicMode` /
  shared-ссылку (анализы, replay), действие требует ownership →
  модалка.
- **Public-auth** (PA) — открыто по природе (`/login`, `/register`,
  `/oauth/callback`, `/terms`, `/credits`, `/help/external-engine`).
- **Private** (PV) — личные данные (`/settings`, `/messages`,
  `/friends`, `/profile`, `/game/:id`, `/lessons/my/*`,
  `/admin/*`). `ProtectedRoute` редиректит на `/login` — этот контракт
  сохраняется для прямых ссылок (§6.5).
- **Dev** (DV) — `import.meta.env.DEV`-only / dev-bypass; в проде нет.

Категория **Public-marketing (PM)** удалена. Маркетинговая страница
`/features` (одна на сайт) — обычная статическая страница, не шаблон.
`<MarketingLanding>`-компонент не вводится (см. §4.3).

### 4.2. Таблица per-route

| Маршрут | Категория | Что гость делает / видит | Что пишется в БД (требует логина) | Паттерн point-of-auth |
|---------|-----------|--------------------------|-----------------------------------|-----------------------|
| `/` | PR (гость) / редирект (юзер) | Лендинг главной (`<FeaturesPage>`); юзер → `/play` | — | — |
| `/features` | PR | Описание разделов сайта (статическая) | — | — |
| `/login`, `/register`, `/oauth/callback` | PA | Формы аутентификации | — | — |
| `/terms`, `/terms-of-service`, `/credits`, `/help/external-engine`, `/docs/user-courses` | PA | Юридика, документация | — | — |
| `/play` | **PF** | Лобби игры: выбор time-control, игра против бота (без рейтинга), просмотр открытых вызовов | Запуск онлайн-матча, обновление личного рейтинга, история партий | inline-CTA на лобби + модалка при попытке «играть онлайн» |
| `/lobby` | **PF** | Список открытых вызовов и быстрых игр | Создание вызова, приём, запуск матча | inline-CTA + модалка |
| `/tournaments`, `/tournaments/:id`, `/arena/:id` | PR | Список, расписание, бракет, кросс-таблица | Регистрация, инвайты | модалка по кнопке «Зарегистрироваться» |
| `/t/:code` | PR | Превью турнира по invite | Принятие invite | модалка |
| `/puzzles`, `/puzzle/:id`, `/puzzles/stats` | **PF** (уже работает) | Каталог задач, решение задачи через `chess.js` локально (UCI-ходы, проверка решения) | Submit attempt, прогресс, личный рейтинг, streak | inline-CTA (образец PuzzlePage:900) |
| `/puzzle-rush` | **PF** | Запуск раунда, решение задач на скорость, локальный score | Сохранение score в лидерборд, профильный рейтинг | inline-CTA на странице «вы играете как гость, score не сохранится» |
| `/puzzle-rush/leaderboard` | PR | Лидерборд (уже public) | — | — |
| `/puzzle-rush/review/:scoreId` | PV | Личный review (требует ownership) | — | `ProtectedRoute` |
| `/precision` | **PF** | Каталог позиций, тренировка | Сохранение attempts, рейтинг | inline-CTA |
| `/precision/stats`, `/precision/history`, `/precision/attempts/:id` | **PF (stats/history)** + PV (attempts/:id) | Stats/history гостю — guest-CTA («залогинься чтобы увидеть свои тренды»); чужой attempts/:id не нужен | Личная статистика | inline-CTA (PrecisionStatsPage уже работает) |
| `/analysis`, `/analysis/:id` | PX/**PF** | Анализ позиции от FEN, импорт PGN, Stockfish-WASM локально | Сохранение анализа в свои, добавление в репертуар | inline disabled-hint + модалка по кнопке «Сохранить» (AnalysisPage уже работает) |
| `/analysis/public/:id` | PX | Read-only shared-анализ | — | — |
| `/analyses/:analysisId/metrics` | PX | Метрики публичного анализа (ADR-122) | — | — |
| `/game/:id`, `/game/:id/review` | PV | Личная партия | — | `ProtectedRoute` |
| `/games/live`, `/games/:id/watch` | PR | Лента live-партий | Поставить лайк, написать в чат | модалка |
| `/workshop`, `/workshop/pgn-files`, `/workshop/pgn-files/:fileId` | **PF** | Анализ позиции (FEN, PGN-импорт, Stockfish-WASM, варианты). Сайдбар «Мои анализы» гостю замещается на **демо-список классических партий с ротацией** (§11.14) — гость открывает партию в полнофункциональном анализе | Сохранение анализа, прикрепление PGN-файла | анализ — без CTA (полный функционал); кнопка «Сохранить» — паттерн B; сайдбар — демо-партии |
| `/broadcasts/*` | PR | Список трансляций, конкретный турнир, раунд, партия | Чат, лайки, комментарии | модалка по кнопке |
| `/players` | PR | Лидерборд игроков, поиск | — | — |
| `/player/:username` | PR | Публичный профиль, рейтинги, история | Вызов на партию, написать сообщение, добавить в друзья | модалка (PlayerProfilePage уже использует `useRequireAuth`) |
| `/coach/:username` | PR | Витрина тренера, услуги, цены | Запись на лекцию, написать | модалка |
| `/lectures`, `/lectures/:id` | PR | Каталог, лендинг лекции (free preview) | Покупка, запись на live, просмотр replay | модалка |
| `/lectures/:id/live` | PX/PV | Free-preview первых N минут (если ADR-119 позволит), иначе модалка | Платный доступ | модалка |
| `/lectures/:id/replay`, `/lectures/:id/unavailable` | PV / PR | Replay требует ownership; unavailable — public-info | — | `ProtectedRoute` для replay |
| `/archive`, `/archive/games/:id`, `/archive/players/:slug` | PR | Архив партий (уже без `ProtectedRoute`) | — | — |
| `/lessons` (если `lessonsEnabled`) | PR/PF (зависит от §11.2) | Каталог системных курсов | Прогресс прохождения, отметка «изучено» | inline-CTA + модалка по «начать курс» — см. §11.2 |
| `/lessons/discover` | PR (уже работает) | Каталог открытых курсов | — | — |
| `/lessons/my`, `/lessons/my-active`, `/lessons/editor`, `/lessons/:courseSlug`, `/lessons/:courseSlug/:lessonSlug` | PV | Личные курсы, прогресс | — | `ProtectedRoute` |
| `/feedback`, `/feedback/:id` | PR | Доска идей | Голосовать, комментировать, создать | модалка по кнопке |
| `/drills`, `/drills/about`, `/drills/sprint*`, `/drills/:type` | **PF** | Тематические тренажёры. `/drills/about` (статика) уже public | Sprint setup/play/results — сохранение прогресса, leaderboard | inline-CTA на странице тренажёра |
| `/opening-trainer` | **PF** | Главная раздела с двумя секциями: «Демо-репертуары» (open, контент-seed §11.12 — несколько содержательных репертуаров от пользователя) + «Мои репертуары» (для гостя — guest-CTA). Гость проходит демо в SRS-flow локально | Личный репертуар, прогресс, SRS-очередь | inline-CTA на секции «Мои» + модалка по «создать репертуар» |
| `/opening-trainer/demo/:id` (новый) | **PF** | Сессия по демо-репертуару, прогресс in-memory/localStorage | — (no-op 204 при попытке записи, §11.13) | — |
| `/opening-trainer/new`, `/opening-trainer/:id`, `/opening-trainer/:id/session/*`, `/opening-trainer/reviews`, `/opening-trainer/:id/stats` | PV | Личные репертуары | — | `ProtectedRoute` |
| `/guess`, `/guess/sessions/:id` | **PF** | Угадай ход — тренажёр без личных данных, работает локально | Score, история | inline-CTA |
| `/guess/stats`, `/guess/history` | **PF (stats)** + PV | Stats/history гостю — guest-CTA по образцу `PrecisionStatsPage` (GuessStatsPage уже использует шаблон) | Личные тренды | inline-CTA |
| `/blind-board`, `/blind-board/sessions/:id` | **PF** | Тренажёр слепой игры — локально | Score, история | inline-CTA |
| `/blind-board/stats`, `/blind-board/history` | **PF** | Гостю — guest-CTA (BlindBoardStatsPage уже работает) | Личные тренды | inline-CTA |
| `/live/:slug` | PR | Зритель live-анализа (ADR-110), `noindex` ставит сама страница | — | — |
| `/messages`, `/messages/:userId`, `/friends`, `/profile`, `/settings` | PV | Личные данные | — | `ProtectedRoute` |
| `/admin/feature-flags`, `/admin/*` | PV (admin) | Админка | — | `AdminRoute` |
| `/dev-bypass`, `/__dev/*`, `/dev/*` | DV | Только dev/staging | — | — |

### 4.3. Отказ от `<MarketingLanding>`

`<MarketingLanding>` как унифицированный шаблон **не вводится**.
Решение: гость попадает на сам тренажёр, не на лендинг. Это правильнее
по UX (нет двойного клика «прочитал лендинг → войти → начать») и
правильнее по SEO (бот видит реальный продукт, а не маркетинговое
описание).

Единственный маркетинговый раздел — `/features` (одна страница на сайт,
описание возможностей с CTA «зарегистрироваться»). Это **обычная
react-компонента**, не шаблон. Тексты — отдельная задача content +
marketing.

`<MarketingLanding>` упоминается ниже в §7.7 (старый текст, оставлен
для исторической непрерывности — но **не реализуется**). При
финальной зачистке ADR (volna 5, KS-21) §7.7 переписывается на
«отдельный компонент `<FeaturesPage>`, без шаблона».

---

## 5. Модель «функционал vs запись в БД» по PF/PR-маршрутам

> **Ревизия 2026-06-14 (KS-4125).** Раздел изначально описывал только
> PR («read vs action»). После отказа от PM в §4 добавляется PF
> («полный функционал vs запись в БД»). Содержание §5.1–§5.10 ниже
> остаётся валидным для PR-маршрутов; для PF-тренажёров §5.11–§5.14
> описывают что гость делает локально (без backend-вызовов) и где
> ставится inline guest-CTA.

### 5.1. `/puzzles`, `/puzzle/:id`, `/puzzles/stats`

| Что | Read (гость) | Action (требует auth) |
|-----|--------------|-----------------------|
| Список | Каталог задач, фильтры (theme/rating/openings), пагинация | — |
| Деталь | Позиция (FEN), темы, рейтинг задачи, превью доски | Решение задачи (POST attempt), «следующая», ставит/возвращает прогресс |
| Stats | Глобальная статистика (количество задач, распределение по темам/рейтингу) | Личная статистика и история попыток |

Эндпоинты:
- `GET /puzzles` — open (уже `OptionalJwtGuard`).
- `GET /puzzles/:id` — open (`OptionalJwtGuard`).
- `GET /puzzles/stats/global` — open (новый, разделение от
  `/puzzles/stats/me`).
- `POST /puzzles/:id/attempt`, `POST /puzzles/:id/skip` — JWT-only.

DTO — гостю скрывать: `userProgress`, `userRating`, `lastAttemptAt`.
Поля задачи (тема, FEN, рейтинг) — общие.

Rate-limit для гостя: 60 req/min на IP по `GET /puzzles*`. На
`POST/PUT` — не нужен (там 401 раньше throttler'а сработает).

### 5.2. `/tournaments`, `/tournaments/:id`, `/arena/:id`

| Что | Read | Action |
|-----|------|--------|
| Список | Открытые/идущие/прошедшие турниры, время, формат, призы | Создать турнир |
| Лобби арены | Описание, расписание, регламент, текущая таблица, список зарегистрированных | Регистрация, играть |
| Кросс-таблица / бракет | Раунды, доски, результаты | Чат, лайки |

Эндпоинты:
- `GET /arena` (список), `GET /arena/:id` — open (`OptionalJwtGuard`).
- `GET /arena/:id/standings`, `GET /arena/:id/rounds` — open.
- `POST /arena/:id/register`, `POST /arena/invite/:code` — JWT.

DTO — скрыть: `email` участников, `personalNotes`, `inviteUrl`
(только для admin/owner).

Rate-limit: 60 req/min на IP.

### 5.3. `/broadcasts`, `/broadcasts/:tournamentId`, `/broadcasts/:tid/:rid`, `/broadcasts/:tid/:rid/:gid`, `/broadcasts/:tid/:rid/:gid/live`

| Что | Read | Action |
|-----|------|--------|
| Список трансляций | Идущие, прошедшие, расписание | — |
| Турнир / раунд | Расписание партий, таблица, ссылки на партии | — |
| Партия (live / archived) | Доска, ходы, evals (если есть), таймер, имена игроков | Чат, лайки |

Эндпоинты:
- `GET /broadcasts`, `GET /broadcasts/:id`, `GET /broadcasts/:tid/:rid`,
  `GET /broadcasts/:tid/:rid/:gid`, `GET /broadcasts/:tid/:rid/:gid/live`
  — open.
- `POST /broadcasts/:id/chat`, `POST /broadcasts/:id/like` — JWT.

DTO — для гостя скрыть: `viewerEmail`, `viewerSubscription`. Имена и
рейтинги игроков — публичные (это спорт-данные).

Rate-limit: 60 req/min на IP по GET; `/live` polling уже 15s
(ADR-021), на IP лимит 8 req/min должен покрыть.

### 5.4. `/players`, `/player/:username`, `/coach/:username`

| Что | Read | Action |
|-----|------|--------|
| Список | Лидерборд по рейтингу (bullet/blitz/rapid/classical/puzzle/precision), фильтры, поиск | — |
| Профиль игрока | Никнейм, рейтинги, статистика партий, история (последние N), достижения (если публичные), теги тренера если есть | Вызов на партию, написать сообщение, добавить в друзья |
| Профиль тренера | + витрина (ADR-113): услуги, цены, расписание | Записаться на лекцию |

Эндпоинты:
- `GET /players` (список), `GET /players/search` — open.
- `GET /players/:username` — open.
- `GET /players/:username/recent-games` — open.
- `GET /coaches/:username` — open.
- `POST /challenges`, `POST /messages`, `POST /friends/request` — JWT.

DTO — для гостя скрыть: `email`, `phone`, `lastSeenAt` (если приватно
выставлено), `privateAchievements`, `privacyFlags`, `friends[]` если
профиль ограничен «только друзьям».

Rate-limit: 60 req/min на IP на список, 120 на детали (`username`-
поиск ботами).

### 5.5. `/feedback`, `/feedback/:id`

| Что | Read | Action |
|-----|------|--------|
| Список идей | Открытые и закрытые, фильтры по статусу/категории | — |
| Деталь | Описание, ответы, голоса | Голосовать, комментировать, создать новую |

Эндпоинты:
- `GET /feedback`, `GET /feedback/:id` — open.
- `POST /feedback`, `POST /feedback/:id/vote`, `POST /feedback/:id/comment` — JWT.

DTO — для гостя скрыть: `voterEmails[]`, `internalNotes`.

Rate-limit: 60 req/min на IP.

### 5.6. `/games/live`, `/games/:id/watch`

| Что | Read | Action |
|-----|------|--------|
| Лента live-партий | Идущие партии других игроков (открытые для зрителей), фильтры по time-control | — |
| Просмотр партии | Доска, ходы, таймер, имена | Поставить лайк, написать в чат (если включён) |

Эндпоинты — open уже (открытые WebSocket подписки на наблюдателей —
работают как для гостя, так и для авторизованного; гость без сессии
не делает SUB на чат-канал, только board events).

### 5.7. `/lobby` (после downgrade на PM, переходный план)

Сейчас уже без `ProtectedRoute`, но требует профиль для смысловой
функции (открытые вызовы, создание игры). Минимальная мера для SEO —
PM-лендинг (CTA «начать играть»). Для полноценного PR — открыть
`GET /lobby/open-challenges` с публичным DTO (без `inviterEmail`,
`inviterId` опционально) — отдельная задача после KS-4118.

### 5.8. `/archive`, `/archive/games/:id`, `/archive/players/:slug`

Уже не под `ProtectedRoute` (ADR-018). Подтверждаем PR. Open эндпоинты
`GET /archive/games`, `GET /archive/games/:id`,
`GET /archive/players/:slug` — без изменений или с подтверждением
public-режима.

### 5.9. `/analysis`, `/analysis/:id`, `/analysis/public/:id`

`publicMode=true` уже работает через `GET /analyses/public/:id`
(KS-2666/KS-2672). Расширения не требуется. Любой `/analysis/:id`
гостя, который запрашивает приватный анализ, → модалка логина.

### 5.10. `/lectures`, `/lectures/:id`

`LecturesListPage` уже без `ProtectedRoute`. Лендинг лекции
(`/lectures/:id` → `<LectureLandingPage>`) — уже public по ADR-119.
Открытие GET `/lectures` и `/lectures/:id` для гостя — backend уже
поддерживает, фронт работает. Доступ к live/replay — за оплатой
(ADR-118), это action.

### 5.11. `/puzzles`, `/puzzle/:id` (PF, уже работает)

Гость:
- Каталог задач, фильтры (theme/rating/openings), пагинация.
- Открыть задачу, решать ходами (`chess.js` локально валидирует UCI).
- Видит правильный ход после ошибки.
- streak/totalSolved в текущей сессии (in-memory) — обнуляются при
  перезагрузке.

В БД пишется (требует логина):
- `POST /puzzles/:id/attempt` — записывает попытку и обновляет
  `userRating`, `userProgress`, `lastAttemptAt`.
- `POST /puzzles/:id/skip` — отметка о пропуске.

inline guest-CTA: `<Link to="/login">{auth.loginToSaveProgress}</Link>`
под шапкой страницы (`PuzzlePage.tsx:900-903, 969-972`). Не модалка —
гость продолжает решать задачи, баннер просто висит как напоминание.

### 5.12. `/precision`, `/precision/stats`, `/precision/history` (PF + PR/PF stats)

Гость:
- Каталог позиций play-vs-engine.
- Запуск позиции — `<PlayVsEngineRunner>` работает с локальным
  Stockfish-WASM.
- Локальный feedback (точность хода, оценка).

В БД пишется (требует логина):
- `POST /precision/:id/attempt` — попытка с рейтинг-дельтой Glicko-1
  (ADR-079).
- `POST /precision/next` — переход на следующую задачу по
  рейтинг-окну.

`/precision/stats`, `/precision/history`:
- Для гостя — секция CTA «Sign in to track your accuracy, trends and
  weak themes» + кнопка «Sign in and start training»
  (`PrecisionStatsPage.tsx:69-90` — уже работает).
- Для авторизованного — `<PrecisionStatsCards>`, `<PrecisionTrendsChart>`,
  `<PrecisionBreakdowns>`.

`/precision/attempts/:id` — PV (личный attempt, ownership).

### 5.13. `/puzzle-rush`, `/drills`, `/blind-board`, `/guess` (PF тренажёры)

Общий шаблон для всех тренажёров без личных данных:
- Гость полностью использует функционал, локальный score/время.
- Лидерборд гостю показываем (PR-эндпоинт без логина).
- В БД пишутся: запись score в лидерборд, профильные тренды.
- inline guest-CTA на странице тренажёра в области «score»:
  «Ваш результат: {score}. Войдите, чтобы попасть в лидерборд.»
- Stats/history гостю — guest-CTA по образцу `PrecisionStatsPage`.

Реальное состояние на момент ревизии (для опоры frontend-задач):
- `/blind-board/stats`, `/blind-board/history` — `isGuest && <CTA>` уже
  реализовано (`BlindBoardStatsPage.tsx:32`, `BlindBoardHistoryPage.tsx:37`).
- `/guess/stats` — то же (`GuessStatsPage.tsx:33`).
- `/puzzle-rush` — `ProtectedRoute` снять, страницу запустить гостю,
  отключить отправку score'а в БД для `user==null`.
- `/drills`, `/drills/sprint*` — `ProtectedRoute` снять, sprint-results
  не пишутся для гостя.

### 5.14. `/workshop`, `/analysis` (PF анализ)

Гость:
- `/workshop` — ввести FEN, импортировать PGN в браузер, играть
  варианты, запустить Stockfish-WASM (`EngineLoader`), смотреть
  оценки/линии, добавлять аннотации/NAG'и/комменты к ходам — всё
  локально, без backend.
- `/analysis`, `/analysis/:id` — то же.
- `/analysis/public/:id` — read-only shared (без изменений).

**Сайдбар workshop для гостя** (решено §11.14, KS-4126): вместо
guest-CTA «войди чтобы сохранять» показываем **демо-список
классических партий** (контент-seed от пользователя) с ротацией
«партия дня» / «партия недели». Гость кликает на партию → открывается
в полнофункциональном анализе. Сохранение анализа — модалка.

В БД пишется (требует логина):
- «Сохранить в Мои анализы» (`POST /workshop/analyses`) — кнопка
  disabled с hint'ом для гостя (AnalysisPage.tsx:792-797 уже работает),
  на click — модалка (`useRequireAuth`). Бэкенд: **401 при `user==null`**
  как защитная граница (см. §11.13).
- «Добавить позицию в репертуар» — то же.
- `WorkshopAnalysisList` (бывший «Мои анализы» сайдбар) — заменён на
  демо-список §11.14 для гостя. Для авторизованного — без изменений.

`/workshop/pgn-files`, `/workshop/pgn-files/:fileId` — личные файлы;
для гостя секция замещается на демо-список, верхняя половина (анализ) —
полнофункциональна.

---

## 6. UX-паттерны point-of-auth

> **Ревизия 2026-06-14 (KS-4125).** Изначально §6 описывал только
> модалку. После отказа от PM-лендингов (§4) гостю открывается весь
> функционал, и **главный** паттерн стал inline guest-CTA (для записи
> прогресса в БД, происходящей автоматически по факту использования).
> Модалка остаётся для discrete-actions с явной кнопкой. Ниже —
> формулировка обоих паттернов и decision rule.

### 6.1. Паттерн A — inline guest-CTA (по умолчанию для PF)

Где применяется:
- Тренажёры, где запись в БД происходит **автоматически по факту
  прохождения** (puzzle attempt, precision attempt, puzzle-rush score,
  drill sprint result, blind-board score, guess score, opening-trainer
  session).
- Статистика и история этих тренажёров (PF stats/history): гостю
  показываем CTA «войди, чтобы видеть свои тренды», авторизованному —
  реальный контент.
- Stand-alone списки личных артефактов (workshop analyses,
  archive of own games): гостю — `<p>{loginToSave}</p>`,
  авторизованному — список.

Контракт компонента-страницы:

```tsx
const { user } = useAuth();
const isGuest = !user;
return (
  <div className="<page>" data-auth={isGuest ? 'guest' : 'user'}>
    <Header />
    {isGuest && <GuestCTA i18nKey="<page>.guest.message" cta="<page>.guest.cta" />}
    <CoreFunctionality />  {/* всегда: тренажёр работает локально */}
    {!isGuest && <PersonalContent />}
  </div>
);
```

Образец готового кода — `apps/web/src/pages/PrecisionStatsPage.tsx:55-101`
(используется как шаблон для остальных PF-стат-страниц).

Для двух мест на странице (header + footer статистики) разрешено
дублирование баннера — без обёртки в Context. Образец:
`PuzzlePage.tsx:900-903, 969-972`.

### 6.2. Паттерн B — `<LoginRequiredModal>` + `useRequireAuth` (для discrete actions)

Где применяется:
- Discrete write-action с явной кнопкой: «Отправить сообщение»,
  «Зарегистрироваться в турнире», «Добавить в друзья», «Сохранить
  анализ», «Принять вызов», «Купить лекцию», «Создать репертуар».
- Действия в шапке/сайдбаре витрин (`/player/:u`, `/coach/:u`,
  `/tournaments/:id`, `/broadcasts/:id`).

Уже реализовано (KS-4124):
- `apps/web/src/context/RequireAuthContext.tsx` — провайдер +
  `useRequireAuth` (см. строки 57–129).
- `apps/web/src/components/LoginRequiredModal.tsx` — компонент.
- `apps/web/src/main.tsx:163-165` — провайдер обёрнут вокруг
  приложения.
- Используется в `PlayerProfilePage.tsx:83`,
  `TournamentLobbyPage.tsx:90`.

Контракт хука:

```tsx
const requireAuth = useRequireAuth();
<button onClick={() => requireAuth(() => sendMessage(payload), {
  description: t('player.loginToMessage', 'Sign in to message {{name}}', { name }),
})}>
  {t('player.message')}
</button>
```

Поведение:
- Если `user!=null` — `action()` выполняется сразу.
- Если гость — открывается `<LoginRequiredModal>` с переданным
  `description`. Кнопки «Войти» / «Создать аккаунт» сохраняют
  `returnUrl` через `setAuthReturnUrl(...)` и навигируют на
  `/login` / `/register`. После логина `OAuthCallbackPage` /
  `LoginPage` читают returnUrl и возвращают пользователя.

Хук **не** повторяет действие после логина автоматически — это
осознанное решение из docstring'а `RequireAuthContext.tsx:13-16`,
чтобы не плодить глобальную очередь намерений. Если для конкретной
страницы нужен deep-link на повторение (например, продолжить решение
задачи) — страница сама читает `returnUrl` / URL-state и вызывает
action.

### 6.3. Decision rule — какой паттерн использовать

| Условие | Паттерн |
|---|---|
| Запись в БД происходит **по факту** прохождения (attempt, score, session result) | **A — inline guest-CTA** |
| Действие — отдельная **кнопка** (Send, Save, Register, Add, Buy) | **B — модалка через `useRequireAuth`** |
| Read-only страница без действий (трансляция, профиль на просмотр) | — (никакого CTA, баннер не нужен) |
| Личная страница, гостю показывать нечего (`/settings`, `/messages`) | `ProtectedRoute` редиректит на `/login` |

Граничные случаи:
- `/play` (лобби игры): первичный фокус — выбор игры. Открываем гостю
  с inline-CTA «вы играете как гость, без рейтинга». Кнопка «Играть
  онлайн» — модалка (для матчмейкинга нужен профиль и WS-сессия с
  JWT). Кнопка «Играть с ботом» — открывает игру без логина.
- `/lobby`: список открытых вызовов открыт гостю; кнопка «Принять»
  / «Создать вызов» — модалка.
- `/workshop`: верхняя половина (анализ позиции) — A; список «Мои
  анализы» — A (guest замещается баннером); кнопка «Сохранить» — B.

### 6.4. Deep-link после логина (общее для A и B)

Реюз существующего `authReturnUrl`:
- A (inline-CTA): `<Link to="/login">` использует обычный flow —
  `LoginPage` после успеха читает `state.returnUrl` (или
  `consumeAuthReturnUrl()`) и редиректит обратно.
- B (модалка): `useRequireAuth` сам пишет `setAuthReturnUrl(returnUrl)`
  перед навигацией, см. `RequireAuthContext.tsx:90, 97`.

Повторение конкретного action после логина — на усмотрение страницы
(см. §6.2). Глобальной «очереди намерений» нет — это намеренно.

### 6.5. Что НЕ делают паттерны

- Не делают passwordless / magic-link.
- Не делают «продолжить как гость» — гость уже на странице, паттерн
  появляется именно для записи / discrete action.
- Не делают inline-форму логина прямо на странице (только модалка или
  навигация на `/login`).

### 6.6. Edge case: ProtectedRoute остаётся для прямых ссылок

Если гость пришёл по прямой ссылке на чисто-private маршрут
(`/settings`, `/messages`, `/profile`, `/game/:id`, `/lessons/my/*`) —
`ProtectedRoute` продолжает редиректить на `/login` с
`setAuthReturnUrl`. Это сохраняет существующий контракт returnUrl и
не требует A/B-паттернов на странице, которая для гостя бессмысленна.

PF/PR-маршруты `ProtectedRoute` **не** оборачивает; гость попадает на
сам тренажёр.

### 6.7. Унификация — рекомендуемый компонент `<GuestCTA>`

Сейчас inline-CTA в коде каждой страницы своя:
- `PuzzlePage` — `<div className="guest-banner">{<Link/>}</div>`.
- `PrecisionStatsPage` — `<section
  className="precision-stats-page__guest">…<Link/></section>`.
- `BlindBoardStatsPage` — то же, но с другими classNames.
- `WorkshopAnalysisList` — `<p
  className="workshop-section-block__empty">{login}</p>`.

Для консистентности (и чтобы новые PF-страницы не плодили четвёртый
вариант) — ввести один компонент `<GuestCTA>` в
`apps/web/src/components/auth/GuestCTA.tsx`:

```tsx
interface GuestCTAProps {
  variant?: 'banner' | 'section' | 'inline';   // banner — узкий в шапке, section — крупный с h2 и кнопкой, inline — короткая ссылка
  messageKey: string;                          // i18n key для текста
  ctaKey?: string;                             // i18n key для кнопки/ссылки (default — 'auth.signIn')
  testid?: string;
}
```

Использовать на всех новых PF-страницах. Существующие — мигрировать
постепенно (KS-23 декомпозиции). Это снимает риск визуального
расхождения CTA по разделам.

---

## 7. SEO-следствия

> **Ревизия 2026-06-14 (KS-4121).** Предыдущая редакция §7 предлагала
> на PR-маршрутах «skeleton + client-hydration» (h1 + layout, данные
> подтягиваются на клиенте). Это не закрывает реальную цель: индексация
> **карточек контента** — конкретной трансляции «Carlsen vs Nakamura
> 2026», конкретного турнира, профиля игрока, страницы тренера, лекции,
> архивной партии. Бот видит каркас раздела, в выдачу попадает один
> URL (раздел) — а не сотни карточек, из-за которых пользователь сюда
> приходит из поиска.
>
> Новая редакция строит per-entity модель: для каждой сущности — свой
> механизм (cron / on-demand / SSR / гибрид) исходя из объёма, частоты
> обновлений и стоимости.

### 7.1. Цели и принципы

Цель — каждая публично-открытая карточка контента (broadcast, tournament,
player, coach, lecture, archive-game, archive-player) индексируется
как отдельный URL с уникальным title, description, og:image, h1 и
содержательным телом. Skeleton-режим прежней редакции — только fallback,
когда entity не покрыта пререндером.

Принципы:

- **P1.** HTML с реальным контентом каждой карточки должен лежать на
  origin (S3) до запроса бота. Никаких «генерируем за время ответа» —
  это вынудит идти в SSR с задержкой ответа на сотни мс и риском cloak'инга.
- **P2.** Свежесть HTML определяется бизнес-смыслом сущности, не
  «как чаще, тем лучше». Профиль тренера — день. Live-турнир — десятки
  минут (раунд + таблица), не покадровая партия.
- **P3.** Объём карточек, попадающих в pre-render — ограничен сверху
  явной policy (top-N, фильтр published, фильтр rating). Полный обход
  миллионов архивных партий бессмыслен и взрывает стоимость.
- **P4.** Один общий механизм рендера (headless Chromium) для всех
  сущностей. Per-entity отличия — только в triggers (cron/on-demand) и
  policy (что попадает в очередь).
- **P5.** Боту и пользователю отдаём **одну и ту же HTML**. CloudFront
  маршрутизирует по path, не по User-Agent → нет cloaking-риска
  (Google штрафует за расхождение бот vs браузер). См. §7.3.4.
- **P6.** Динамические данные (живой счёт партии, последний ход)
  поверх отрендеренного HTML — догрузка SPA на клиенте, без потери
  SEO-содержимого.

### 7.2. Per-entity таблица

Объёмы — оценка по фактам из ADR-018/027 (archive), ADR-021 (broadcast),
ADR-119 (lectures) + здравый смысл по продуктовым сущностям.
Точная сверка объёмов на момент запуска — отдельная сверка с backend
до §10 шагов 13–18.

| Сущность | URL | Оценка объёма | Частота изменений | Стратегия | TTL до перегенерации |
|---|---|---|---|---|---|
| Broadcast (трансляция) | `/broadcasts/:tid` | ~30–50 активных + ~500 завершённых в год | Live: ход в минуту; meta: статически | cron + on-demand | active: 15 мин; finished: 1 раз при finish + on-demand при ручной правке |
| Broadcast round | `/broadcasts/:tid/:rid` | ~10–20 раундов/турнир → ~5–10k всего | Аналогично | cron + on-demand | как у parent |
| Broadcast game | `/broadcasts/:tid/:rid/:gid` | ~5–40 партий/раунд → 25–400k потенциально | Live: ход в десятки секунд | **не пре-рендерим в первой волне** — top-N важных по rule (см. §7.4) | — |
| Tournament (арена) | `/tournaments/:id`, `/arena/:id` | ~10–50 активных + сотни завершённых | Расписание стабильно, таблица меняется | cron + on-demand | active: 30 мин; finished: при завершении + on-demand |
| Player | `/player/:username` | Все зарегистрированные (на старте сотни/тысячи, цель — десятки тысяч) | Рейтинг после партии | top-N + on-demand | top-1000 по рейтингу: 24 ч; остальные: только on-demand при первой индексации (см. §7.4.2) |
| Coach | `/coach/:username` | Десятки (на старте), сотни (год) | Меняется редко (раз в неделю-месяц) | on-demand + cron safety-net | on-demand: сразу при сохранении; cron: раз в сутки |
| Lecture | `/lectures/:id` | Десятки → сотни | Описание стабильно после publish | on-demand + cron safety-net | on-demand: при publish/update; cron: раз в сутки |
| Lectures list | `/lectures` | 1 страница | Список меняется при добавлении лекции | cron 30 мин + on-demand на publish | 30 мин |
| Archive game | `/archive/games/:id` | ~4.14M сейчас → ~10M через год (ADR-027) | Статично после импорта | **top-N по policy** (см. §7.4.3) | при импорте + raw HTML архивный (не обновляется) |
| Archive player | `/archive/players/:slug` | Десятки тысяч уникальных в TWIC | Появляются партии — обновляется список | top-N по rating + on-demand на heavy traffic | top-1000: 24 ч; остальные: skeleton |
| Live analysis viewer | `/live/:slug` | Десятки одновременных, сотни накопленных | Real-time | **намеренно `noindex`** (ADR-110, остаётся) | — |
| Archive list | `/archive` | 1 страница | Растёт по факту импорта | cron 1 раз/сутки | 24 ч |

### 7.3. Архитектура prerender-сервиса

Новый компонент `apps/prerender-service` (либо набор Lambda — выбор в
§7.3.5). Один общий механизм для всех сущностей §7.2. Триггеры —
разные.

#### 7.3.1. Поток (диаграмма)

```mermaid
flowchart LR
    subgraph Triggers
        Cron[EventBridge cron]
        Mutation[Backend mutation hook]
        Webhook[Lichess SSE / broadcast-worker]
    end
    Cron --> Queue[(SQS prerender-tasks)]
    Mutation --> Queue
    Webhook --> Queue
    Queue --> Worker[prerender-worker\n(ECS / Lambda)]
    Worker -->|headless Chrome| SPA[SPA dev origin]
    Worker -->|PUT| S3[(S3 kingside-prerender)]
    S3 --> CF[CloudFront]
    CF --> Bot[Бот / пользователь]
    Worker -->|invoke| OG[og-image-generator\n(Lambda + canvas)]
    OG --> S3og[(S3 kingside-og)]
```

#### 7.3.2. Триггеры

- **Cron (EventBridge schedule)** — 4 schedule'а по частоте:
  - `prerender-broadcasts-active` — каждые 15 мин, перечисляет активные
    трансляции через `GET /broadcasts?status=active`, кладёт в SQS.
  - `prerender-tournaments-active` — каждые 30 мин.
  - `prerender-players-top1000` — раз в сутки, выбирает top-1000 по
    суммарному рейтингу (`bullet + blitz + rapid` / 3).
  - `prerender-lectures-list` — каждые 30 мин (1 task для `/lectures`).
  - `prerender-archive-list` — раз в сутки (1 task для `/archive`).
  - Coach / Lecture / Archive player top-N — раз в сутки safety-net.

- **On-demand (backend mutation hook)** — backend publish/update в
  сущность вызывает `prerenderClient.enqueue(entity, id)`. Ставит task
  в ту же SQS с приоритетом «high».
  - `CoachService.updateProfile()` → enqueue `coach:<id>`.
  - `LectureService.publish()` / `update()` → enqueue `lecture:<id>` +
    `lectures-list`.
  - `BroadcastService.finishRound()` → enqueue `broadcast:<tid>:<rid>`.
  - `ArenaService.finish()` → enqueue `tournament:<id>`.

- **Webhook (broadcast-worker — для live)** — отдельный лёгкий триггер:
  при finished-round broadcast-worker (ADR-021) шлёт enqueue. Между
  finished-round и cron-окном (15 мин) HTML обновляется сразу.

#### 7.3.3. Воркер

- ECS task (Fargate, 1 vCPU, 2 GB RAM) — на старте 1 инстанс, scale
  до 4 при глубине очереди > 100. Альтернатива — Lambda с
  [Chrome layer](https://github.com/alixaxel/chrome-aws-lambda); см.
  §7.3.5.
- Внутри — Playwright headless Chromium (как `apps/web/scripts/prerender.mjs`).
- Слушает SQS, обрабатывает task: открывает URL **на staging-копии
  SPA** (не на проде! важно — см. §7.3.6), даёт SPA подтянуть данные
  через **реальный API** (broadcast-service, api, archive-service),
  ждёт «mount complete» (та же эвристика, что и в текущем prerender.mjs),
  снимает `outerHTML`, пишет в S3.
- Путь S3: `s3://kingside-prerender-store/<entity>/<id>.html`,
  например `s3://kingside-prerender-store/broadcasts/abc123.html`.
- Caching: ETag по hash контента; если совпадает с предыдущим — `PUT`
  не делать (экономия CloudFront invalidation'ов).

#### 7.3.4. CloudFront-маршрутизация (без User-Agent sniffing)

Принцип P5: одна и та же HTML отдаётся боту и пользователю. CloudFront
Function на `viewer-request`:

```js
function handler(event) {
  var uri = event.request.uri;
  // /broadcasts/<id> → /broadcasts/<id>/index.html
  var m = uri.match(/^\/(broadcasts|tournaments|arena|lectures|coach|player|archive\/games|archive\/players)\/([^\/]+)\/?$/);
  if (m) {
    var key = '/' + m[1] + '/' + m[2] + '/index.html';
    event.request.uri = key;
  }
  return event.request;
}
```

S3 origin behavior: при `404 NoSuchKey` (карточка вне policy / не
пререндерена) — CloudFront отдаёт корневой SPA `index.html` с 200.
Бот тогда видит skeleton (как сегодня); пользователь получает SPA
как обычно.

**Cloaking-риск минимальный** — render-результат тот же, что отдаст
SPA в браузере после полной загрузки. Google объявляет, что
prerender-сниппеты (где боту и пользователю отдаётся идентичный
снапшот) — нормальная практика. Расширенная сверка с Google Search
Console после выкатки.

#### 7.3.5. Воркер: ECS vs Lambda

| Параметр | ECS task | Lambda с Chrome |
|---|---|---|
| Старт | долго живёт, прогрет | 200–500 мс cold start |
| Стоимость | $20–40/мес фиксировано (1 task 24/7) | пропорционально вызовам |
| Параллелизм | scale 1→4, Chrome держится | до 1000 concurrent, но каждый — свой Chrome |
| Память | контролируется taskdef (2 GB запас) | 3 GB max, [chrome-aws-lambda] |
| Деплой | docker image (тяжёлый из-за Chrome) | layer (готовый) |

Рекомендация: **ECS task** на MVP. Lambda дешевле при < 100 task/день,
дороже при > 1000 task/день. Наш профиль (cron + on-demand) даёт
~200–500 task/день — на стыке выгодности; ECS даёт предсказуемость и
лёгкий reuse browser instance.

#### 7.3.6. Где живёт SPA origin для prerender

Воркер не должен биться в прод-фронт (CloudFront) — это даст
зацикливание (CF → S3 prerender → SPA → CF). Варианты:

- (i) **Локальный static-server в task** — на старте таска поднимаем
  http-сервер над dist-папкой (как текущий `prerender.mjs:96`). Минусы:
  нужно тянуть актуальный `dist/` в образ; пересборка фронта = пересборка
  prerender-service.
- (ii) **Отдельный S3-staging bucket** — каждый деплой фронта пишет
  копию `dist/` в `s3://kingside-frontend-staging/` (без CloudFront);
  воркер тянет index.html через S3 SDK + локально подменяет API_BASE на
  внутренний.
- (iii) **Внутренний ALB → staging frontend service** — отдельный nginx
  с актуальной dist'ой, доступен только из VPC. Сложно.

Рекомендация: **(i) local static-server** + bind-mount `dist/` через
volume или сборка в одном CI с фронтом. Это симметрично текущему
`prerender.mjs`-скрипту build-time.

#### 7.3.7. Backend mutation hooks (on-demand)

Минимальный интерфейс backend → prerender:

```ts
// packages/shared/prerender-client.ts
interface PrerenderClient {
  enqueue(task: PrerenderTask): Promise<void>;
}

type PrerenderTask =
  | { kind: 'broadcast'; tid: string; rid?: string }
  | { kind: 'tournament'; id: string }
  | { kind: 'coach'; username: string }
  | { kind: 'lecture'; id: string }
  | { kind: 'player'; username: string }
  | { kind: 'archive-game'; id: string }
  | { kind: 'archive-player'; slug: string }
  | { kind: 'list'; route: '/broadcasts' | '/tournaments' | '/lectures' | '/players' | '/archive' };
```

Имплементация — `SendMessage` в SQS. От backend требуется: одна
строка `await prerenderClient.enqueue({...})` после успешной
mutation. Без `await`-блокировки бизнес-логики — fire-and-forget с
log на error.

### 7.4. Policy: что попадает в pre-render

#### 7.4.1. Broadcasts

- **active** = `status IN ('upcoming', 'ongoing')`, **finished** = `status='finished'`.
- Active — все (десятки). Cron 15 мин.
- Finished — все, но генерируются 1 раз при `finishRound()` (on-demand)
  + cron-safety раз в сутки на последние 7 дней.
- `/broadcasts/:tid/:rid/:gid` (партия внутри раунда) — **не индексируем
  индивидуально** в первой волне (объём 25–400k). Top-N (например,
  10 партий месяца по avgElo) — отдельный follow-up §11.2.

#### 7.4.2. Players

- top-1000 по суммарному рейтингу — cron раз в сутки.
- Остальные — skeleton-fallback (SPA) до факта индексации. Когда
  Yandex/Google запрашивает `/player/<rare-username>`, CloudFront отдаёт
  SPA, **бот видит loading→content через client JS** (только Google
  WRS его обработает, Яндекс — нет; и это намеренно: индексировать
  десятки тысяч малозначимых профилей бесцельно).
- **Alternative** для долгосрочной перспективы: on-demand при первой
  индексации (WAF detect bot → fire-and-forget enqueue). Не делаем
  на MVP — §11.3.

#### 7.4.3. Archive

- `/archive/games/:id` (~4.14M, рост 6M/год) — **policy-фильтр**:
  только партии где `avgElo >= 2400` И (или) хотя бы один игрок в
  TWIC top-1000. Эмпирически даст ~50–100k партий — реальный SEO-
  объём, не миллионы. Cron безразлично частота (контент статичен
  после импорта); генерируется один раз при импорте через
  `ArchiveImporterService.afterImport(gameId)` → enqueue.
- `/archive/players/:slug` — top-1000 по сумме партий ИЛИ peak rating
  ≥ 2400. Cron раз в сутки.
- Остальные — `noindex` через runtime meta + SPA-fallback.
- **Альтернатива**: не индексировать `/archive/*` вообще на первой
  волне, открыть позднее. §11.4.

#### 7.4.4. Coaches, lectures, tournaments

Всё что published — попадает. Десятки штук, оверхеда нет. On-demand
триггеры backend'а §7.3.7.

### 7.5. og:image (превью в мессенджерах)

Telegram, Slack, WhatsApp, ВК берут `og:image` из мета-тегов. Размер
1200×630, JPEG/PNG. Варианты:

- (a) **Один статический og:image** на весь сайт (логотип Kingside) —
  работает, но превью у всех ссылок одинаковое. Низкая ценность для
  трансляций (хотим видеть «Carlsen vs Nakamura», не логотип).
- (b) **Per-section static** — у `/broadcasts` свой логотип, у
  `/lectures` свой и т. д. По одному PNG в `apps/web/public/og/`.
- (c) **Динамический генератор** — Lambda + `node-canvas` + `chess.js`:
  - для broadcast — доска текущей позиции + имена игроков + результат;
  - для player — аватар + рейтинги в формате карточки;
  - для lecture — обложка + название;
  - для tournament — флаг/название + дата + призы.
  - Кэш в S3 + CloudFront 1 час.

**Рекомендация**: (b) для волны 1, (c) для волны 2 как отдельный сервис
`apps/og-image-service` (Lambda Function URL за CloudFront). На live-
обновляемых сущностях (broadcast game) (c) даёт большой UX-бонус —
preview партии в мессенджере с актуальной доской.

Динамический генератор работает по URL `/og/<entity>/<id>.png`,
вызывается из `<meta property="og:image">` уже отрендеренной prerender'ом
страницы. Lambda сама дёргает API → рендерит SVG (chess.js + svg-board) →
конвертит в PNG → пишет в S3 с TTL.

### 7.6. Содержание HTML на каждой карточке

Стандартный набор полей в `<head>` (через `react-helmet-async`,
заполняется в компоненте страницы):

- `<title>` — entity-specific, ≤ 60 символов.
- `<meta name="description">` — ≤ 160 символов.
- `<link rel="canonical">` — URL без query.
- `<meta property="og:type">` — `website` / `article` / `event` /
  `profile` (по сущности).
- `<meta property="og:title">`, `og:description`, `og:image`,
  `og:url`.
- `<meta name="twitter:card">` — `summary_large_image`.
- JSON-LD `application/ld+json` — Schema.org schema по типу:
  - `SportsEvent` для broadcast/tournament,
  - `Person` для player/coach,
  - `Course` для lecture,
  - `Article` для archive game (с PGN как `articleBody`).

В `<body>`:

| Сущность | h1 | Содержательный текст |
|---|---|---|
| Broadcast | «{tournament name} — {round name}» | Описание турнира, имена игроков, time-control, призы, расписание раундов, текущая таблица |
| Tournament | «{tournament name}» | Формат, time-control, призы, регламент, расписание, список зарегистрированных (имена, рейтинги) |
| Player | «{username} — {peakRating} bullet/blitz/rapid» | Рейтинги по time-control, статистика партий, history blocks, кол-во побед, страна |
| Coach | «{name} — chess coach» | Описание (markdown), цены за лекцию, расписание, отзывы, ссылки на лекции |
| Lecture | «{title} — by {coach}» | Описание, дата, длительность, превью, цена, программа |
| Archive game | «{white} vs {black} ({result}) — {event}» | Дата, турнир, дебют, PGN рендерится в `<noscript>` + интерактивная доска на клиенте |
| Archive player | «{name} archive» | Кол-во партий, peak rating, range дат, топ-партии, ссылки на каждую |

Подробные тексты — content (пользователь, без chess-expert, KS-4126).

### 7.7. Унифицированный `<MarketingLanding>` для PM

```tsx
interface MarketingLandingProps {
  i18nKey: string;
  heroImage: string;
  ctaPrimary: { label: string; href: string };
  ctaSecondary?: { label: string; href: string };
  sections: Array<{
    h2Key: string;
    bodyKey: string;
    imageKey?: string;
  }>;
}
```

Каждый PM-маршрут (`/play`, `/workshop`, `/precision`, `/puzzle-rush`,
`/drills`, `/opening-trainer`, `/blind-board`, `/features`) — это
конфиг для `<MarketingLanding>` + переводы в `i18n` (en, ru, будущие).

PM-страницы — build-time prerender (текущий `apps/web/scripts/prerender.mjs`).
Динамический поток (cron + on-demand) их не касается. Шаблон даёт
SEO-консистентность (одна структура h1/h2/og).

### 7.8. Метатеги через `react-helmet-async`

Каждая PR/PM/PX страница ставит свои `<title>`, `<meta>`, `<link
rel="canonical">`, `<meta property="og:*">` через `react-helmet-async`
(или эквивалент). Это работает и в runtime SPA, и в обоих pre-render
пайплайнах (build-time для PM, runtime для PR).

ADR фиксирует **требование**: каждый PR/PM маршрут обязан иметь свой
title + description + canonical + og:image **перед открытием в prod**.
Контент-копирайт — отдельный тикет KS-5 / KS-новый.

### 7.9. `noindex` для public-mixed без контента

`/analysis/public/:id` уже ставит `noindex` через useEffect
(подтверждено ADR-110, аналогично `LiveAnalysisViewerPage`).
`/live/:slug` — намеренно остаётся без prerender и с runtime `noindex`.
`/lectures/:id/replay` — `noindex` (приватная запись).

Pre-render этих маршрутов не делает (не в policy §7.4) — путь бот
получает только по shared-ссылке.

### 7.10. sitemap.xml

`PUBLIC_ROUTES` (build-time реестр) уже несёт `priority` и `changefreq`
для статических PR/PM. Динамические карточки требуют **отдельного
sitemap-index'а** с per-entity sitemap'ами:

```
/sitemap.xml                 (index)
  /sitemap-static.xml        (15-20 PM/PR-лендингов из PUBLIC_ROUTES)
  /sitemap-broadcasts.xml    (active + finished за 12 мес)
  /sitemap-tournaments.xml   (active + finished за 12 мес)
  /sitemap-players.xml       (top-1000)
  /sitemap-coaches.xml       (all published)
  /sitemap-lectures.xml      (all published)
  /sitemap-archive-games.xml (policy-фильтр §7.4.3)
  /sitemap-archive-players.xml (top-1000)
```

Per-entity sitemap'ы генерируются backend'ом (тем же модулем, который
ставит mutation hook §7.3.7) и пишутся в S3. Cron-обновление синхронно
с pre-render policy (раз в сутки достаточно).

Это **расширение** KS-4116 follow-up задачи на sitemap-автогенерацию.

### 7.11. Влияние на `apps/web/scripts/prerender.mjs`

Текущий build-time скрипт **не меняется**. Он закрывает PM-лендинги
+ статические PR-лендинги (`/puzzles` каталог, `/feedback` лист и т. п.).

Динамические карточки — **отдельный пайплайн** (новый
`apps/prerender-service`, §7.3). Слияние не имеет смысла: разные
жизненные циклы (build-time vs runtime), разные триггеры (deploy vs
cron+mutation), разные исходники (dist/ vs S3-staging frontend +
реальный API).

В `PUBLIC_ROUTES` для каждой динамической сущности добавится
**прототип-путь** с шаблоном, но build-time prerender его пропускает
(новое поле `dynamic: true`). Sitemap-генератор использует эти
прототипы для перечисления реальных id через API.

---

## 8. Приоритизация

Принцип: первым делать то, где (наибольший SEO-объём) × (минимум
работы) × (нет зависимости от других тикетов).

> **Ревизия 2026-06-14 (KS-4125).** Волны 3 (PM-лендинги) и 5 (часть
> про лендинги) удалены. Вместо них — волна «открыть PF-тренажёры
> гостю» (паттерн A, §6.1). Backend-работа сосредоточена на
> допущении `user==null` в путях записи (graceful no-op + 401 на
> mutation), не на новых GET-эндпоинтах для лендингов.

### Волна 1 — открыть PR-витрины + поднять prerender-сервис

Параллельные потоки:

1. **`/broadcasts`, `/tournaments`, `/players`, `/feedback`, `/lectures`**
   — снять `ProtectedRoute` (frontend, KS-4119), открыть GET-эндпоинты
   с `OptionalJwtGuard` (backend, KS-4118).
2. **Исправить `/features`** (KS-4119 п.2). Отдельный компонент от `/`.
3. **`apps/prerender-service`** — заготовка (§7.3): SQS, ECS task с
   Playwright, S3 bucket, CloudFront маппинг §7.3.4.
4. **Компонент `<GuestCTA>`** (§6.7) — единый шаблон inline-CTA для
   всех PF-страниц последующих волн.

### Волна 2 — динамический prerender по приоритету сущностей

5. **Lectures + Coaches** (низкий объём, on-demand-only) — mutation
   hooks (§7.3.7), sitemap, метатеги + JSON-LD.
6. **Tournaments** (cron 30 мин + on-demand `ArenaService.finish`).
7. **Broadcasts** (cron 15 мин для активных + on-demand при
   `finishRound`).

### Волна 3 — открыть PF-тренажёры гостю (вместо старой «PM-лендинги»)

Каждый — отдельный тикет (frontend + backend, §10):
- снять `ProtectedRoute` с роута;
- backend: в путях записи (`POST /<entity>/attempt`, `POST
  /scores`, `POST /<entity>/session/finish`) добавить ветку
  `user==null → no-op` (тренажёр продолжает работать, ничего не
  пишем); 401 остаётся ТОЛЬКО для запросов, которые подразумевают
  ownership (`PATCH /attempts/:id`);
- frontend: на странице добавить `<GuestCTA variant="banner">`;
- проверить, что score/сессия в памяти работают корректно (key=
  refresh обнуляет — это нормальное поведение для гостя).

8. **`/puzzle-rush`** — снять `ProtectedRoute`, гость играет, score
   локальный, лидерборд не пишется, лидерборд показывается.
9. **`/drills`, `/drills/sprint*`, `/drills/:type`** — снять
   `ProtectedRoute`. Sprint-results для гостя — локальные.
10. **`/blind-board`, `/blind-board/sessions/:id`** — снять
    `ProtectedRoute`. Stats/history гостю уже работают (§5.13) —
    проверить тестами.
11. **`/guess`, `/guess/sessions/:id`, `/guess/stats`, `/guess/history`**
    — снять `ProtectedRoute` для лендинга и stats; sessions/:id может
    остаться PV (ownership).
12. **`/play` + `/lobby`** — снять `ProtectedRoute`. Гостю: «играть с
    ботом» открыто, «играть онлайн» / «принять вызов» через
    `useRequireAuth` (паттерн B). UI решение лобби — frontend.

### Волна 4 — top-N policy для players и archive

13. **Players top-1000** — cron + sitemap (§7.4.2).
14. **Archive games policy** (avgElo ≥ 2400 или TWIC top-1000) —
    `afterImport` hook (§7.4.3). Пороги — пользователь + marketing.
15. **Archive players top-1000** — аналогично.

### Волна 5 — открытие caталога курсов гостю

16. **`/lessons`, `/lessons/discover`** — открыть каталог системных
    курсов гостю (зависит от ADR-026 / ADR-054, продуктовая сверка с
    пользователем + content). PF: гость пробует первый урок без
    сохранения прогресса, inline-CTA «войди чтобы продолжить». §11.2.

### Волна 6 — динамический og:image и top-N broadcast games

17. **og:image** (§7.5) — генерация PNG внутри prerender-service.
18. **Top-N broadcast games** — partial card prerender по rule
    (avgElo, GM-вес).

### Волна 7 — спорные тренажёры

19. **`/workshop`** (PF) — открыть верх (анализ позиции) гостю,
    sidebar «Мои анализы» через guest-CTA. Может потребовать
    рефакторинга текущего layout — отдельный тикет, не блокирует
    остальное.
20. **`/opening-trainer`** — решение по §11.12 (гостю показывать
    системный демо-репертуар или оставить за логином без лендинга).

---

## 9. Сводный пример (диаграмма)

```mermaid
flowchart TD
    Guest[Гость без JWT]
    Login[/login]
    Modal[LoginRequiredModal]

    Guest -->|GET /puzzles| Puzzles[/puzzles\nPR: каталог]
    Puzzles -->|click solve| Modal
    Modal -->|success| Puzzles

    Guest -->|GET /broadcasts| Broadcasts[/broadcasts\nPR: список]
    Broadcasts -->|enter game| Game[/broadcasts/:id\nPR: read partii]
    Game -->|write chat| Modal

    Guest -->|GET /play| PlayLanding[/play\nPM: лендинг]
    PlayLanding -->|CTA start| Login

    Guest -->|GET /settings| Login

    Guest -->|prerender bot| Prerender[Prerender HTML]
    Prerender -->|content| Puzzles
    Prerender -->|landing| PlayLanding
    Prerender -->|skeleton| BroadcastsPR[Broadcasts SPA-fallback]
```

---

## 10. Декомпозиция тикетов

После утверждения ADR координатор переписывает scope KS-4118 / KS-4119
под решения отсюда и создаёт новые тикеты по нумерации ниже. Все
размеры — оценка архитектора, может пересмотреть исполнитель.

> **Ревизия 2026-06-14 (KS-4125).** Удалены тикеты KS-4 (шаблон
> `<MarketingLanding>`) и KS-5 (контент лендингов). Добавлен KS-22
> (компонент `<GuestCTA>`), KS-23 (миграция существующих inline-CTA
> на `<GuestCTA>`), KS-24..KS-29 (открытие PF-тренажёров гостю).
> Нумерация старых тикетов сохранена.
>
> **Ревизия 2026-06-14 (KS-4126).** KS-30 переформулирован из research
> в имплементацию (`/opening-trainer` гостю — вариант (b) с реальным
> демо-репертуаром). Добавлены KS-31 (seed демо-репертуаров для
> opening-trainer) и KS-32 (seed демо-партий для workshop сайдбара).
> Из тикетов KS-13, KS-16 убран chess-expert как соисполнитель —
> содержательный контент по всему ADR-128 даёт пользователь.

| # | Тикет | Что | Исполнитель | Размер | Зависит от |
|---|-------|-----|-------------|--------|------------|
| 1 | KS-4118 (rewrite) | Backend: открыть `GET /broadcasts*`, `GET /arena*`, `GET /players*`, `GET /coaches/*`, `GET /feedback*`, `GET /lectures*` через `OptionalJwtGuard`; throttler 60 req/min на IP; скрыть приватные поля DTO | backend | M | этот ADR |
| 2 | KS-4119 (rewrite) | Frontend: снять `ProtectedRoute` с витрин; рендер для гостя; починить `/features` | frontend | M | 1 |
| 3 | KS-4124 (done) | Frontend: `<LoginRequiredModal>` + `useRequireAuth` + `RequireAuthProvider` | frontend | M | этот ADR |
| ~~4~~ | ~~MarketingLanding~~ | **Отменён (KS-4125).** Шаблон не вводится. | — | — | — |
| ~~5~~ | ~~Контент лендингов~~ | **Отменён (KS-4125).** Гость попадает на сам тренажёр. Контент `/features` остаётся в KS-4119 п.2 | — | — | — |
| 6 | KS-новый | Frontend: внедрить `useRequireAuth` в action-кнопки витрин (`/broadcasts/:id` чат, `/tournaments/:id` register, `/players/:u` вызов/сообщение, `/feedback` голос/коммент). Образец готов — `PlayerProfilePage`, `TournamentLobbyPage` | frontend | M | 3 |
| 7 | KS-новый | Frontend: SEO-метатеги per-route + JSON-LD через `react-helmet-async`; по странице на PR/PF/PX маршрут | frontend + content | L | 1, 2 |
| **DYNAMIC PRERENDER (KS-4121)** | | | | | |
| 8 | KS-новый | DevOps: SQS `kingside-prerender-tasks`, S3 `kingside-prerender-store`, IAM, CloudFront Function маппинг путей §7.3.4 | devops | M | 1 |
| 9 | KS-новый | Backend: `apps/prerender-service` (ECS Fargate + Playwright), слушает SQS, рендерит, кладёт в S3 | backend + devops | L | 8 |
| 10 | KS-новый | Shared: `packages/shared/prerender-client.ts` (SQS sendMessage с типизацией) | backend | S | 8 |
| 11 | KS-новый | Backend: mutation hooks для on-demand prerender (`CoachService.updateProfile`, `LectureService.publish`/`update`, `ArenaService.finish`, `ArchiveImporterService.afterImport`; broadcast-worker `finishRound`) | backend | M | 9, 10 |
| 12 | KS-новый | DevOps: EventBridge schedule'ы (broadcasts-active 15 мин, tournaments-active 30 мин, lectures-list 30 мин, players-top1000 24 ч, archive-list 24 ч, safety-net 24 ч) | devops | M | 9 |
| 13 | KS-новый | Backend: policy-фильтры (§7.4) для players (top-1000) и archive (avgElo ≥ 2400 / TWIC top-1000) — пороги согласовать с пользователем + marketing (без chess-expert) | backend + marketing | M | 9 |
| 14 | KS-новый | Frontend+content: расширение `react-helmet-async` метатегами + JSON-LD (`SportsEvent`, `Person`, `Course`, `Article`) на каждой PR/PF-карточке | frontend + content | L | 7, 9 |
| 15 | KS-новый | Backend: per-entity sitemap'ы (`sitemap-broadcasts.xml`, …) + sitemap-index | backend | M | 11 |
| 16 | KS-новый | Content: SEO-форматы заголовков карточек (broadcast «{tournament} — {round}», player, coach, lecture, archive game). Контент — пользователь, без chess-expert | content | L | 14 |
| 17 | KS-новый | DevOps+backend: og:image (внутри prerender-service или отдельная Lambda — §11.9) | devops + backend | L | 9 |
| **ОТКРЫТИЕ КАТАЛОГОВ И PF-ТРЕНАЖЁРОВ (KS-4125)** | | | | | |
| 18 | KS-новый | Backend: `GET /lobby/open-challenges` (волна 3, для `/lobby` PF) | backend | S | 1 |
| 19 | KS-новый | Backend+frontend: открыть `/lessons`, `/lessons/discover` каталог гостю (волна 5, §11.2) | backend + frontend | M | 1 |
| 20 | KS-новый | Frontend: обновить `PUBLIC_ROUTES` реестр (флаг `dynamic: true` для шаблонных путей) | frontend | XS | 2 |
| 21 | KS-новый | Architect: поднять ADR-128 Proposed → Accepted после волны 2, обновить фактами SEO-замеров | architect | S | 1–14 |
| 22 | KS-новый | Frontend: компонент `<GuestCTA>` (§6.7) — единый шаблон inline-CTA с вариантами `banner` / `section` / `inline`, data-testid, data-auth | frontend | S | этот ADR |
| 23 | KS-новый | Frontend: миграция существующих inline-CTA на `<GuestCTA>` — `PuzzlePage`, `PrecisionStatsPage`, `PrecisionHistoryPage`, `BlindBoardStatsPage`, `BlindBoardHistoryPage`, `GuessStatsPage`, `WorkshopAnalysisList`. Только консистентность, без поведенческих изменений | frontend | M | 22 |
| 24 | KS-новый | Frontend+backend: открыть `/puzzle-rush` гостю (паттерн A). Backend: `POST /puzzle-rush/scores` при `user==null` → no-op (без 401), лидерборд для гостя read-only | frontend + backend | M | 1, 22 |
| 25 | KS-новый | Frontend+backend: открыть `/drills`, `/drills/sprint*`, `/drills/:type` гостю (паттерн A). Backend: `POST /drills/sprint/result` → no-op для гостя | frontend + backend | M | 1, 22 |
| 26 | KS-новый | Frontend+backend: открыть `/blind-board` гостю (паттерн A). Stats/history уже шаблонны (§5.13), проверить тестами | frontend + backend | S | 1, 22 |
| 27 | KS-новый | Frontend+backend: открыть `/guess` лендинг + stats гостю (паттерн A). `GUESS_ENTRY_ENABLED`-флаг — отдельно. `/guess/sessions/:id` ownership — оставить PV | frontend + backend | S | 1, 22 |
| 28 | KS-новый | Frontend+backend: открыть `/play` + `/lobby` гостю (PF). Гостю: «играть с ботом» open, «играть онлайн» / «принять вызов» через `useRequireAuth`. Backend: матчмейкинг и ws-handshake без JWT не обслуживаются (401 на subscribe) | frontend + backend | L | 1, 3, 18, 22 |
| 29 | KS-новый | Frontend+backend: открыть `/workshop` гостю (PF). Анализ позиции — полнофункциональный (без CTA на инструменте). Сайдбар «Мои анализы» гостю замещается на **демо-список классических партий** (§11.14, контент-seed KS-32). Кнопка «Сохранить» — модалка через `useRequireAuth`. PGN-импорт работает в memory. Backend: `POST /workshop/analyses` для гостя → 401 (PR, см. §11.13) | frontend + backend | M | 1, 22, 32 |
| 30 | KS-новый | Frontend+backend: открыть `/opening-trainer` гостю (PF, §11.12). Главная раздела с секцией «Демо-репертуары» (KS-31). `GET /opening-trainer/demo` + `GET /opening-trainer/demo/:id` open-эндпоинты. Сессия по демо: `POST /opening-trainer/sessions` → 204 для гостя (no-op). Прогресс по узлам — localStorage. Auth-private маршруты (`/opening-trainer/new`, `:id`, `reviews`) остаются `ProtectedRoute` | frontend + backend | M | 1, 22, 31 |
| 31 | KS-новый | Backend: seed-данные демо-репертуаров для `/opening-trainer` (§11.12). Несколько содержательных репертуаров от пользователя (примеры: Найдорф, Дебют ферзевых пешек, Английское начало). Формат: JSON-seed файлы в `apps/api/src/opening-trainer/seeds/demo-repertoires/*.json` (или эквивалентная таблица — выбор за backend). **Контент даёт пользователь, не chess-expert.** Backend задаёт только структуру и загрузчик | backend (контент — пользователь) | M | 30 |
| 32 | KS-новый | Backend: seed-данные демо-партий для сайдбара `/workshop` (§11.14). Несколько классических партий с аннотациями от пользователя (примеры: Капабланка, Алехин, Карлсен). Формат: PGN-файлы + sidecar `meta.json` (title, white/black, event, date, tags) в `apps/api/src/workshop/seeds/demo-games/`. Эндпоинты: `GET /workshop/demo-games`, `GET /workshop/demo-games/featured` (детерминированная ротация дня/недели). **Контент даёт пользователь, не chess-expert** | backend (контент — пользователь) | M | 29 |

---

## 11. Открытые вопросы

> **Ревизии**: §11.1, §11.4 закрыты KS-4121 (см. помету «resolved»
> ниже). KS-4125 добавил §11.12–§11.14. **KS-4126 закрыл §11.12,
> §11.13, §11.14** — пункты ниже содержат принятые пользователем
> решения, не открытые вопросы. Прежний §11.12 (S3 layout) переименован
> в §11.15, чтобы порядок появления пунктов соответствовал номерам.

### 11.1. ~~Где брать данные для prerender PR-маршрутов~~ — **resolved**

Решено в §7.3: prerender-service ходит за реальными данными во
внутренний API из ECS-task'а (не на прод-CloudFront, чтобы не
зациклиться — §7.3.6 (i)). Build-time prerender для PM остаётся без
изменений.

### 11.2. `/lessons` каталог для гостя

ADR-026 / ADR-054 описывают user-courses и system-courses. Каталог
системных курсов потенциально open, но gate `lessonsEnabled` сейчас
держит весь namespace под флагом. Открытие для гостя требует:
- backend: открыть `GET /courses/system?published=true` для анонимов;
- frontend: `<DiscoverCoursesPage>` (уже без auth) + лендинг
  раздела `/lessons` для гостя;
- продуктовая сверка с **пользователем + content** (без chess-expert,
  KS-4126) на тему, какие курсы и какой free-preview подходят для
  индексации.

Не делаем в волне 1–2 — слишком много продуктовых вопросов.

### 11.3. Onboarding после регистрации из модалки

После успешной регистрации через `<LoginRequiredModal>` пользователь
оказывается в середине сценария. Inline-onboarding в той же модалке
или баннер в `<MainLayout>` до его прохождения — отдельная задача с
пользователем.

### 11.4. ~~SSR / server-side prerender для динамических сегментов~~ — **resolved**

Решено в §7.3 (отдельный воркер с Playwright, не Lambda@Edge,
не SSR-в-приложении). Cloaking-риск закрыт CloudFront mapping'ом
по path, не по User-Agent (§7.3.4, P5).

### 11.5. Чьи метатеги выигрывают: shell `index.html` vs route-specific

Per-route компоненты через `react-helmet-async` (работает и в runtime
SPA, и в prerender). Финальное решение — за frontend в KS-7.

### 11.6. Rate-limit гостя vs DDoS

60 req/min на IP — защита от случайного бота, не от DDoS.
Полноценная DDoS-защита — CloudFront WAF / Cloudflare. Вне scope
ADR-128.

### 11.7. Действия, для которых модалка не подходит

WebSocket-handshake (live-партия, чат трансляции) — после логина
форсируем `socket.io disconnect → reconnect` с новым JWT в handshake.
KS-3 + KS-6.

### 11.8. Policy top-N для players и archive (новый, KS-4121)

§7.4.2 / §7.4.3 предлагают:
- `players` top-1000 по сумме рейтингов (bullet+blitz+rapid) / 3 — порог
  для cron;
- `/archive/games/:id` — фильтр `avgElo ≥ 2400` ИЛИ хотя бы один
  игрок в TWIC top-1000.

Это рабочие первичные пороги, но цифры требуют **продуктовой сверки с
пользователем + marketing** (без chess-expert, KS-4126):
- какой реальный SEO-объём ожидаем (запросы вида «{username} chess
  archive» — измерить через Wordstat / GSC, если есть);
- какой % партий из TWIC попадёт под фильтр (нужна выборка из
  archive-service);
- хотим ли индексировать **не-top архив** (long tail) — это десятки
  гигабайт HTML, реально, но дорого.

Решение — в KS-13 декомпозиции, перед волной 4.

### 11.9. og:image: статический vs динамический (новый, KS-4121)

§7.5 предлагает статический per-section og:image на волне 1 (b) и
динамический генератор `apps/og-image-service` на волне 6 (c).

Открытый вопрос — **стоит ли вообще делать динамический генератор**,
или ограничиться статикой:
- (+) динамический даёт превью партии с актуальной доской в
  Telegram/Slack → виральный эффект для трансляций;
- (-) требует отдельного Lambda + node-canvas + chess.js + node-svg-to-png;
  ~$5–10/мес для текущих объёмов, $50+ при росте;
- (~) альтернатива — генерировать PNG **на стороне prerender-service**
  (он уже headless Chrome с canvas), писать в S3 рядом с HTML. Без
  отдельной Lambda.

Архитектор предлагает: статика на волне 1, генерация **внутри
prerender-service** на волне 6 (не отдельная Lambda). Окончательное
решение — за пользователем после волны 5.

### 11.10. Сверка cloaking-политики с Google Search Console (новый, KS-4121)

§7.3.4 утверждает: prerender-сниппеты, идентичные SPA-результату,
Google не считает cloaking'ом (документация подтверждает). Это
**предположение**, требует сверки **после** запуска первой волны:
- открыть GSC, посмотреть warnings;
- использовать «Url Inspection» на 5–10 карточках, сравнить
  «Google's view» с тем, что отдаёт CloudFront пользователю;
- если расхождения видны → корректировать prerender-логику (например,
  убрать client-side stat-фетчи из inline-script, добавить их в
  prerender-результат).

Это часть KS-21 (Proposed → Accepted после волны 2).

### 11.11. Кол-во инстансов prerender-worker'а (новый, KS-4121)

§7.3.3 предлагает ECS Fargate 1 vCPU / 2 GB RAM, scale 1→4. Пиковый
объём очереди:
- broadcasts active × 4 cron/час × 30 шт = 120 task/час;
- tournaments × 2 × 50 = 100 task/час;
- coaches/lectures on-demand: < 10/час;
- players top-1000 × 1 раз в сутки = 1000 task за окно;
- archive policy при импорте — пик до 5000 task/час на TWIC-выпуске.

В среднем — 200–400 task/час, на пике — 5000+. При 30с на task (включая
Playwright load + screenshot) — 1 инстанс выдаёт ~120/час. Значит на
пике нужно scale до **~40 инстансов**, что для Fargate стоит
~$30–40/мес на пиковом часу, ~$5/мес в среднем.

Альтернатива: **batch-rate-limit** на cron-источниках — TWIC-импорт
не enqueue'ит сразу 5000, а растягивает на ~6 часов (250/час, scale ~3).
Это вариант по умолчанию — §7.3.7 fire-and-forget с throttle.

Окончательно — devops в KS-12 (cron-расписания).

### 11.12. `/opening-trainer` для гостя — **решено (KS-4126): вариант (b) с реальным контентом**

Выбран **вариант (b) — системные демо-репертуары**. Условие: не
пустой шаблон, а несколько готовых содержательных репертуаров
(примеры: «Сицилианская защита Найдорф», «Дебют ферзевых пешек»,
«Английское начало»). Гость проходит их в SRS-flow, прогресс
in-memory; сохранение — модалка `<LoginRequiredModal>` через
`useRequireAuth`.

Требования к реализации (детали — в KS-30, KS-31 декомпозиции):

- **Источник контента — пользователь.** Конкретный набор репертуаров,
  их структуру (ходы, ветки, объяснения, NAG'и) подбирает и
  редактирует **пользователь сам**. Никакой автогенерации, никакого
  привлечения агента chess-expert.
- **Формат хранения** — JSON-seed в backend (предложение архитектора:
  `apps/api/src/opening-trainer/seeds/demo-repertoires/*.json`), либо
  отдельная таблица `demo_opening_repertoires` с `isPublic=true`. Выбор
  формата — за backend в KS-31; и тот и другой подходят, в seed-JSON
  проще принимать правки от пользователя (через git), в таблице —
  проще ротировать без деплоя.
- **API:** новый `GET /opening-trainer/demo` — open эндпоинт, возвращает
  массив демо-репертуаров. `GET /opening-trainer/demo/:id` —
  конкретный репертуар целиком. Без `OptionalJwtGuard` — это
  публичные данные, не зависят от user-id.
- **Frontend:** на `/opening-trainer` для гостя — лендинг с карточками
  демо-репертуаров и кнопкой «попробовать». Внутри сессии —
  стандартный SRS-flow, но `POST /opening-trainer/sessions` идёт
  no-op (см. §11.13). Прогресс по узлам — в localStorage гостя
  (опционально, чтобы между перезагрузками не сбрасывалось).
- **Auth-private маршруты остаются:** `/opening-trainer/new` (создать
  свой репертуар), `/opening-trainer/:id` (личный репертуар),
  `/opening-trainer/reviews` (личная SRS-очередь),
  `/opening-trainer/:id/stats` — `ProtectedRoute`. Гость на главной
  раздела видит две секции: «Демо-репертуары» (всегда) и «Мои
  репертуары» (для гостя — guest-CTA «войди, чтобы собрать свой»).

Категория в §4 — **PF**. Старая пометка «PF/PV — под вопросом»
снимается.

### 11.13. No-op POST vs 401 для гостя на write-эндпоинтах PF — **решено (KS-4126): no-op 204**

**Контракт:** на тренажёрских write-эндпоинтах PF при `user==null`
бэкенд возвращает **204 No Content** (no-op), не 401. На PR
write-эндпоинтах при `user==null` — **401 Unauthorized**.

Per-endpoint список:

| Эндпоинт | Категория | Поведение для гостя |
|---|---|---|
| `POST /puzzles/:id/attempt` | PF | 204 (no-op, attempt не пишется) |
| `POST /puzzles/:id/skip` | PF | 204 |
| `POST /precision/:id/attempt` | PF | 204 (см. KS-3349/ADR-079 — уже работает) |
| `POST /precision/next` | PF | 200 с next без рейтинг-дельты |
| `POST /puzzle-rush/scores` | PF | 204 |
| `POST /drills/sprint/result` | PF | 204 |
| `POST /blind-board/scores` | PF | 204 |
| `POST /guess/scores` | PF | 204 |
| `POST /opening-trainer/sessions` (на демо) | PF | 204 |
| `POST /workshop/analyses` (сохранить анализ) | **PR** | **401** (модалка ловит на фронте; если дошло до бэка — баг фронта) |
| `POST /messages` | PR | 401 |
| `POST /friends/request` | PR | 401 |
| `POST /arena/:id/register` | PR | 401 |
| `POST /broadcasts/:id/chat` | PR | 401 |
| `POST /feedback`, `POST /feedback/:id/vote`, `POST /feedback/:id/comment` | PR | 401 |
| `POST /coach/:u/book-lecture` | PR | 401 |

Обоснование выбора no-op vs 401:

- **PF — запись «по факту»** (attempt, score, session). Гость
  использует тренажёр через тот же фронт-код, что и юзер. Если бэк
  на каждую попытку отвечает 401 — `console.error` шумит, Sentry
  засоряется false-positive'ами, фронту приходится ставить try/catch
  и игнорировать ошибку. Чище — `if (req.user) save(); return res.status(204)`.
- **PR — discrete-action** (Send, Save, Register, Add). Гость на эту
  ручку без авторизации не должен попадать — модалка
  `<LoginRequiredModal>` через `useRequireAuth` ловит на фронте.
  401 здесь — защитная граница: если кто-то обошёл модалку (старый
  фронт-код, прямой запрос из curl/Postman), backend отказывает явно.

Реализация — KS-13 декомпозиции (`OptionalJwtGuard` + явный `if
(req.user)`-чек в сервисе для PF-эндпоинтов).

### 11.14. Workshop: layout для гостя — **решено (KS-4126): сайдбар с демо-партиями классиков**

Вариант (a) с guest-CTA в сайдбаре отвергнут. Принятое решение:
**сайдбар «Мои анализы» гостю показывает демо-список классических
партий** (примеры: Капабланка, Алехин, Карлсен и другие). Гость
кликает на партию → она открывается в полнофункциональном анализе
(Stockfish-WASM, варианты, NAG'и, оценки) — всё локально, без
сохранения. Кнопка «Сохранить анализ» — модалка
`<LoginRequiredModal>` (паттерн B, как уже работает в KS-29).

Требования к реализации (детали — в KS-29 + новый KS-32):

- **Источник контента — пользователь.** Конкретный набор демо-партий,
  имена/PGN/комментарии, **ротацию** («партия дня», «партия недели»,
  тематические подборки) подбирает и поддерживает **пользователь
  сам**. Никакой автогенерации, никакого привлечения агента
  chess-expert.
- **Формат хранения:** seed-данные демо-партий — JSON в backend
  (предложение архитектора: `apps/api/src/workshop/seeds/demo-games/*.pgn`
  + sidecar `meta.json` с заголовком, автором аннотаций, тегами; либо
  таблица `workshop_demo_games` с `isPublic=true`). Выбор — за
  backend в KS-32; правки PGN от пользователя удобнее принимать
  через git (seed-файлы), это аргумент в пользу JSON+PGN-файлов.
- **Ротация:** «партия дня» / «партия недели» — простой
  детерминированный pick по `dayOfYear % N` или `weekOfYear % M` (без
  cron'а, без runtime-state). Если пользователь захочет ручной
  override (показать конкретную партию в конкретный день) — добавить
  поле `pinnedFrom`/`pinnedUntil` в meta; делать сразу не обязательно,
  по факту запроса.
- **API:** новый `GET /workshop/demo-games` — open эндпоинт, возвращает
  массив `{id, title, white, black, event, date, pgn, comments}`.
  `GET /workshop/demo-games/featured` — сегодняшняя/недельная
  выделенная партия. Без `OptionalJwtGuard` — публичные данные.
- **Frontend:** сайдбар workshop при `user==null` рендерит секцию
  «Классические партии» с топ-выделенной партией и списком ниже,
  кнопка «открыть в анализе» — переход на `/analysis?demo=:id`
  (или прямо инстанс анализа в верхней половине без навигации).
  Сама верхняя половина (FEN ввод, PGN импорт, движок) для гостя
  доступна **полностью** — это паттерн A inline, без guest-CTA на
  самом инструменте.
- **Кнопка «Сохранить анализ»:** паттерн B через `useRequireAuth`
  (как уже описано в §5.14 + AnalysisPage.tsx:792-797).

Категория `/workshop` в §4 остаётся **PF**.

### 11.15. Где лежит HTML-снапшот: одна S3-папка vs per-domain (новый, KS-4121)

§7.3 предлагает `s3://kingside-prerender-store/<entity>/<id>.html`.
Альтернатива — мерж в основной frontend-bucket
`s3://kingside-frontend-342946498289/<entity>/<id>/index.html`,
тогда CloudFront не нужен дополнительный origin, просто маппинг
путей.

Плюс мержа: один bucket, единые правила versioning (ADR-127 §7.8),
проще backup / rollback. Минус: write-rate на frontend-bucket вырастет
с «раз в деплой» до «непрерывно», что требует пересмотра §7.4 и §7.7
ADR-127.

Архитектор предлагает: **отдельный bucket** на волне 1 (изоляция,
проще откат при поломке), потом обсудить мерж после стабилизации.

---

## 12. Что НЕ делает этот ADR

- Не пишет код (frontend / backend / devops). Реализация — KS-4118
  (rewrite), KS-4119 (rewrite), KS-новые по §10 (14 тикетов
  динамического prerender от KS-4121 + 9 тикетов открытия
  PF-тренажёров и `<GuestCTA>` от KS-4125).
- Не вводит шаблон `<MarketingLanding>` и тексты PM-лендингов —
  отменено KS-4125 (см. §4.3). Единственная маркетинговая страница
  `/features` — обычная компонента без шаблона.
- Не пишет тексты метатегов карточек (KS-16).
- Не дизайнит модалку логина / лендинги в Figma.
- Не выбирает финальные значения policy top-N для players и archive —
  это §11.8, требует сверки с пользователем + marketing.
- Не меняет policy admin-маршрутов, dev-bypass, OAuth-flow.
- Не вводит passwordless / magic-link / SSO с третьими сторонами.
- Не пересматривает `noindex` для `/analysis/public/:id`, `/live/:slug`,
  `/lectures/:id/replay`.
- Не пересматривает деплой-pipeline (ADR-127). Если §11.15 решится в
  пользу мержа в основной frontend-bucket — это будет отдельный
  follow-up к ADR-127.
- Не описывает SSR-приложение (vite-ssg / Next.js); ревизия §7 берёт
  более узкий путь — отдельный prerender-service с Playwright headless.

---

## 13. Последствия

**Плюсы**:
- Гости видят значительно больше контента (8 PR-маршрутов + 7+ PM-
  лендингов вместо текущих 2 индексируемых) — это окно для SEO,
  превью в мессенджерах и снижение барьера входа.
- Единый UX-паттерн (`<LoginRequiredModal>` + `useRequireAuth`)
  устраняет «редирект-в-середине-сценария» — гость с большей вероят-
  ностью завершает action после логина.
- Backend получает прозрачную модель public-vs-private endpoints
  (`OptionalJwtGuard` + throttler), а не точечные guard-исключения.
- SEO-эффект измерим (Yandex Webmaster, GSC) — после волны 1 можно
  валидировать гипотезу за 2–4 недели.

**Минусы / риски**:
- Расширение поверхности атаки на backend: открытые GET'ы требуют
  rate-limit и аудита DTO на утечки. Решение — `OptionalJwtGuard` +
  throttler + ревью DTO в KS-4118.
- Frontend усложняется: модалка + контекст + хук + 7 лендингов =
  ~20 новых компонентов. Митигируется единым шаблоном
  `<MarketingLanding>`.
- Контент-копирайтер становится критическим звеном для волны 2: без
  текстов лендинги пустые. Зафиксировано как зависимость KS-5.
- Динамические сегменты остаются не-prerendered — это известная
  дыра, открытая для волны 3+ (§11.4).

**Не делает этот ADR** (повтор §12):
- Не пишет код.
- Не пишет тексты.
- Не решает SSR.
