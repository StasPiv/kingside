# ADR-128 — Политика публичных маршрутов и модель «гость пользуется функционалом / логин для записи в БД»

- Статус: **Proposed** (2026-06-14: основа + ревизии по KS-4121,
  KS-4125, KS-4126; 2026-06-15: фиксация §11.2/§11.3 по KS-4127,
  системная фиксация §6.8/§6.9 + per-namespace чек-лист по KS-4129)
- Задача: KS-4120 (исходный), KS-4121 (§7), KS-4125 (отказ от
  PM-лендингов, кодификация inline guest-CTA), KS-4126 (закрытие
  §11.12–§11.14, KS-31/32 на seed-контент, запрет привлекать
  chess-expert — контент даёт пользователь), KS-4127 (закрытие
  §11.2 — `/lessons` открыт гостю как PF — и §11.3 — onboarding
  оставлен как текущий `UsernameSetupModal` + return), KS-4129
  (правило «GET по умолчанию открыт через `OptionalJwtGuard`» в §6.8,
  per-namespace чек-лист backend'у в §6.8.2, фронт-перехватчик 401
  в §6.9, тикеты KS-33/KS-34 в §10)
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
| `/lessons`, `/lessons/:courseSlug`, `/lessons/:courseSlug/:lessonSlug` (если `lessonsEnabled`) | **PF** | Каталог системных курсов, просмотр и прохождение уроков. Уроки идут локально, как `/puzzles`. См. §11.2 — решено в KS-4127 | Прогресс прохождения, отметка «изучено», запись «начал курс» | inline-CTA (`<GuestCTA variant="banner">`) на странице урока «войди для сохранения прогресса» |
| `/lessons/discover` | PR (уже работает) | Каталог открытых курсов | — | — |
| `/lessons/my`, `/lessons/my-active`, `/lessons/editor`, `/lessons/my/:slug`, `/lessons/my/:slug/:lessonId` | PV | Личные курсы пользователя, редактор, прогресс | — | `ProtectedRoute` |
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

### 6.8. Контракт backend — GET по умолчанию открыт для гостя

> **Системная фиксация (KS-4129, 2026-06-15).** Жалоба пользователя:
> часть PR/PF-маршрутов фронта снимают `ProtectedRoute`, но backend
> возвращает 401, глобальный перехватчик `apps/web/src/api.ts`
> отправляет гостя на `/login`. Эффективно — закрыто, хотя в роутере
> открыто. Эта секция формализует системное правило, чтобы прекратить
> точечные ad-hoc-открытия эндпоинтов.

**Правило (P-GET):** все GET-эндпоинты backend по умолчанию открыты
для анонимного запроса через `OptionalJwtGuard`. При `user==null`
эндпоинт возвращает публичные данные (или их подмножество — см. §6.8.3).

**Исключения** — явный whitelist эндпоинтов, обслуживающих PV-данные.
Этот whitelist кодифицирован в §6.8.2.

**Принципы:**

- P-GET.1 — `@UseGuards(JwtAuthGuard)` на классе контроллера для
  смешанных PF/PR/PV эндпоинтов **запрещён**. Если в одном контроллере
  есть и публичные, и личные ручки — guard ставится на каждый метод
  отдельно (`OptionalJwtGuard` для публичных, `JwtAuthGuard` для
  личных). Если контроллер обслуживает чисто PV — class-guard
  допустим, но контроллер тогда должен быть отдельным
  (`MessageController`, `FriendController`, и т. п.).
- P-GET.2 — write-эндпоинты (POST/PUT/PATCH/DELETE) контракт описан
  в §11.13 и не пересматривается: no-op 204 для гостя на PF write,
  401 на PR write.
- P-GET.3 — для каждого открываемого GET'а DTO должен явно скрывать
  для анонима поля §6.8.3.
- P-GET.4 — все open GET-эндпоинты обязательно под rate-limit
  (`RedisRateLimitGuard` или throttler), 60 req/min на IP по умолчанию.
  Throttler можно вешать на класс рядом с `OptionalJwtGuard`.

#### 6.8.1. Категории GET-эндпоинтов

| Категория | Guard | Когда |
|---|---|---|
| **GET-public** (PR/PF контент) | `OptionalJwtGuard` + rate-limit | Каталог задач, список трансляций, профиль игрока, лекция, демо-репертуар/демо-партия, лидерборд |
| **GET-personal** (PV) | `JwtAuthGuard` | Мои попытки, мой прогресс, мои сообщения, мои друзья, мои настройки |
| **GET-owner** | `JwtAuthGuard` + ownership-guard (`UserCourseOwnerGuard` и т. п.) | Edit-эндпоинты курсов, личные анализы пользователя |
| **GET-admin** | `JwtAuthGuard` + `AdminUserGuard` | Админка |

#### 6.8.2. Per-namespace чек-лист (источник правды для backend)

Сводная таблица на 2026-06-15. Колонки:
- **Текущее** — снимок состояния класс-guard / метод-guard;
- **Нужно** — целевое состояние по этому ADR;
- **Skip-fields** — поля DTO, которые backend обязан вырезать при
  `user==null`.

Снимки `grep "@UseGuards|@Get" *.controller.ts` от 2026-06-15.

**OK (открыто, изменений не требуется):**

| Namespace | Эндпоинты | Текущее = нужно |
|---|---|---|
| archive-service | `GET /tree`, `/games`, `/games/by-position`, `/games/:id`, `/players/search`, `/players/:slug`, `/players/:slug/games`, `/events/search` | open, ОК |
| broadcast-service | все read-эндпоинты | open, ОК |
| config | `GET /config` | open, ОК |
| feedback | `GET /feedback`, `/feedback/:id` | `OptionalJwtGuard`, ОК |
| live-analysis | `GET /live-analyses/:slug` | `OptionalJwtGuard`, ОК |
| analysis-public | `GET /analyses/public/:id` | open, ОК |
| precision | `GET /precision/theme-counts`, `/precision/next` | `OptionalJwtGuard`, ОК |
| puzzles | `GET /puzzles`, `/themes`, `/next`, `/next/:theme`, `/browse`, `/browse/count`, `/:id` | open/`OptionalJwtGuard`, ОК |
| daily-puzzle | `GET /puzzles/daily` | open, ОК |
| tactic-drill | `GET /tactic-drill*` | open, ОК |
| puzzle-rush | `GET /puzzle-rush/leaderboard` | open, ОК |
| blind-board | `GET /blind-board/leaderboard` | open, ОК |
| players | `GET /players/top`, `/online`, `/search`, `/:username`, `/:username/courses` | open + rate-limit, ОК |
| tournament | `GET /tournaments/top-active`, `/live` | open + rate-limit, ОК |
| arena | `GET /arena`, `/:id`, `/:id/standings`, `/:id/rounds`, `/:id/rounds/:n`, `/:id/schedule`, `/:id/crosstable`, `/invite/:code` | open, ОК |
| game | `GET /games/live`, `/games/live/count`, `/games/:id`, `/games/:id/moves` | open + rate-limit, ОК |
| lectures | `GET /lectures/:id`, `/lectures/:id/recording`, `/coaches/:u/lectures`, `/coaches/:u/schedule` | `OptionalJwtGuard`/open, ОК |
| lessons (publication) | `GET /lessons/courses/authors` | open, ОК |

**Закрыто, но должно быть открыто (требует правки backend):**

| Namespace | Эндпоинты | Текущее | Нужно | Skip-fields для гостя |
|---|---|---|---|---|
| **guess** | `GET /guess/sessions/:id` | class-`JwtAuthGuard` → 401 | убрать class-guard, на этот метод — `OptionalJwtGuard`; если гость без сессии — 404 не 401 | — |
| **opening-trainer (demo)** | новый `GET /opening-trainer/demo`, `GET /opening-trainer/demo/:id` (KS-31) | не существует | новые open-эндпоинты в отдельном `OpeningTrainerPublicController` (без class-guard); основной `OpeningTrainerController` оставляет `@UseGuards(JwtAuthGuard)` для personal-репертуаров | — |
| **workshop (demo)** | новый `GET /workshop/demo-games`, `GET /workshop/demo-games/featured` (KS-32) | не существует | новые open-эндпоинты в отдельном `WorkshopPublicController`; основной `WorkshopController` оставляет `JwtAuthGuard` для personal-анализов | — |
| **lessons (system courses)** | `GET /lessons/courses?published=true`, `GET /lessons/courses/:slug`, `GET /lessons/lessons/:id` | class-`JwtAuthGuard` → 401 | расщепить на: `LessonsCoursesPublicController` (open: list opublikovanных + `:slug` + `lessons/:id`) и `LessonsCoursesPrivateController` (class-`JwtAuthGuard`: `enrolled`, write, ownership); либо method-level guards | `email`, `ownerEmail`, `privateNotes`, `draftSteps` (только опубликованные); прогресс — не отдавать гостю |
| **lessons (progress)** | `GET /lessons/progress/courses/:id`, `/lessons/progress/lessons/:id` | class-`JwtAuthGuard` | оставить **`JwtAuthGuard`** (личный прогресс — PV). Для гостя: фронт **не вызывает** эти ручки при `user==null` (проверка на стороне SPA), либо они отвечают 200 с пустым прогрессом без 401 (на усмотрение backend в KS-…) | — |
| **lessons (legacy /lessons/lessons)** | `GET /lessons/lessons/:id` | class-`JwtAuthGuard` | через unified-public-controller сделать open (см. строку выше) | — |
| **analysis** (`/analyses`) | `GET /analyses/me`, `/analyses/:id` | class-`JwtAuthGuard` | оставить как есть — это **личные анализы**. Гостю доступен только `/analyses/public/:id`; AnalysisPage сам переключается в publicMode при отсутствии user (KS-2666/KS-2672) | — |
| **analysis-review** | `GET /analyses/review/...` | проверить | если эти GET-ы относятся к публичному анализу — `OptionalJwtGuard`; если только к owner-у — `JwtAuthGuard` | проверить с backend |
| **analyses/positional-trace** | `GET /analyses/:analysisId/positional-trace/...` | проверить | то же, что review — зависит от публичности parent-анализа | — |
| **position-comment** | `GET /analyses/position/...` | проверить | если относится к публичному анализу — `OptionalJwtGuard` | — |
| **knowledge** | `GET /knowledge/...` | class-`JwtAuthGuard` | если контент — публичный справочник, открыть через `OptionalJwtGuard`; если personal — оставить JWT. **Уточнить с backend, тип контента не очевиден из имени.** | проверить |
| **lecture-audio** | `POST /lecture-audio/peer-failed` | `OptionalJwtGuard` (уже) | ОК для write-side по §11.13 | — |

**Остаётся закрытым (PV, не менять):**

| Namespace | Эндпоинты | Обоснование |
|---|---|---|
| messages | `GET /messages*` | личная переписка |
| friend | `GET /friends*` | список друзей пользователя |
| notification | `GET /notifications*` | личные уведомления |
| profile | `GET /profile*` | личный профиль (settings, личные данные) |
| user/saved-filters | `GET /user/saved-filters*` | личные сохранённые фильтры |
| user/nav-stats | `GET /user/nav-stats` | личная аналитика навигации |
| user/preferences | `GET /user/preferences` | личные настройки |
| user/time-controls | `GET /users/me/time-controls` | личные настройки |
| puzzle/mistakes | `GET /puzzle/mistakes*` | личный дневник ошибок (PV по ADR-032) |
| puzzles/stats/me, /attempts | `GET /puzzles/stats/me`, `/puzzles/stats/rating-history`, `/puzzles/stats/themes`, `/puzzles/attempts` | личная статистика |
| precision/me/* | `GET /precision/stats/me`, `/trends/me`, `/breakdowns/me`, `/me/rating`, `/attempts/me`, `/attempts/:attemptId`, `/scope-counts` | личная статистика precision |
| guess/me/* | `GET /guess/history`, `/stats/me`, `/trends/me`, `/breakdowns/me` | личная статистика guess |
| blind-board/me/* | `GET /blind-board/stats/me`, `/trends/me`, `/breakdowns/me`, `/history`, `/sessions/:id` | личная статистика blind-board |
| opening-trainer/me | `GET /opening-trainer/repertoires*`, `/sessions/:sid`, `/reviews/due`, и т. п. | личные репертуары и SRS-очередь |
| lectures/my | `GET /my/lectures`, `/lectures/:id/access` | мои купленные лекции, мой доступ |
| game/active, /games/my, /games/:id/analysis | те, что под `JwtAuthGuard` в `game.controller` | личные активные партии и личный анализ |
| board-recognition | весь | служебная фича распознавания доски (proxy на ML), требует JWT |
| live-analysis personal | `GET /live-analyses/me`, `/by-analysis/:analysisId` | свои онлайн-сессии |
| lessons/active-courses | `GET /lessons/active*` | мои активные курсы |
| lessons/admin/* | весь | админка |
| admin | весь | админка |
| chat | весь | AI-чат личный |
| mcp/discovery | `_mcp/*` | служебный internal |
| internal/* | `auth/internal-*`, `users/internal-*`, `broadcast-internal`, `internal-games` | service-to-service, не для браузера |
| metrics | `/metrics` | Prometheus scrape |
| health | `/health` | LB |

#### 6.8.3. Поля DTO для скрытия при `user==null`

Любой open GET-эндпоинт, отдавая объект user/coach/player/comment/lecture,
обязан **резать в DTO** для гостя:

- `email`, `emailVerified`, `phone`, `phoneVerified` — личные контакты;
- `oauthIds`, `googleId`, `facebookId`, `telegramId` — связи аккаунтов;
- `privateNotes`, `internalNotes` — модераторские пометки;
- `subscription`, `paymentMethod`, `lastInvoice` — платёжная информация;
- `lastSeenAt`, `lastIp`, `userAgent` — telemetry;
- `privacyFlags` — настройки приватности;
- `friends[]`, `blockedUsers[]` — социальный граф (если private);
- `email`-поля внутри nested-объектов (комментарий → автор → email).

Реализация — отдельный DTO-маппер `toPublicDto(entity, viewer?)` на
backend, единый для всех таких сущностей. Это часть KS-33 (см. §10).

#### 6.8.4. Rate-limit на open GET-эндпоинтах

Все open GET (PR/PF) обязаны быть под:

- `@nestjs/throttler` (60 req/min по IP по умолчанию), или
- `RedisRateLimitGuard` (как уже у `player`, `tournament`).

Цель — защита от случайного бот-краулинга, не от DDoS. Полноценный
WAF — вне scope (§11.6).

### 6.9. Контракт фронт-перехватчика 401

`apps/web/src/api.ts` сейчас глобально ловит 401 и редиректит на
`/login`. Контракт по этому ADR:

| Тип запроса | Источник запроса | Ответ 401 | Действие перехватчика |
|---|---|---|---|
| **GET PF/PR** | гость | **не должно случиться** | если случилось — это баг backend'а или роутинга. Залогировать в Sentry, **НЕ редиректить**. На UI показать toast «не удалось загрузить, попробуйте позже». |
| **GET PV** | гость | не должно случиться, т. к. PV-маршруты под `ProtectedRoute` редиректят на /login до запроса | если случилось — то же что выше (баг роутинга). |
| **GET** | авторизованный (JWT истёк) | штатно | refresh-token flow → retry; при провале — redirect на `/login` с `setAuthReturnUrl` |
| **POST/PUT/PATCH/DELETE PF** | гость | не должно случиться (контракт §11.13 → 204) | баг backend'а. Лог + toast. |
| **POST/PUT/PATCH/DELETE PR** | гость | штатно (модалка не сработала) | **не редирект**; открыть `<LoginRequiredModal>` через тот же `useRequireAuth`-механизм; на закрытие модалки — отменить originating request |
| **POST/PUT/PATCH/DELETE PV** | гость | штатно (тот же кейс что PR) | как PR |

То есть **глобальный 401-перехватчик больше не редиректит гостя на
`/login` автоматически**. Редирект остаётся только в одном кейсе —
expired-JWT у авторизованного с проваленным refresh. Это устраняет
основную причину UX-регресса, описанную в KS-4129.

Реализация перехватчика — KS-34 (см. §10).

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

> **Ревизия 2026-06-15 (KS-4191).** Уточнение механизма fallback'а
> `404 → /index.html`. CloudFront `CustomErrorResponses` —
> **distribution-wide**, не per-behavior. Использовать его «как есть»
> нельзя:
>
> - Distribution-wide `404 → /index.html (200)` ломает `/api/*`:
>   реальные 404 от NestJS (отсутствующий endpoint, отсутствующая
>   сущность) будут заменены на HTML 200 — `response.ok===true`,
>   парсинг JSON падает.
> - Distribution-wide `403 → /index.html (200)` (вариант на S3 OAC
>   без `ListBucket`, где отсутствие объекта = 403) ловит легитимные
>   `ForbiddenException` NestJS (owner-check
>   `puzzle.controller.ts:721`, `admin-user.guard`, ownership в
>   `positional-trace.service.ts`) и WAF/CloudFront security blocking
>   — security-инвариант ломается, атакующий получает HTML 200 вместо
>   блока.
> - S3 website endpoint + `ErrorDocument: index.html` отдаёт 404, не
>   200 — нарушает P5 (бот и пользователь должны получать одинаковый
>   код).
>
> **Решение — Lambda@Edge на `origin-response`**, ассоциированная
> **только** с prerender-behaviors (`/broadcasts/*`, `/tournaments/*`,
> `/arena/*`, `/lectures/*`, `/coach/*`, `/player/*`, `/archive/games/*`,
> `/archive/players/*`). `/api/*`, `/socket.io/*`, default,
> `/study/embed/*` — без триггера, поведение не меняется.
>
> Контракт Lambda:
> 1. Триггер `origin-response`. На status `200` — pass-through.
> 2. На status `404` — выполняет `GetObject` за
>    `s3://kingside-frontend/index.html`, возвращает body со
>    `status=200`, `Content-Type: text/html; charset=utf-8`,
>    `Cache-Control: public, max-age=60` (бот может перезайти через
>    минуту, когда prerender догонит).
> 3. На любой другой статус (5xx) — pass-through (S3 ошибки
>    инфраструктуры не маскируем фолбэком).
>
> Альтернатива по реализации (на усмотрение devops):
> - **A. Inline body в Lambda artifact** — `index.html` собирается в
>   bundle Lambda. Деплой фронта → пересборка Lambda. Чище runtime,
>   связывает frontend-deploy с Lambda-deploy.
> - **B. S3 SDK fetch на каждый 404** — Lambda тянет `index.html` из
>   S3-frontend bucket'а. ~10мс overhead, но Lambda и frontend
>   независимы.
>
> Рекомендация — **B** (гибче в разворачивании), но **A** допустима
> если frontend и prerender-инфра деплоятся одним пайплайном.
>
> Стоимость: prerender-behaviors ~200–500 task/день; реальных
> 404-фолбэков на порядки меньше (после прогрева — единичные новые
> карточки между cron-окнами). Lambda@Edge stop-cost $0.60/1M
> invocations + compute ⇒ $0.01–$0.05/мес. Cold-start редкий, на
> origin-response не критичен (внутри AWS-сети).
>
> CloudFront Function на viewer-request (§7.3.4 выше, маппинг
> URI → `/<path>/<id>/index.html`) **остаётся** — она дешевле и
> работает на каждом запросе. Lambda@Edge добавляется поверх
> только на origin-response prerender-behaviors.

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

Стандартный набор полей в `<head>` (через нативные metadata-теги
React 19 — см. §7.6.1.1.A, заполняется в компоненте страницы):

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

### 7.6.1. SEO-карта PR/PF-карточек (per-entity шаблоны)

> **Ревизия 2026-06-15 (KS-4172).** Готовая карта «маршрут → источник
> данных → шаблон метатегов и JSON-LD» для каждой PR/PF-карточки.
> Цель — снять с frontend необходимость дорисовывать SEO-шаблоны на
> месте. После приёмки координатор раздаёт по одной маленькой задаче
> на frontend за каждую сущность; разработчик подставляет готовый
> шаблон, не размышляя о форме.
>
> Финальные тексты i18n-ключей — за маркетингом (отдельные задачи).
> Здесь — структура: какие ключи, какие переменные подставляются,
> какие fallback'и, какой JSON-LD по Schema.org.

#### 7.6.1.1. Conventions

> **Ревизия 2026-06-15 (KS-4176).** `react-helmet-async@2.0.5`
> объявляет peerDependencies до React 18 — `npm install` в проекте
> с React 19.2.4 падает на EERESOLVE, поддержки React 19 у пакета
> нет. В React 19 теги `<title>`, `<meta>`, `<link>` и
> `<script type="application/ld+json">` в JSX компонента
> автоматически переносятся в `<head>` документа (механизм
> "Document Metadata", react.dev/reference/react-dom/components/title).
> Внешняя библиотека не нужна. Все упоминания
> `react-helmet-async` / `<HelmetProvider>` ниже в этом ADR
> заменены на нативный механизм — см. §7.6.1.1.A для контракта
> компонента-обёртки `<SeoHelmet>`.

- **Длины**: `<title>` ≤ 60 символов, `<meta description>` ≤ 160. При
  превышении — обрезка с `…` (frontend в `<SeoHelmet>` обрезает по
  слову, не по символу).
- **i18n-namespace**: `seo.*` (новый). Изолирован от `landing.*`
  (ADR-129) и `features.*` (страница `/features`). Ключи перечислены
  per-entity ниже.
- **Переменные** в шаблонах — `{name}`, `{rating}` и т. д. — i18next
  interpolation.
- **Языки**: en + ru. Финальные строки — KS-MK (marketing); архитектор
  даёт **шаблон с переменными** (см. таблицу), не конкретный текст.
- **og:image**: статический файл из `apps/web/public/og/`, один на
  entity-тип (список §7.6.1.3). Динамическая генерация (volna 2) —
  отдельный ADR.
- **og:type**: `website` для list-страниц, `article` / `event` /
  `profile` — для detail-страниц (по сущности).
- **canonical**: всегда абсолютный URL без query (если query не
  семантический — для `/archive`-фильтров canonical всё равно
  голый `/archive`).
- **JSON-LD**: вставляется через `<script type="application/ld+json">`
  в `<SeoHelmet>`. Если обязательное поле пустое и Schema.org требует
  значения — JSON-LD не выводится (лучше не выводить, чем
  выводить «битый»).
- **Fallback-правило по умолчанию**: nullable-поле пустое → подставляем
  literal `—` в текст шаблона ИЛИ выкидываем секцию шаблона целиком
  (что естественнее по смыслу). Конкретные fallback'и — в колонке
  «Fallback'и» per-route.
- **i18n-ключ**: только верхнеуровневое имя ключа группы в таблицах
  (например `seo.broadcasts.list`). Внутри группы — `.title`,
  `.description`, при необходимости `.titleNoDate` и так далее под
  fallback-варианты.

##### 7.6.1.1.A. Контракт компонента `<SeoHelmet>` (React 19, без библиотек)

`<SeoHelmet>` — тонкая обёртка-typed-компонент в
`apps/web/src/components/seo/SeoHelmet.tsx`. Не зависит от
`react-helmet-async` и от любой внешней библиотеки. Внутри —
просто JSX-теги `<title>`, `<meta>`, `<link>`,
`<script type="application/ld+json">`; React 19 сам переносит их в
`<head>` (механизм Document Metadata).

Контракт пропсов:

```tsx
interface SeoHelmetProps {
  title: string;                        // ≤ 60, обрезается утилитой ниже
  description: string;                  // ≤ 160, обрезается
  canonical: string;                    // абсолютный URL без query
  ogType?: 'website' | 'article' | 'event' | 'profile';  // default 'website'
  ogImage?: string;                     // default '/og/default.png'
  ogImageAlt?: string;
  twitterCard?: 'summary' | 'summary_large_image';        // default 'summary_large_image'
  noindex?: boolean;                    // ставит <meta name="robots" content="noindex">
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];  // один объект или массив (несколько LD-блоков)
  lang?: 'en' | 'ru';                   // для og:locale; default — из i18next
}
```

Скелет реализации (frontend кладёт это как-есть в
`SeoHelmet.tsx`, без правок ADR):

```tsx
export function SeoHelmet(props: SeoHelmetProps) {
  const title = truncateByWord(props.title, 60);
  const description = truncateByWord(props.description, 160);
  const ogType = props.ogType ?? 'website';
  const ogImage = props.ogImage ?? '/og/default.png';
  const twitterCard = props.twitterCard ?? 'summary_large_image';
  const locale = props.lang === 'ru' ? 'ru_RU' : 'en_US';
  const altLocale = props.lang === 'ru' ? 'en_US' : 'ru_RU';
  const jsonLdArr = !props.jsonLd
    ? []
    : Array.isArray(props.jsonLd) ? props.jsonLd : [props.jsonLd];

  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={props.canonical} />
      {props.noindex && <meta name="robots" content="noindex" />}

      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={props.canonical} />
      <meta property="og:image" content={ogImage} />
      {props.ogImageAlt && <meta property="og:image:alt" content={props.ogImageAlt} />}
      <meta property="og:locale" content={locale} />
      <meta property="og:locale:alternate" content={altLocale} />

      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />

      {jsonLdArr.map((ld, i) => (
        <script
          key={i}
          type="application/ld+json"
          // React 19 безопасно сериализует объект — но для гарантии
          // экранирования закрывающего тега используем dangerouslySetInnerHTML
          // с JSON.stringify (стандарт для JSON-LD в SPA).
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
        />
      ))}
    </>
  );
}
```

Использование на странице:

```tsx
function BroadcastTournamentPage() {
  const { data } = useBroadcast(tournamentId);
  if (!data) return <Spinner />;
  return (
    <>
      <SeoHelmet
        title={t('seo.broadcasts.tournament.title', { title: data.title })}
        description={t('seo.broadcasts.tournament.description', {
          title: data.title, roundCount: data.roundCount,
        })}
        canonical={`https://kingside.site/broadcasts/${data.id}`}
        ogType="event"
        ogImage={data.imageUrl ?? '/og/broadcast.png'}
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'SportsEvent',
          name: data.title,
          sport: 'Chess',
          startDate: data.startDate ?? undefined,
        }}
      />
      <BroadcastBody data={data} />
    </>
  );
}
```

Технические ограничения React 19 (для frontend, чтобы не наступить):
- Document Metadata работает на client (SPA) и при SSR/streaming.
  В текущем prerender-пайплайне (`apps/web/scripts/prerender.mjs`,
  Playwright headless) теги попадают в `<head>` через DOM-рендер —
  работает «как обычно».
- `<title>` в React 19 — singleton: последний отрендеренный
  выигрывает. Если два компонента отрендерили `<title>` одновременно
  (например, layout + page) — берётся последний. На наших страницах
  `<SeoHelmet>` вызывается **один раз на маршрут** — конфликтов
  нет. Layout `<MainLayout>` свой `<title>` не ставит.
- `<meta>` с тем же `name`/`property` — React 19 дедуплицирует.
  Тоже не задача frontend'а — но знание полезно при отладке.
- На динамической смене маршрута (SPA-навигация без перезагрузки)
  React 19 правильно убирает старые теги при unmount компонента-
  источника. То есть `<SeoHelmet>` смонтированный в `Broadcasts
  TournamentPage` при переходе на `BroadcastRoundPage` корректно
  заменяется на теги новой страницы.

`<HelmetProvider>` / `react-helmet-async` / любой провайдер для
SEO-тегов в `apps/web/src/main.tsx` **не нужен и не добавляется**.

Утилита `truncateByWord` — отдельный модуль
`apps/web/src/components/seo/truncate.ts`, режет строку по последнему
пробелу не превышая лимит, добавляет `…`. Реализация — KS-4171, не ADR.

#### 7.6.1.2. Per-route таблица

Источники данных по `frontend → backend`. Префиксы сервисов:
- `api` — основной NestJS (`apps/api`), `kingside.site/api`;
- `broadcasts` — `apps/broadcast-service`, subdomain `broadcasts.kingside.site`
  (фронт-клиент: `apps/web/src/api/broadcastApi.ts`);
- `archive` — `apps/archive-service`, subdomain `archive.kingside.site`.

---

##### B1. `/broadcasts` (список)

| Поле | Значение |
|---|---|
| Компонент | `BroadcastsPage` |
| Файл | `apps/web/src/pages/BroadcastsPage.tsx` |
| API-запрос | `GET /` (broadcast-service: `broadcastApi.get('/')`); backend `broadcast.controller.ts:257` |
| DTO | `BroadcastSummary[]` (`packages/shared/src/types/api-contracts.ts:1144`) |
| Поля для SEO | `title`, `lifecycleStatus`, `roundCount`, `topPlayers[].name`, `topPlayers[].elo` (для агрегированных метрик списка) |
| Prisma | broadcast-service: `BroadcastTournament` (поля `id`, `lichessId`, `title`, `status`, `pinned`, `avgElo`) |
| `<title>` (≤60) | `seo.broadcasts.list.title` — «Live chess broadcasts — Kingside» / «Шахматные трансляции — Kingside» |
| `<meta description>` (≤160) | `seo.broadcasts.list.description` — «Watch top tournaments live with engine analysis and AI move commentary on Kingside.» |
| `og:type` | `website` |
| `og:image` | `/og/broadcast.png` |
| `canonical` | `https://kingside.site/broadcasts` |
| JSON-LD | `CollectionPage` + `ItemList` из `BroadcastSummary[]` (первые 10, остальные — пагинация). Каждый item — `SportsEvent` с минимумом полей: `name=title`, `sport='Chess'`, `eventStatus` маппится из `lifecycleStatus`. |
| Fallback'и | Список пустой → выводим page без JSON-LD `ItemList`, оставляем `CollectionPage` пустой. `topPlayers=[]` — игнорируем в агрегатах. |

---

##### B2. `/broadcasts/:tournamentId`

| Поле | Значение |
|---|---|
| Компонент | `BroadcastTournamentPage` |
| Файл | `apps/web/src/pages/BroadcastTournamentPage.tsx` |
| API-запросы | `GET /:id` (BroadcastMeta) + `GET /:id/rounds` (`BroadcastRoundItem[]`) |
| DTO | `BroadcastMeta` (локальный тип `:8-26`: `id`, `title`, `imageUrl?`, `description?`, `lifecycleStatus`, …), `BroadcastRoundItem` (`api-contracts.ts:1185`) |
| Поля для SEO | `title`, `description`, `lifecycleStatus`, `rounds[].name`, `rounds[].startsAt`, `rounds[].status` |
| Prisma | `BroadcastTournament` + `BroadcastRound` |
| `<title>` (≤60) | `seo.broadcasts.tournament.title` — «{title} — Kingside» |
| `<meta description>` (≤160) | `seo.broadcasts.tournament.description` — «{title}: {roundCount} rounds, live coverage with engine analysis on Kingside.» При наличии `description` от Lichess — `meta.description` подрезанное до 160. |
| `og:type` | `event` |
| `og:image` | `meta.imageUrl` (от Lichess) → fallback `/og/broadcast.png` |
| `canonical` | `https://kingside.site/broadcasts/{tournamentId}` |
| JSON-LD | `SportsEvent`: `name=title`, `sport='Chess'`, `description=meta.description`, `eventStatus` маппится из `lifecycleStatus` (`live` → `EventScheduled`+`isAccessibleForFree`, `upcoming` → `EventScheduled`, `finished` → `EventScheduled` с прошедшим `endDate`), `startDate=startDate`, `subEvent=[…BroadcastRoundItem]` (каждый round как вложенный `SportsEvent`). |
| Fallback'и | `description=null/''` — описание не выводим, остаётся только title в текстовом блоке. `imageUrl=null` — `/og/broadcast.png`. `startDate=null` — `startDate` не выводим, JSON-LD без него. `rounds=[]` — `subEvent` пропускаем. |

---

##### B3. `/broadcasts/:tournamentId/:roundId`

| Поле | Значение |
|---|---|
| Компонент | `BroadcastRoundPage` |
| Файл | `apps/web/src/pages/BroadcastRoundPage.tsx` |
| API-запросы | `GET /:tid` (`BroadcastMeta`) + `GET /:tid/rounds` (`BroadcastRoundItem[]`) + `GET /:tid/rounds/:rid/games` (`{ data: BroadcastGameSummary[] }`) |
| DTO | `BroadcastMeta`, `BroadcastRoundItem`, `BroadcastGameSummary` (`api-contracts.ts:1209`) |
| Поля для SEO | tournament: `title`; round: `name`, `startsAt`, `status`; games: count, first 3 pairings `whitePlayer`–`blackPlayer` |
| Prisma | `BroadcastTournament` + `BroadcastRound` + `BroadcastGame` |
| `<title>` (≤60) | `seo.broadcasts.round.title` — «{tournament} — {round} — Kingside» |
| `<meta description>` (≤160) | `seo.broadcasts.round.description` — «{tournament} {round}: {gamesCount} games live. Engine analysis and move commentary on Kingside.» |
| `og:type` | `event` |
| `og:image` | `meta.imageUrl` (от Lichess родителя) → fallback `/og/broadcast.png` |
| `canonical` | `https://kingside.site/broadcasts/{tid}/{rid}` |
| JSON-LD | `SportsEvent`: `name='{tournament} — {round}'`, `sport='Chess'`, `superEvent={SportsEvent родителя}`, `startDate=round.startsAt`, `eventStatus` маппится из `round.status` (`ongoing` → live, `finished` → завершён, остальное → scheduled). |
| Fallback'и | `round.startsAt=null` → `startDate` пропускаем; `gamesCount=0` → описание сокращаем до «{tournament} {round} round.»; `tournament.imageUrl=null` → `/og/broadcast.png`. |

---

##### B4. `/broadcasts/:tournamentId/:roundId/:gameId` (включая `/live`)

| Поле | Значение |
|---|---|
| Компонент | `BroadcastGamePage` (lazy) или `BroadcastLiveGamePage` |
| Файл | `apps/web/src/pages/BroadcastGamePage.tsx`, `BroadcastLiveGamePage.tsx` |
| API-запросы | `GET /:tid` (`BroadcastMeta`) + `GET /:tid/rounds` (`{ data }`) + `GET /:tid/rounds/:rid/games` (`{ data: LichessGame[] }`); локально выбирается `game = games.find(id===gameId)`. См. `BroadcastGamePage.tsx:71-81`. |
| DTO | `LichessGame` (≈ `BroadcastGameSummary`): `whitePlayer`, `blackPlayer`, `whiteElo`, `blackElo`, `result`, `pgn`, `currentFen`, `updatedAt`, `bracketStage?` |
| Поля для SEO | `whitePlayer`, `blackPlayer`, `whiteElo?`, `blackElo?`, `result?`, `tournament.title`, `round.name` (из `rounds.find`), opening (из PGN-headers, fallback `eco`) |
| Prisma | `BroadcastGame` (поля `pgn`, `whitePlayer`, `blackPlayer`, `result`, `updatedAt`) |
| `<title>` (≤60) | `seo.broadcasts.game.title` — «{white} vs {black} ({result}) — Kingside» (без турнира — для длины). Fallback без `result`: «{white} vs {black} — {tournament}» |
| `<meta description>` (≤160) | `seo.broadcasts.game.description` — «{white} ({whiteElo}) vs {black} ({blackElo}) — {tournament} {round}. {opening}. Engine analysis on Kingside.» |
| `og:type` | `article` (партия как контент-единица; SportsEvent для одной партии семантически слабо ложится — chess `Game` в Schema.org нет) |
| `og:image` | `/og/broadcast.png` (volna 2 — динамическая генерация превью доски по `currentFen`) |
| `canonical` | `https://kingside.site/broadcasts/{tid}/{rid}/{gid}` (без `/live` — `/live` это рантайм-режим того же контента, не отдельный canonical) |
| JSON-LD | `Article`: `headline='{white} vs {black}'`, `author=[{Person name=white},{Person name=black}]`, `datePublished=updatedAt`, `articleBody=pgn` (для индексации полного текста ходов), `isPartOf={SportsEvent родителя — round}`. |
| Fallback'и | `whitePlayer/blackPlayer=null` → `'?'`. `whiteElo/blackElo=null` → скобки в description пропускаем. `result=null` → title без result. `pgn=null` (forfeit) → `Article.articleBody` пропускаем, в DOM выводим страницу forfeit (текущий поток `BroadcastGamePage.tsx:97-180`). Opening невытекаем — описание без opening. |

---

##### T1. `/tournaments` (список)

| Поле | Значение |
|---|---|
| Компонент | `TournamentsPage` |
| Файл | `apps/web/src/pages/TournamentsPage.tsx` |
| API-запросы | `GET /arena?type=&status=` (`Tournament[]`); для авторизованных дополнительно `GET /arena/my` (приватный, не для SEO) |
| DTO | Локальный `Tournament` (`:8-...`): `id`, `name`, `type` (`arena`/`swiss`/`round-robin`), `status`, `timeControl`, `startsAt`, `participantsCount` |
| Поля для SEO | `name`, `status`, `type`, `participantsCount`, `startsAt` (агрегаты для description: «N tournaments live now») |
| Prisma | api: `Tournament` (или `Arena` — точное имя taken from `apps/api/src/arena` Prisma модели; backend: `arena.controller.ts:41`) |
| `<title>` (≤60) | `seo.tournaments.list.title` — «Chess tournaments — Kingside» / «Турниры — Kingside» |
| `<meta description>` (≤160) | `seo.tournaments.list.description` — «Arena, Swiss and round-robin tournaments. Bullet, Blitz, Rapid and Classical formats on Kingside.» |
| `og:type` | `website` |
| `og:image` | `/og/tournament.png` |
| `canonical` | `https://kingside.site/tournaments` |
| JSON-LD | `CollectionPage` + `ItemList` с первыми 10 как `SportsEvent`. |
| Fallback'и | Пустой список → JSON-LD без `ItemList`. |

---

##### T2. `/tournaments/:id` и `/arena/:id`

| Поле | Значение |
|---|---|
| Компонент | `TournamentLobbyPage` |
| Файл | `apps/web/src/pages/TournamentLobbyPage.tsx` |
| API-запросы | `GET /arena/:id` (`Tournament`) + `GET /arena/:id/standings` (`Standing[]`) + `GET /arena/:id/rounds` (`RoundData[]`) |
| DTO | `Tournament` (`:15-35`: `id`, `name`, `description`, `type`, `timeControl`, `status`, `startsAt`, `endsAt`, `prizeFund?`), `Standing` (`:70-...`: `userId`, `username`, `score`, `rating`) |
| Поля для SEO | `name`, `description`, `type`, `timeControl`, `status`, `startsAt`, `endsAt`, `participantsCount` (из `standings.length`), top-3 `standings` (имена + score для description) |
| Prisma | `Tournament`, `TournamentParticipant`, `TournamentRound` |
| `<title>` (≤60) | `seo.tournaments.detail.title` — «{name} — Kingside» |
| `<meta description>` (≤160) | `seo.tournaments.detail.description` — «{name}: {type} tournament, {timeControl} time control. {participantsCount} players. {startsAt}. Join on Kingside.» |
| `og:type` | `event` |
| `og:image` | `/og/tournament.png` |
| `canonical` | `https://kingside.site/tournaments/{id}` (даже если зашёл по `/arena/:id` — это alias, canonical сводит к `/tournaments/:id`) |
| JSON-LD | `SportsEvent`: `name`, `sport='Chess'`, `startDate=startsAt`, `endDate=endsAt`, `description`, `eventStatus` маппится из `status`, `location={VirtualLocation, url=canonical}`, `organizer={Organization, name='Kingside'}`. Если есть `prizeFund` — `offers={Offer prizeReward}`. |
| Fallback'и | `description=null` → подставляем generic строку из `seo.tournaments.detail.descriptionNoDesc`. `endsAt=null` → пропускаем. `prizeFund=null` → `offers` пропускаем. `standings=[]` → блок «players» в description опускаем. |

---

##### P1. `/players` (список)

| Поле | Значение |
|---|---|
| Компонент | `PlayersPage` |
| Файл | `apps/web/src/pages/PlayersPage.tsx` |
| API-запросы | `GET /players/top?type=&limit=&offset=` (`TopPlayersResponse`); `GET /players/online?limit=&offset=` (`OnlinePlayersResponse`); `GET /players/search?q=...` (`SearchPlayersResponse`) |
| DTO | `TopPlayersResponse.data[]`: `{ username, ratingBullet, ratingBlitz, ratingRapid, ratingClassical, country? }`, `OnlinePlayersResponse.data[]`: то же + `lastSeenAt` |
| Поля для SEO | Только агрегат (количество в списке) — для SEO детали игроков не нужны, они на T1-роуте. |
| Prisma | `User` (поля `username`, `ratingBullet`, `ratingBlitz`, `ratingRapid`, `ratingClassical`, `country`, `lastSeenAt`) |
| `<title>` (≤60) | `seo.players.list.title` — «Top chess players — Kingside» / «Топ игроки — Kingside» |
| `<meta description>` (≤160) | `seo.players.list.description` — «Top-rated chess players by bullet, blitz, rapid and classical. Search and view profiles on Kingside.» |
| `og:type` | `website` |
| `og:image` | `/og/player.png` |
| `canonical` | `https://kingside.site/players` (без `?type=&tab=` — canonical голый) |
| JSON-LD | `CollectionPage` + `ItemList` с топ-10 как `Person`. |
| Fallback'и | Список пустой → без `ItemList`. |

---

##### P2. `/player/:username`

| Поле | Значение |
|---|---|
| Компонент | `PlayerProfilePage` |
| Файл | `apps/web/src/pages/PlayerProfilePage.tsx` |
| API-запросы | `GET /players/:username` (`PlayerProfileResponse`) |
| DTO | `PlayerProfileResponse` (`api-contracts.ts:2272`): `id`, `username`, `country?`, `ratings.{bullet,blitz,rapid,classical,puzzle}`, `stats.{wins,losses,draws,totalGames}`, `createdAt`, `lastSeenAt`, `recentGames[]`, `isCoach` |
| Поля для SEO | `username`, `country`, `ratings.*`, `stats.totalGames`, `stats.wins`, `isCoach`, `createdAt` |
| Prisma | `User` |
| Best rating логика | `bestRating = max(ratings.bullet, ratings.blitz, ratings.rapid, ratings.classical)`; `bestType` — соответствующее имя категории |
| `<title>` (≤60) | `seo.players.profile.title` — «{username} — {bestRating} {bestType} — Kingside» |
| `<meta description>` (≤160) | `seo.players.profile.description` — «{username}: Bullet {bullet}, Blitz {blitz}, Rapid {rapid}, Classical {classical}. {totalGames} games on Kingside.» |
| `og:type` | `profile` |
| `og:image` | `/og/player.png` (volna 2 — динамика с аватаром и рейтингом) |
| `canonical` | `https://kingside.site/player/{username}` |
| JSON-LD | `ProfilePage` + `Person`: `name=username`, `nationality=country`, `additionalType='https://schema.org/Athlete'`. Subject: `Person` без email/phone (skip-fields ADR-128 §6.8.3). |
| Fallback'и | `country=null` → `nationality` пропускаем. `recentGames=[]` → ничего не теряет (поля не нужны в SEO). Если `isCoach=true` — frontend может **дополнительно** добавить `Person.jobTitle='Chess coach'` в JSON-LD (см. C1). |

---

##### C1. `/coach/:username`

| Поле | Значение |
|---|---|
| Компонент | `CoachProfilePage` |
| Файл | `apps/web/src/pages/CoachProfilePage.tsx` |
| API-запросы | `GET /players/:username` (`PlayerProfileResponse`) + `GET /coaches/:username/lectures?status=public` + `GET /coaches/:username/schedule` |
| DTO | `PlayerProfileResponse` + локальные `CoachLecture[]` (`:47-...`: `id`, `title`, `description`, `status`, `scheduledAt?`, `priceCents?`, `recordingUrl?`) |
| Поля для SEO | `username`, `country`, `bestRating`, `stats.totalGames`, lectures: `count`, `nextScheduledAt` (если есть) |
| Prisma | `User` + `Lecture` (api) |
| `<title>` (≤60) | `seo.coach.profile.title` — «{username} — chess coach — Kingside» / «{username} — шахматный тренер — Kingside» |
| `<meta description>` (≤160) | `seo.coach.profile.description` — «{username}: chess coach. {bestRating} {bestType} rating. {lecturesCount} lectures. Book a lesson on Kingside.» |
| `og:type` | `profile` |
| `og:image` | `/og/coach.png` |
| `canonical` | `https://kingside.site/coach/{username}` |
| JSON-LD | `ProfilePage` + `Person` (как P2) + `jobTitle='Chess coach'`, `worksFor={Organization, name='Kingside'}`, `makesOffer=[…Course по public lectures]` (top-10 lectures как `Offer`+`itemOffered=Course`). |
| Fallback'и | `country=null` → пропуск. `lecturesCount=0` → description без mention lectures. `isCoach=false` (зашёл по `/coach/:u` к нетренеру) → frontend редиректит на `/player/:u` (или 404). SEO-метатеги в этом случае не ставятся (не индексируется как coach). |

---

##### L1. `/lectures` (список)

> **Ревизия 2026-06-15 (KS-4190).** KS-4188 поднял публичный эндпоинт
> `GET /lectures/public` (OptionalJwtGuard + rate-limit 60/мин,
> 16 опубликованных лекций на проде). Backend-пробел из исходной
> редакции закрыт. Эта ревизия описывает UI-структуру страницы для
> гостя — см. подраздел **L1.UI** ниже сразу после таблицы L1.

| Поле | Значение |
|---|---|
| Компонент | `LecturesListPage` (→ `LecturesIndexPage`) |
| Файл | `apps/web/src/pages/LecturesIndexPage.tsx` (переэкспорт в `LecturesListPage.tsx`) |
| API-запросы | **Гость**: `GET /lectures/public?limit=&offset=` (агрегат `visibility='public'`, исключает `cancelled`; сортировка `scheduledAt DESC, createdAt DESC` — финальная группировка по `status` делается на фронте). **Авторизованный**: текущие 4 запроса `GET /my/lectures?status=*` (как сейчас, без изменений) + **дополнительно** тот же `GET /lectures/public` для секции «Discover». |
| DTO | `{ items: PublicLecture[], total, limit, offset, hasMore }`. Поля `PublicLecture`: `id`, `title`, `description?`, `status: 'scheduled'\|'live'\|'recorded'`, `visibility: 'public'`, `scheduledAt: string\|null`, `coach: { id, username, country? }` (без email/phone/lastSeenAt — вырезает `toPublicDto`), `liveAnalysis: { id, slug, startingFen }\|null`, `recording: { startingFen }\|null`, `previewFen?: string` (после `withPreviewFen`), `audio?: { durationMs }` (для recorded). |
| Поля для SEO | агрегаты: `total` (если есть — в JSON-LD `numberOfItems`), top-N `items[].title`, top-N `items[].coach.username` для `ItemList`. |
| Prisma | `Lecture` + `User` (как `coach`) + `LiveAnalysis` (для live) + `LectureRecording` (для recorded) + `LectureAudio` (`durationMs`). |
| `<title>` (≤60) | `seo.lectures.list.title` — «Chess lectures and coaches — Kingside» |
| `<meta description>` (≤160) | `seo.lectures.list.description` — «Live and recorded chess lectures by titled coaches. Book a class, watch replays on Kingside.» |
| `og:type` | `website` |
| `og:image` | `/og/lecture.png` |
| `canonical` | `https://kingside.site/lectures` (без `?status=` / `?offset=` — фильтры не canonical-семантика) |
| JSON-LD | `CollectionPage` + `ItemList` с top-10 (или меньше) `items` как `Course`: `{ '@type': 'Course', name: title, provider: { '@type': 'Organization', name: 'Kingside' }, instructor: { '@type': 'Person', name: coach.username } }`. Если `total > 0` — `numberOfItems: total`. |
| Fallback'и | Список пустой (`total=0`) → JSON-LD без `ItemList`, фронт показывает empty-state (`lecturesPublic.empty.*`). API 5xx / network → state `error`, фронт показывает retry-кнопку (см. L1.UI ниже), JSON-LD не выводим. |

##### L1.UI. UI-структура страницы (расширение L1, KS-4190)

> Цель: убрать сценарий, при котором гость видит четыре «Failed to load
> lectures. Please try again» на странице с уже-проиндексированным
> SEO-заголовком. Гость должен попадать на работающий публичный
> каталог; авторизованный — на текущие коуч/студент-секции +
> дополнительный публичный каталог.

###### L1.UI.1. Источник режима

- Режим определяет `useAuth().user`. Никаких feature-flag'ов.
- **Гость (`user==null`)** — рендерится **только** публичный каталог
  (`<PublicLecturesCatalog>`). Никаких секций «As a Coach» / «As a
  Student» — они для гостя бессмысленны и сейчас именно они и
  выдают 401.
- **Авторизованный (`user!=null`)** — три секции в порядке: (1) `As a
  Coach` (текущий `MyLecturesPage`); (2) `As a Student` (текущий
  `StudentLecturesPage`); (3) `Discover public lectures` (новый
  `<PublicLecturesCatalog>` с `limit=6` и ссылкой «See all» на
  …отдельную страницу — не вводим, см. §L1.UI.7 «See all»).

###### L1.UI.2. Структура для гостя (по блокам)

| Блок | Содержание |
|---|---|
| 1. Hero | `<h1>` из `lecturesPublic.hero.title` (один на странице — другие `h2` не конкурируют). `<p>` подзаголовка из `lecturesPublic.hero.subtitle`: 1 предложение, описывающее раздел. Без иллюстрации (опционально иконка). |
| 2. Inline guest-CTA баннер (паттерн A, ADR-128 §6.1) | Узкий баннер «Войдите, чтобы бронировать лекции и получать доступ к live-эфирам» + ссылка «Войти» → `/login`. Не модалка, не блокирует контент. Текст: `lecturesPublic.guest.bannerText` + `lecturesPublic.guest.bannerCta`. |
| 3. Фильтр статусов | Tab-bar: `All` / `Live now` / `Scheduled` / `Recorded`. Без `Cancelled` (backend исключает). Без фильтра `visibility` (всё public). Без кнопки «Schedule a lecture». Клиентский фильтр над выкаченным набором (см. §L1.UI.4). Active tab сохраняется в URL `?status=` для shareable-ссылок; на canonical не влияет (canonical всегда голый `/lectures`). |
| 4. Грид карточек | Список `<PublicLectureCard>` (см. §L1.UI.3). Сначала — `live` (если есть в текущем фильтре), затем `scheduled` по `scheduledAt ASC` (ближайшие сверху), затем `recorded` по `createdAt DESC`. Группировку делает фронт, backend отдаёт плоский список. |
| 5. Пагинация | Кнопка «Show more» (`lecturesPublic.loadMore`) внизу. Подгружает следующую страницу через `offset += limit`. Limit по умолчанию **24** (4×6 desktop / 3×8 mobile — кратно популярным грид-сеткам, но это уже задача layout). Если `hasMore=false` — кнопка скрыта. |
| 6. Empty state | Если `items=[]` после первой загрузки — карточка-заглушка с текстом `lecturesPublic.empty.title` + `lecturesPublic.empty.subtitle` («Public lectures coming soon. Browse coaches to see private offerings.»). Ссылка на `/players?tab=coaches` (если такого таба нет — на `/players`). |
| 7. Error state | На 5xx / network: блок «Failed to load lectures» + кнопка «Try again» (`lecturesPublic.error.title` / `lecturesPublic.error.retry`). Один блок на всю страницу — **не четыре**, как сейчас. |

###### L1.UI.3. Карточка `<PublicLectureCard>`

| Элемент | Источник | Fallback / правила |
|---|---|---|
| Preview доски | `previewFen` (PNG-render через существующий board-snapshot компонент проекта) | `previewFen=null` → `/og/lecture.png` как 16:9 placeholder, либо просто пустой quadrat с иконкой. |
| Бейдж статуса | `status` | `live` → красный точка-индикатор + «Live now» (`lecturesPublic.card.live`); `scheduled` → синий «Scheduled` + локализованная дата `{scheduledAt}` (`lecturesPublic.card.scheduled`); `recorded` → серый «Recorded» + дата записи или `createdAt` (`lecturesPublic.card.recorded`). |
| Заголовок | `title` | Обрезка 2 строк (CSS line-clamp, не frontend) — фактическое обрезание — задача layout. |
| Тренер | `coach.username` → ссылка на `/coach/:username` | Ссылка не блокирует клик карточки (см. ниже). |
| Длительность | `audio.durationMs` для recorded → форматирование `mm:ss` или `Hh Mm` | `null` → блок скрыт. |
| Описание-превью | `description` | `null/''` → блок скрыт; иначе обрезка ~2 строки. |
| Клик по карточке | → `/lectures/:id` | Стандартный link. Внутри карточки могут быть subordinate-links (на `/coach/:u`) — для них `stopPropagation`, чтобы клик по никнейму не уносил на детальную лекцию. |
| Hover | визуальный hint — задача layout | — |

`priceCents` / «book this lecture» на карточке **не показываем** —
это уже логика страницы детали (`/lectures/:id`, L2). Карточка
гостя — только превью; решение «купить» гость принимает на L2 через
`useRequireAuth` (паттерн B, ADR-128 §6.2). На L1 — никаких discrete
write-actions.

###### L1.UI.4. Клиентская группировка и фильтр

Backend отдаёт смешанный список с сортировкой `scheduledAt DESC, createdAt DESC`. Фронт:

1. Делит на 3 группы по `status`.
2. Внутри `live` — `createdAt DESC`.
3. Внутри `scheduled` — `scheduledAt ASC` (ближайшие сверху).
4. Внутри `recorded` — `createdAt DESC`.
5. Если фильтр `All` — выводит подряд live → scheduled → recorded.
6. Если фильтр `Live now` / `Scheduled` / `Recorded` — только своя группа.

Поскольку backend пагинирует **до** разделения по статусу, при
агрессивной пагинации в одном «окне» (offset=0, limit=24) может
оказаться, например, 0 live + 4 scheduled + 20 recorded. Это
ожидаемо: гость кликает «Show more», подгружается следующая
страница, статусы перераспределяются. Это компромисс — клиентский
ре-сортинг не ломает «Show more»-логику, потому что `hasMore`
отдаётся backend по полному набору, а не по группе.

Если в будущем потребуется per-status пагинация — добавляем
backend-параметр `lifecycleStatus`, в этом ADR не делаем (KS-4188
эндпоинт без этого параметра, и пользователь не блокирован).

###### L1.UI.5. Структура для авторизованного

Сохраняется текущий `LecturesIndexPage` (две секции). Дополнительно
ниже добавляется третья секция:

| Блок | Содержание |
|---|---|
| Section 3 header | `<h2>` = `lecturesPublic.authSection.title` («Discover public lectures»). |
| Section 3 body | `<PublicLecturesCatalog limit=6 noPagination>` — превью первых 6 карточек, без фильтра, без «Show more», без hero/баннера. |
| Footer ссылка | «See all» → анкор-ссылка `#discover-all` на самой же странице? Или отдельная страница? — см. §L1.UI.7. |

###### L1.UI.6. CTA — где (паттерн A) и где (паттерн B)

| Действие | Паттерн | Где |
|---|---|---|
| «Войти» (общий) | **A** — inline-CTA баннер | Hero (Блок 2) на гостевой странице. Не модалка, обычная ссылка. |
| Открытие карточки → `/lectures/:id` | — | Открыт всем (OptionalJwtGuard на L2). Гость попадает на детальную страницу лекции — там действия (book/buy) уже на ней. |
| Клик на коуча → `/coach/:username` | — | Открыт всем. |

Discrete-actions «book this lecture» / «buy access» — **не на L1**,
а на `/lectures/:id` (L2). Там паттерн B через `useRequireAuth`.

###### L1.UI.7. «See all» в секции 3 (авторизованный)

Сейчас отдельной страницы «все публичные лекции для авторизованного
пользователя» **нет**. Вариант — добавить query-параметр на ту же
страницу:

- `<a href="/lectures?view=discover">` — гость видит обычный
  публичный каталог; авторизованный по этой ссылке **скрывает** свои
  две секции и показывает только публичный каталог.
- В таком виде «See all» — это ссылка `/lectures?view=discover`,
  компонент `LecturesIndexPage` читает `searchParams.get('view')` и
  при `view='discover'` рендерит то же, что гостю (без секций As a
  Coach / As a Student). `canonical` всё равно остаётся голым
  `/lectures` (фильтр UI-вью, не контентного состояния).

Это решение **рекомендуется** как стартовое: не нужна отдельная
маршрутизация. Альтернативно — авторизованный остаётся на
`/lectures` без отдельного «See all», полный каталог открывает по
явному управлению `?status=` фильтром. Решение — за frontend в KS-4190-FE,
рекомендация в ADR — `?view=discover`.

###### L1.UI.8. i18n-ключи

Новые ключи (на `en` и `ru`, финальные строки — маркетинг):

```
lecturesPublic.hero.title              // h1
lecturesPublic.hero.subtitle           // 1 предложение

lecturesPublic.guest.bannerText        // «Войдите, чтобы бронировать лекции и live-доступ»
lecturesPublic.guest.bannerCta         // «Войти» → /login

lecturesPublic.filter.all              // «All»
lecturesPublic.filter.live             // «Live now»
lecturesPublic.filter.scheduled        // «Scheduled»
lecturesPublic.filter.recorded         // «Recorded»

lecturesPublic.card.live               // «Live now»
lecturesPublic.card.scheduled          // «Scheduled for {date}»
lecturesPublic.card.recorded           // «Recorded» (+ {date} в подписи карточки)
lecturesPublic.card.byCoach            // «by {coach}»
lecturesPublic.card.duration           // «{duration}» (минуты, формат — layout)

lecturesPublic.empty.title             // «No public lectures yet»
lecturesPublic.empty.subtitle          // «Public lectures are coming soon. Browse coaches to see private offerings.»
lecturesPublic.empty.coachesLink       // «Browse coaches» → /players

lecturesPublic.error.title             // «Failed to load lectures»
lecturesPublic.error.retry             // «Try again»

lecturesPublic.loadMore                // «Show more»
lecturesPublic.authSection.title       // «Discover public lectures» (h2 третьей секции)
lecturesPublic.authSection.seeAll      // «See all» → /lectures?view=discover
```

SEO-ключи `seo.lectures.list.*` — уже есть (§7.6.1.4), не дублируем.

###### L1.UI.9. Что меняется в коде (для KS-4190-FE)

| Файл | Что |
|---|---|
| `apps/web/src/pages/LecturesIndexPage.tsx` | Развилка по `useAuth().user`. Гость → `<PublicLecturesCatalog mode="full" />`. Авторизованный → текущие `<MyLecturesPage>` + `<StudentLecturesPage>` + `<PublicLecturesCatalog mode="preview" limit={6} />`. Дополнительно: `useSearchParams().get('view')==='discover'` → автоматически режим гостя. |
| `apps/web/src/pages/LecturesListPage.tsx` | Без изменений (переэкспорт). |
| `apps/web/src/components/lectures/PublicLecturesCatalog.tsx` | **Новый.** Принимает `mode: 'full' \| 'preview'`, `limit?: number`. Делает `GET /lectures/public` с пагинацией. Рендерит блоки 1–7 (§L1.UI.2) в режиме `full`. В режиме `preview` — только грид карточек, без hero/баннера/фильтра/пагинации/empty. |
| `apps/web/src/components/lectures/PublicLectureCard.tsx` | **Новый.** Принимает `PublicLecture`. Рендерит всё из §L1.UI.3. |
| `apps/web/src/hooks/usePublicLectures.ts` | **Новый.** Хук — обёртка над `GET /lectures/public` с состояниями `loading / error / data` и `loadMore()`. Тип ответа — `PublicLecturesResponse` (см. shared types). |
| `apps/web/src/api/lecturesApi.ts` (либо `api.ts`) | Добавить вызов с типизацией. |
| `packages/shared/src/types/api-contracts.ts` | Добавить `PublicLecture` (см. поля выше) и `PublicLecturesResponse = { items: PublicLecture[]; total: number; limit: number; offset: number; hasMore: boolean }`. |
| `apps/web/src/i18n/locales/{en,ru}/translation.json` | Добавить узел `lecturesPublic.*` (§L1.UI.8). Финальные строки — KS-MK. |
| `apps/web/scripts/prerender.mjs` | Прокинуть в моках `/lectures/public` → стабильный фиктивный ответ (например, пустой `items:[]` + `total:0` + `hasMore:false`), чтобы prerender выдавал empty-state с корректными SEO-метатегами, а не «Failed to load». |

###### L1.UI.10. Декомпозиция

| Тикет | Скоуп |
|---|---|
| **KS-4190-FE** | Реализация (§L1.UI.9). Зависит от KS-4171 (`<SeoHelmet>`) только в части метатегов — UI может ехать параллельно. |
| **KS-4190-LL** | CSS-стили для `<PublicLecturesCatalog>`, `<PublicLectureCard>`, фильтр-табов, грид-сетки, адаптива. |
| **KS-4190-MK** | Финальные строки `lecturesPublic.*` на en+ru. |
| **KS-4190-FE-PR** | Обновление prerender-моков (`/lectures/public` → empty ответ). Это маленький подтикет внутри KS-4190-FE, можно не выделять отдельно. |

Зависимости: KS-4189 (метатеги `/lectures`) **не блокируется**
этим UI-патчем — может ехать параллельно, текстовые ключи `seo.lectures.list.*` уже есть. Сильное упрощение для frontend: гостевая страница теперь имеет содержательный empty-state вместо «Failed to load».

KS-4189 + KS-4190-FE сводятся в одну страницу (`LecturesIndexPage`), но как отдельные тикеты — допустимо: KS-4189 ставит `<SeoHelmet>` и SEO-meta, KS-4190-FE переписывает контент-структуру. Координатор может слить их в один тикет, если выгоднее по объёму.

---

##### L2. `/lectures/:id`

| Поле | Значение |
|---|---|
| Компонент | `LectureLandingPage` |
| Файл | `apps/web/src/pages/LectureLandingPage.tsx` |
| API-запросы | `GET /lectures/:id` (открыт по `OptionalJwtGuard`, `lectures.controller.ts:125-129`) |
| DTO | `LectureDetailResponse` (точная форма — в `lectures.service.ts`; ключевые поля: `id`, `title`, `description`, `coach.{id,username}`, `status`, `visibility`, `scheduledAt?`, `duration?`, `priceCents?`, `recordingUrl?`) |
| Поля для SEO | `title`, `description`, `coach.username`, `status`, `scheduledAt`, `duration`, `priceCents` |
| Prisma | `Lecture` (поля как в DTO) |
| `<title>` (≤60) | `seo.lectures.detail.title` — «{title} — by {coach} — Kingside» |
| `<meta description>` (≤160) | `seo.lectures.detail.description` — «{title} by {coach}. {scheduledAt}. {duration} min. {description}. Book on Kingside.» |
| `og:type` | `article` (для recorded) / `event` (для scheduled/live) — выбирается по `status` |
| `og:image` | `/og/lecture.png` (volna 2 — превью с темой и тренером) |
| `canonical` | `https://kingside.site/lectures/{id}` |
| JSON-LD | `Course`: `name=title`, `description`, `provider={Organization Kingside}`, `instructor={Person coach}`. Если `status='scheduled'` — дополнительно вкладываем `hasCourseInstance` (`CourseInstance` с `startDate=scheduledAt`, `duration`). Если `priceCents!=null` — `offers={Offer price=priceCents/100, priceCurrency='USD'}`. |
| Fallback'и | `description=null` → description в meta — generic строка. `scheduledAt=null` (recorded) → `og:type='article'`, JSON-LD без `CourseInstance`. `priceCents=null` → `offers` пропускаем. `recordingUrl=null && status=='recorded'` → лекция технически недоступна; SEO ставим как article, но «book» в meta заменяем на «watch on Kingside». |

---

##### A1. `/archive` (список)

| Поле | Значение |
|---|---|
| Компонент | `ArchiveGamesPage` |
| Файл | `apps/web/src/pages/ArchiveGamesPage.tsx` |
| API-запросы | `GET /games` (archive-service: `ArchiveGamesResponse`) + `GET /tree` (агрегаты) |
| DTO | `ArchiveGamesResponse` (`packages/shared/src/types/archive.ts:222`): `total`, `hasNext`, `nextCursor`, `items[]: ArchiveGameSummary` |
| Поля для SEO | Агрегаты: `total` (если есть — «{total} games archived»), top-3 `items[].event` для текстового блока |
| Prisma | archive-service: `ArchiveGame` (поля `pgn`, `whitePlayer`, `blackPlayer`, `event`, `eco`, `timeControl`) |
| `<title>` (≤60) | `seo.archive.list.title` — «Master games archive — Kingside» / «Архив партий — Kingside» |
| `<meta description>` (≤160) | `seo.archive.list.description` — «Search master chess games by player, event, ECO, position. Replay with engine analysis on Kingside.» |
| `og:type` | `website` |
| `og:image` | `/og/archive.png` |
| `canonical` | `https://kingside.site/archive` (без query — фильтры не canonical-семантика) |
| JSON-LD | `CollectionPage` + `SearchAction` (есть поле поиска): `SearchAction.target='https://kingside.site/archive?player={query}'`. |
| Fallback'и | `total=null` → описание без «{total}». `items=[]` → JSON-LD без вложенных. |

---

##### A2. `/archive/games/:id`

| Поле | Значение |
|---|---|
| Компонент | `ArchiveGamePage` |
| Файл | `apps/web/src/pages/ArchiveGamePage.tsx` |
| API-запрос | `GET /games/:id` (`ArchiveGameDetail`, `archive.ts:192`) |
| DTO | `ArchiveGameDetail`: `id`, `white`, `black`, `result`, `event`, `site`, `round`, `date`, `eco`, `opening`, `pgn`, `whiteElo`, `blackElo`, `timeControl`, `timeControlCategory` |
| Поля для SEO | `white.name`, `black.name`, `whiteElo`, `blackElo`, `result`, `event`, `date`, `eco`, `opening`, `pgn` |
| Prisma | archive-service: `ArchiveGame` |
| `<title>` (≤60) | `seo.archive.game.title` — «{white} vs {black} ({result}) — {event}» (если суммарно >60: «{white} vs {black} ({result})») |
| `<meta description>` (≤160) | `seo.archive.game.description` — «{white} ({whiteElo}) — {black} ({blackElo}), {event}, {date}. {opening} ({eco}). Replay on Kingside.» |
| `og:type` | `article` |
| `og:image` | `/og/archive.png` (volna 2 — динамика с превью доски на финальной позиции) |
| `canonical` | `https://kingside.site/archive/games/{id}` |
| JSON-LD | `Article`: `headline='{white} vs {black}'`, `author=[{Person name=white.name},{Person name=black.name}]`, `datePublished=date` (если есть), `articleBody=pgn` (для индексации полного текста; ключевая часть для длинного-хвоста по позициям). `isPartOf={Event name=event}` если есть. |
| Fallback'и | `whiteElo/blackElo=null` → скобки пропускаем. `event=null` → title без `{event}`. `date=null` → `datePublished` JSON-LD пропускаем. `opening=null && eco=null` → блок opening в description пропускаем. `pgn` всегда есть (по контракту, A2 — это detail-страница, pgn гарантирован). |

---

##### A3. `/archive/players/:slug`

| Поле | Значение |
|---|---|
| Компонент | `ArchivePlayerProfilePage` |
| Файл | `apps/web/src/pages/ArchivePlayerProfilePage.tsx` |
| API-запросы | `GET /players/:slug` (`ArchivePlayerProfile`, `archive.ts:333`) + `GET /players/:slug/games?...` (`ArchivePlayerGamesResponse`) |
| DTO | `ArchivePlayerProfile`: `name`, `slug`, `gamesCount`, `peakElo`, `byColor.{white,black}`, `byResult.{wins,draws,losses}`, `firstSeenAt`, `lastSeenAt` |
| Поля для SEO | `name`, `gamesCount`, `peakElo`, `byResult`, `firstSeenAt`, `lastSeenAt` |
| Prisma | archive-service: `ArchivePlayer` |
| `<title>` (≤60) | `seo.archive.player.title` — «{name} — archive — Kingside» |
| `<meta description>` (≤160) | `seo.archive.player.description` — «{name}: {gamesCount} archived games, peak {peakElo}. {wins} wins, {draws} draws, {losses} losses on Kingside.» |
| `og:type` | `profile` |
| `og:image` | `/og/archive.png` (общая для архива; player-specific — volna 2) |
| `canonical` | `https://kingside.site/archive/players/{slug}` |
| JSON-LD | `ProfilePage` + `Person`: `name=name`, `additionalType='https://schema.org/Athlete'`. Без `email`/`telephone` (skip-fields ADR-128 §6.8.3) — у архивных игроков их и нет, это master/external. |
| Fallback'и | `peakElo=null` → пропуск в title и description. `firstSeenAt/lastSeenAt=null` → пропуск (это и так в bullet'ах description). |

---

#### 7.6.1.3. Статические og:image-картинки

Список файлов под `apps/web/public/og/`. Размер каждой — **1200×630**
PNG, ≤300 КБ. Брендинг (логотип + название Kingside) + иллюстрация
сущности.

| Файл | Используется на маршрутах |
|---|---|
| `landing.png` | `/` (variant=home), `/features` — см. ADR-129 §7.3 |
| `broadcast.png` | `/broadcasts`, `/broadcasts/:tid`, `/broadcasts/:tid/:rid`, `/broadcasts/:tid/:rid/:gid` (fallback, когда `meta.imageUrl` от Lichess пустой) |
| `tournament.png` | `/tournaments`, `/tournaments/:id`, `/arena/:id` |
| `player.png` | `/players`, `/player/:username` |
| `coach.png` | `/coach/:username` |
| `lecture.png` | `/lectures`, `/lectures/:id` |
| `archive.png` | `/archive`, `/archive/games/:id`, `/archive/players/:slug` |
| `default.png` | Fallback на любых других public страницах (`/feedback`, `/feedback/:id`, `/terms`, `/credits`, и т. д.); используется в `<SeoHelmet>` при отсутствии явного `og:image` |

Итого **8 PNG** на боевой сервер на первую итерацию. Динамическая
генерация per-entity картинок (например, превью с FEN текущей
позиции, аватаром игрока, постером лекции) — volna 2, отдельный
ADR (вне KS-4172).

Задача content на эти файлы — KS-4172-CT (см. §10 ниже). Если на
момент frontend'-реализации какой-то PNG ещё не готов — fallback на
`/og/default.png` или `/og/landing.png` (frontend `<SeoHelmet>` сам
не падает).

#### 7.6.1.4. Свод i18n-ключей `seo.*`

Финальные тексты пишет marketing (KS-4172-MK ниже). Архитектор фиксирует
структуру ключей и переменных:

```
seo.broadcasts.list.title
seo.broadcasts.list.description
seo.broadcasts.tournament.title              // {title}
seo.broadcasts.tournament.description        // {title}, {roundCount}
seo.broadcasts.tournament.descriptionFromLichess  // используется как-есть, обрезается
seo.broadcasts.round.title                   // {tournament}, {round}
seo.broadcasts.round.description             // {tournament}, {round}, {gamesCount}
seo.broadcasts.round.descriptionNoGames      // {tournament}, {round}
seo.broadcasts.game.title                    // {white}, {black}, {result}
seo.broadcasts.game.titleNoResult            // {white}, {black}, {tournament}
seo.broadcasts.game.description              // {white}, {whiteElo}, {black}, {blackElo}, {tournament}, {round}, {opening}
seo.broadcasts.game.descriptionNoElo         // {white}, {black}, {tournament}, {round}, {opening}

seo.tournaments.list.title
seo.tournaments.list.description
seo.tournaments.detail.title                 // {name}
seo.tournaments.detail.description           // {name}, {type}, {timeControl}, {participantsCount}, {startsAt}
seo.tournaments.detail.descriptionNoDesc     // тот же набор переменных, generic-текст

seo.players.list.title
seo.players.list.description
seo.players.profile.title                    // {username}, {bestRating}, {bestType}
seo.players.profile.description              // {username}, {bullet}, {blitz}, {rapid}, {classical}, {totalGames}

seo.coach.profile.title                      // {username}
seo.coach.profile.description                // {username}, {bestRating}, {bestType}, {lecturesCount}

seo.lectures.list.title
seo.lectures.list.description
seo.lectures.detail.title                    // {title}, {coach}
seo.lectures.detail.description              // {title}, {coach}, {scheduledAt}, {duration}, {description}
seo.lectures.detail.descriptionRecorded      // {title}, {coach}, {description}

seo.archive.list.title
seo.archive.list.description
seo.archive.game.title                       // {white}, {black}, {result}, {event}
seo.archive.game.titleShort                  // {white}, {black}, {result}
seo.archive.game.description                 // {white}, {whiteElo}, {black}, {blackElo}, {event}, {date}, {opening}, {eco}
seo.archive.game.descriptionNoElo            // {white}, {black}, {event}, {date}, {opening}
seo.archive.player.title                     // {name}
seo.archive.player.description               // {name}, {gamesCount}, {peakElo}, {wins}, {draws}, {losses}
seo.archive.player.descriptionNoPeak         // {name}, {gamesCount}, {wins}, {draws}, {losses}
```

Языки — `en` + `ru` (минимум на первой итерации). Будущие — добавляются
без структурных изменений.

#### 7.6.1.5. Что не входит в эту карту

- **Маршруты PF-тренажёров** (`/play`, `/puzzles`, `/precision`,
  `/drills`, `/blind-board`, `/guess`, `/opening-trainer`, `/workshop`,
  `/analysis`). Они индексируются как marketing/tool-страницы, без
  per-entity DTO — у них только статика (заголовок раздела, описание
  возможностей). Шаблоны для них — отдельный задел (можно
  параметризовать одним конфигом с `seo.tools.{key}.title/description`,
  не требуют API-запросов). См. §7.7 (PM-шаблон) — уже описан в
  ADR-128.
- **`/feedback`, `/feedback/:id`** — PR, но `feedback` это бэклог
  фич. Индексировать каждый тикет отдельным title/description можно;
  не вошло в KS-4172 (фокус — карточки контента). Добавляется
  follow-up'ом, если нужно.
- **`/live/:slug`** — `noindex` ставит сама страница (ADR-110), в
  карту не входит.
- **PV-страницы** (`/profile`, `/messages`, `/settings`, `/lessons/my/*`)
  — `noindex` или редирект на `/login`, SEO не нужно.

#### 7.6.1.6. Декомпозиция на исполнительские тикеты

Карта готова — координатор раздаёт по одной маленькой задаче на
сущность. На каждой стороне frontend подставляет шаблон из §7.6.1.2
без дополнительного проектирования.

| Тикет | Скоуп | Что делает |
|---|---|---|
| **KS-4172-FE-B** | broadcasts (B1–B4) | `<SeoHelmet>` в `BroadcastsPage`, `BroadcastTournamentPage`, `BroadcastRoundPage`, `BroadcastGamePage`+`BroadcastLiveGamePage`. Подставляет шаблоны/ключи/fallback'и точно по таблице. |
| **KS-4172-FE-T** | tournaments (T1, T2) | `<SeoHelmet>` в `TournamentsPage`, `TournamentLobbyPage`. |
| **KS-4172-FE-P** | players (P1, P2) | `<SeoHelmet>` в `PlayersPage`, `PlayerProfilePage`. |
| **KS-4172-FE-C** | coach (C1) | `<SeoHelmet>` в `CoachProfilePage`. |
| **KS-4172-FE-L** | lectures (L1, L2) | `<SeoHelmet>` в `LecturesListPage`, `LectureLandingPage`. |
| **KS-4172-FE-A** | archive (A1, A2, A3) | `<SeoHelmet>` в `ArchiveGamesPage`, `ArchiveGamePage`, `ArchivePlayerProfilePage`. |
| **KS-4172-BE-1** (backend) | публичный список лекций | `GET /lectures/public?status=public&limit=&offset=` — агрегат опубликованных лекций по всем тренерам. `OptionalJwtGuard`, rate-limit. Skip-fields — без `priceCents` (можно отдавать; контент публичный). Для закрытия пробела L1 (§7.6.1.2). |
| **KS-4172-CT** | content | 8 OG-картинок 1200×630 PNG в `apps/web/public/og/` (список §7.6.1.3). |
| **KS-4172-MK** | marketing | Финальные строки для ключей `seo.*` (§7.6.1.4) на en + ru, ≤60 / ≤160 символов с подставленными переменными. |

Зависимости: KS-4171 (`<SeoHelmet>` на нативных metadata-тегах
React 19, см. §7.6.1.1.A) — общая инфраструктура, **блокирует**
все KS-4172-FE-*. KS-4172-MK блокирует
все KS-4172-FE-* (без строк нечего ставить в `<title>`). KS-4172-CT
не блокирует (frontend стартует с fallback `/og/default.png`).
KS-4172-BE-1 блокирует только KS-4172-FE-L (для L1).

Порядок: KS-4171 + KS-4172-MK → KS-4172-FE-B, KS-4172-FE-T,
KS-4172-FE-P, KS-4172-FE-C, KS-4172-FE-A (параллельно) →
KS-4172-FE-L (после KS-4172-BE-1). KS-4172-CT — параллельно в любой
момент.

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

### 7.8. Метатеги через нативные metadata-теги React 19

> **Ревизия 2026-06-15 (KS-4176).** Изначально секция предписывала
> `react-helmet-async`. Пакет не поддерживает React 19 (peerDeps до 18,
> `npm install` падает с EERESOLVE). Используем нативный механизм
> Document Metadata React 19 — контракт компонента-обёртки
> `<SeoHelmet>` описан в §7.6.1.1.A.

Каждая PR/PM/PX страница ставит свои `<title>`, `<meta>`, `<link
rel="canonical">`, `<meta property="og:*">` напрямую в JSX через
`<SeoHelmet>` (§7.6.1.1.A). React 19 автоматически переносит эти
теги в `<head>` документа — работает и в runtime SPA, и в pre-render
пайплайнах (build-time через Playwright headless у нас и runtime,
если позже введём).

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

16. **`/lessons`, `/lessons/:courseSlug`, `/lessons/:courseSlug/:lessonSlug`,
    `/lessons/discover`** — открыть каталог и просмотр уроков гостю
    (PF, §11.2 решено в KS-4127). Гость проходит уроки локально, как
    `/puzzles`; прогресс не пишется в БД до логина; inline-CTA на
    странице урока. Контент курсов — пользователь, без chess-expert /
    content-агента.

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
>
> **Ревизия 2026-06-15 (KS-4127).** KS-19 уточнён — `/lessons`
> открывается гостю как PF (а не «PR/PF зависит от §11.2»),
> конкретные эндпоинты и paths перечислены явно. Отдельного тикета
> под §11.3 (onboarding) не вводится — текущее поведение
> `OAuthCallbackPage` + `UsernameSetupModal` + `returnUrl` остаётся
> финальным.
>
> **Ревизия 2026-06-15 (KS-4129).** Добавлены тикеты KS-33 (массовое
> приведение GET-эндпоинтов к контракту §6.8 по per-namespace
> чек-листу) и KS-34 (фронт-перехватчик 401 по §6.9). Эти два тикета
> закрывают системную проблему «фронт открыл маршрут, бэк возвращает
> 401, перехватчик кидает гостя на /login».

| # | Тикет | Что | Исполнитель | Размер | Зависит от |
|---|-------|-----|-------------|--------|------------|
| 1 | KS-4118 (rewrite) | Backend: открыть `GET /broadcasts*`, `GET /arena*`, `GET /players*`, `GET /coaches/*`, `GET /feedback*`, `GET /lectures*` через `OptionalJwtGuard`; throttler 60 req/min на IP; скрыть приватные поля DTO | backend | M | этот ADR |
| 2 | KS-4119 (rewrite) | Frontend: снять `ProtectedRoute` с витрин; рендер для гостя; починить `/features` | frontend | M | 1 |
| 3 | KS-4124 (done) | Frontend: `<LoginRequiredModal>` + `useRequireAuth` + `RequireAuthProvider` | frontend | M | этот ADR |
| ~~4~~ | ~~MarketingLanding~~ | **Отменён (KS-4125).** Шаблон не вводится. | — | — | — |
| ~~5~~ | ~~Контент лендингов~~ | **Отменён (KS-4125).** Гость попадает на сам тренажёр. Контент `/features` остаётся в KS-4119 п.2 | — | — | — |
| 6 | KS-новый | Frontend: внедрить `useRequireAuth` в action-кнопки витрин (`/broadcasts/:id` чат, `/tournaments/:id` register, `/players/:u` вызов/сообщение, `/feedback` голос/коммент). Образец готов — `PlayerProfilePage`, `TournamentLobbyPage` | frontend | M | 3 |
| 7 | KS-новый | Frontend: SEO-метатеги per-route + JSON-LD через нативные metadata-теги React 19 (компонент-обёртка `<SeoHelmet>`, §7.6.1.1.A); по странице на PR/PF/PX маршрут | frontend + content | L | 1, 2 |
| **DYNAMIC PRERENDER (KS-4121)** | | | | | |
| 8 | KS-новый | DevOps: SQS `kingside-prerender-tasks`, S3 `kingside-prerender-store`, IAM, CloudFront Function маппинг путей §7.3.4 | devops | M | 1 |
| 9 | KS-новый | Backend: `apps/prerender-service` (ECS Fargate + Playwright), слушает SQS, рендерит, кладёт в S3 | backend + devops | L | 8 |
| 10 | KS-новый | Shared: `packages/shared/prerender-client.ts` (SQS sendMessage с типизацией) | backend | S | 8 |
| 11 | KS-новый | Backend: mutation hooks для on-demand prerender (`CoachService.updateProfile`, `LectureService.publish`/`update`, `ArenaService.finish`, `ArchiveImporterService.afterImport`; broadcast-worker `finishRound`) | backend | M | 9, 10 |
| 12 | KS-новый | DevOps: EventBridge schedule'ы (broadcasts-active 15 мин, tournaments-active 30 мин, lectures-list 30 мин, players-top1000 24 ч, archive-list 24 ч, safety-net 24 ч) | devops | M | 9 |
| 13 | KS-новый | Backend: policy-фильтры (§7.4) для players (top-1000) и archive (avgElo ≥ 2400 / TWIC top-1000) — пороги согласовать с пользователем + marketing (без chess-expert) | backend + marketing | M | 9 |
| 14 | KS-новый | Frontend+content: расширение `<SeoHelmet>` метатегами + JSON-LD (`SportsEvent`, `Person`, `Course`, `Article`) на каждой PR/PF-карточке | frontend + content | L | 7, 9 |
| 15 | KS-новый | Backend: per-entity sitemap'ы (`sitemap-broadcasts.xml`, …) + sitemap-index | backend | M | 11 |
| 16 | KS-новый | Content: SEO-форматы заголовков карточек (broadcast «{tournament} — {round}», player, coach, lecture, archive game). Контент — пользователь, без chess-expert | content | L | 14 |
| 17 | KS-новый | DevOps+backend: og:image (внутри prerender-service или отдельная Lambda — §11.9) | devops + backend | L | 9 |
| **ОТКРЫТИЕ КАТАЛОГОВ И PF-ТРЕНАЖЁРОВ (KS-4125)** | | | | | |
| 18 | KS-новый | Backend: `GET /lobby/open-challenges` (волна 3, для `/lobby` PF) | backend | S | 1 |
| 19 | KS-новый | Backend+frontend: открыть `/lessons`, `/lessons/:courseSlug`, `/lessons/:courseSlug/:lessonSlug` гостю (PF, §11.2 — KS-4127). Backend: `GET /courses/system?published=true`, `GET /courses/:slug`, `GET /lessons/:slug` через `OptionalJwtGuard`; `POST /lessons/:id/progress`, `POST /courses/:slug/start` для гостя → 204 no-op (§11.13). Frontend: снять `ProtectedRoute` с трёх маршрутов; на странице урока — `<GuestCTA variant="banner">`. `lessonsEnabled` остаётся feature-flag'ом, но не auth-gate'ом. Личные `/lessons/my*`, `/lessons/editor` остаются `ProtectedRoute`. Контент курсов — пользователь (без chess-expert, без content-агента) | backend + frontend | M | 1, 22 |
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
| **СИСТЕМНЫЕ ПРАВКИ AUTH-КОНТРАКТА (KS-4129)** | | | | | |
| 33 | KS-новый | Backend: массовое приведение GET-эндпоинтов к контракту §6.8 по чек-листу §6.8.2. Закрытые → `OptionalJwtGuard` для PR/PF, либо переезд на новый `*PublicController` (`OpeningTrainerPublic`, `WorkshopPublic`, `LessonsCoursesPublic`). Для каждой смешанной таблицы — снять class-`@UseGuards(JwtAuthGuard)` (см. P-GET.1), вешать method-level. Throttler/rate-limit на все open-GET (60 req/min). Единый DTO-маппер `toPublicDto(entity, viewer?)` (§6.8.3) для скрытия email/phone/oauthIds/privateNotes/payment/lastSeen на анонимных запросах. Проверить и уточнить тип для **knowledge**, **analysis-review**, **analyses/positional-trace**, **position-comment** (см. строки «проверить» в §6.8.2) | backend | L | этот ADR (§6.8 чек-лист) |
| 34 | KS-новый | Frontend: переписать глобальный 401-перехватчик в `apps/web/src/api.ts` под контракт §6.9. Убрать автоматический редирект на `/login` для гостя; вместо этого: GET 401 для гостя → Sentry-лог + toast; write PR-401 для гостя → открыть `<LoginRequiredModal>` через `useRequireAuth`-механизм. Сохранить refresh-token flow для авторизованного с expired-JWT (текущее поведение) | frontend | M | 33, 22 |

---

## 11. Открытые вопросы

> **Ревизии**: §11.1, §11.4 закрыты KS-4121. KS-4125 добавил §11.12–§11.14.
> KS-4126 закрыл §11.12, §11.13, §11.14. **KS-4127 закрыл §11.2 и §11.3.**
> Прежний §11.12 (S3 layout) переименован в §11.15, чтобы порядок
> появления пунктов соответствовал номерам.
>
> **Состояние §11 на 2026-06-15:** все продуктовые вопросы закрыты.
> Оставшиеся пункты (§11.5 метатеги, §11.6 DDoS, §11.7 WS-handshake,
> §11.8 top-N policy, §11.9 og:image, §11.10 GSC cloaking, §11.11
> scale prerender worker'а, §11.15 S3 layout) — технические, решаются
> при реализации соответствующими исполнителями (frontend/backend/devops).

### 11.1. ~~Где брать данные для prerender PR-маршрутов~~ — **resolved**

Решено в §7.3: prerender-service ходит за реальными данными во
внутренний API из ECS-task'а (не на прод-CloudFront, чтобы не
зациклиться — §7.3.6 (i)). Build-time prerender для PM остаётся без
изменений.

### 11.2. `/lessons` каталог для гостя — **решено (KS-4127): открыть полностью, паттерн A**

Каталог `/lessons` + просмотр уроков `/lessons/:courseSlug`,
`/lessons/:courseSlug/:lessonSlug` открываются для гостя по тому же
шаблону, что и `/puzzles`: гость проходит уроки, прогресс **не
пишется** в БД до логина, на странице — inline guest-CTA «войди для
сохранения прогресса».

Контракт реализации (детали — в KS-19 декомпозиции):

- **Backend:**
  - `GET /courses/system?published=true` открыт для анонимов
    (`OptionalJwtGuard`); `GET /courses/:slug`,
    `GET /lessons/:slug` — то же.
  - `POST /lessons/:id/progress`, `POST /courses/:slug/start` для
    гостя → **204 no-op** (по контракту §11.13 PF write).
  - `lessonsEnabled` остаётся feature-flag'ом, но не auth-gate'ом —
    раздел появляется в навигации и для гостя при `lessonsEnabled=true`.
- **Frontend:**
  - снять `ProtectedRoute` с `/lessons`, `/lessons/:courseSlug`,
    `/lessons/:courseSlug/:lessonSlug`;
  - `<DiscoverCoursesPage>` уже без auth — без изменений;
  - на странице урока — `<GuestCTA variant="banner">` с
    `i18nKey="lessons.guest.saveProgress"` (по паттерну
    `PuzzlePage.tsx:900-903`);
  - `/lessons/my`, `/lessons/my-active`, `/lessons/editor`,
    `/lessons/my/*` остаются `ProtectedRoute` — это личные курсы.
- **Free-preview модели не вводим** — нет в проекте механики
  «бесплатный фрагмент» отдельно от полного урока. Всё
  опубликованное доступно гостю целиком.

Категория `/lessons`, `/lessons/:courseSlug`,
`/lessons/:courseSlug/:lessonSlug` в §4 — **PF** (была PR/PF
«зависит от §11.2», теперь чётко PF). Обновление таблицы — в этой
же ревизии.

Контент курсов (тексты, программа, последовательность уроков) —
**пользователь, без chess-expert и без content-агента**. Решение
явно зафиксировано пользователем в KS-4127.

### 11.3. Onboarding после регистрации — **решено (KS-4127): текущий UsernameSetupModal + return, ничего сверх**

Существующее поведение фиксируется как финальное на сейчас:

- В Kingside нет email/password-регистрации — только OAuth
  (Google, Facebook, Telegram). Точки входа:
  `apps/web/src/layouts/MainLayout.tsx:284-287` (кнопки на странице
  логина), `apps/web/src/pages/LoginPage.tsx:81` (Telegram).
- После первого OAuth-входа `OAuthCallbackPage.tsx:138` рендерит
  `<UsernameSetupModal>` (`apps/web/src/components/UsernameSetupModal.tsx`)
  — пользователь выбирает username.
- После подтверждения username модалка закрывается, страница
  читает `consumeAuthReturnUrl()` (или `state.returnUrl`) и
  возвращает на исходный путь, ради которого был запущен логин.

Этот flow покрывает все три случая входа:
- из `<LoginRequiredModal>` через `useRequireAuth` (паттерн B,
  §6.2) — `returnUrl` пишется в sessionStorage внутри
  `RequireAuthContext.tsx:90, 97` перед навигацией;
- из inline guest-CTA `<Link to="/login">` (паттерн A, §6.1) —
  `LoginPage` сохраняет реферрер по дефолтному react-router-flow;
- из прямого захода на `/login` — `returnUrl` = `/lobby` (или `/play`
  для редиректа в `HomePage`).

**Никакого дополнительного onboarding-шага** в scope ADR-128 не
вводится. Расширенный сбор данных (шахматный уровень, аватар,
предпочтительные тайм-контроли, цели обучения) — отдельная
продуктовая задача в будущем, не в этом ADR.

В §10 декомпозиции добавлять отдельный тикет под §11.3 не нужно —
поведение уже реализовано.

### 11.4. ~~SSR / server-side prerender для динамических сегментов~~ — **resolved**

Решено в §7.3 (отдельный воркер с Playwright, не Lambda@Edge,
не SSR-в-приложении). Cloaking-риск закрыт CloudFront mapping'ом
по path, не по User-Agent (§7.3.4, P5).

### 11.5. Чьи метатеги выигрывают: shell `index.html` vs route-specific

Per-route компоненты через нативные metadata-теги React 19 (`<title>`,
`<meta>`, `<link>` ставятся напрямую в JSX страницы через
`<SeoHelmet>`, см. §7.6.1.1.A; работает и в runtime SPA, и в
prerender). Финальное решение — за frontend в KS-7.

### 11.6. Rate-limit гостя vs DDoS

60 req/min на IP — защита от случайного бота, не от DDoS.
Полноценная DDoS-защита — CloudFront WAF / Cloudflare. Вне scope
ADR-128.

### 11.7. Действия, для которых модалка не подходит

WebSocket-handshake (live-партия, чат трансляции) — после логина
форсируем `socket.io disconnect → reconnect` с новым JWT в handshake.
KS-3 + KS-6.

Глобальный 401-flow REST'а — закрыт §6.9 (KS-4129): перехватчик
больше не редиректит гостя на `/login` автоматически, а открывает
`<LoginRequiredModal>` для PR-write или логирует для PF/GET.

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
