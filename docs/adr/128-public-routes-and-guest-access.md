# ADR-128 — Политика публичных маршрутов и модель «гость читает / логин для действия»

- Статус: **Proposed** (2026-06-14, ревизия §7+§10+§11 в тот же день по KS-4121)
- Задача: KS-4120 (исходный), KS-4121 (ревизия §7)
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

Категории:

- **Public-read** (PR) — гость видит контент; данные тянутся
  публичным API; действия в UI требуют auth, тригерят модалку логина.
- **Public-marketing** (PM) — гость видит лендинг раздела (h1, описание,
  CTA «войти/зарегистрироваться»); полный функционал требует логина.
  Контент prerender = маркетинговый, не данные.
- **Public-mixed** (PX) — гость видит read-копию (`publicMode`), action
  открывает протекцию (типовой кейс — анализ).
- **Private** (PV) — гость не видит, редирект на `/login` (текущее
  поведение).
- **Public-auth** (PA) — публичен по определению (`/login`,
  `/register`, `/oauth/callback`); сюда же системные `/terms`,
  `/credits`, `/help/external-engine`.
- **Dev** (DV) — `import.meta.env.DEV`-only / dev-bypass; в проде нет.

Таблица (фактические маршруты `App.tsx`, сгруппированы):

| Маршрут | Категория | Обоснование |
|---------|-----------|-------------|
| `/` | PR/PM (двойной режим) | Гость — `<FeaturesPage>` (маркетинг + CTA), залогинен — редирект на `/play`. Это поведение менять не нужно, оно правильное. |
| `/features` | PM | Лендинг разделов. Сейчас баг (§3.4) — рендерит то же, что `/`. Должна быть отдельная страница с h1 «Возможности Kingside» и обзором фич. |
| `/login`, `/register`, `/oauth/callback` | PA | Открыто по природе; авторизованный редиректится через `GuestRoute`. |
| `/terms`, `/terms-of-service`, `/credits`, `/help/external-engine`, `/docs/user-courses` | PA | Юридика, документация. Полностью статический контент. |
| `/play` | PM | Сейчас `ProtectedRoute`. Гостю нужен **лендинг** «играй онлайн» с CTA на регистрацию (не SPA-лобби — оно требует профиль и WebSocket-сессию). После логина — редирект на нынешний `<PlayPage>`. |
| `/lobby` | PR (downgrade на PM) | Старое лобби. Гостю показывать список открытых вызовов + CTA «принять — войти». MVP: сделать PM как `/play`. Полный PR — после KS-4118 +1 эндпоинт open challenges. |
| `/tournaments`, `/tournaments/:id`, `/arena/:id` | PR | Гость видит список турниров, расписание, бракет, кросс-таблицу одной арены. Регистрация в арене / попадание в инвайт `/t/:code` — action, модалка логина. |
| `/puzzles`, `/puzzle/:id`, `/puzzles/stats` | PR | **Уже работает** для каталога. Гость листает позиции, видит превью доски, фильтры, статистику публичную. Решение задачи — action (ставит прогресс пользователю, нужен JWT). |
| `/daily` | алиас → `/puzzles` | Историческое — `<Navigate to="/puzzles">`. Не классифицируется, оставить как редирект. |
| `/puzzle-rush`, `/puzzle-rush/leaderboard` | PR (только leaderboard) + PM (лендинг режима) | Лидерборд гостю показываем (это публичная страница `PuzzleRushLeaderboardPage` уже без `ProtectedRoute`). Сам режим (`/puzzle-rush`) — PM-лендинг для гостя; play — action. |
| `/puzzle-rush/review/:scoreId` | PV | Личный review своей попытки, требует ownership. |
| `/precision`, `/precision/stats`, `/precision/history`, `/precision/attempts/:id` | PR (лобби) + PV (личные стат/история/попытка) | Лобби `/precision` сейчас открыто гостю — это PR-каталог позиций. История/статистика — личное. |
| `/analysis`, `/analysis/:id`, `/analysis/public/:id` | PX | `publicMode=true` через `GET /analyses/public/:id` уже работает (ADR-110). Любой `/analysis/:id` гостя без owner-доступа должен переключаться в `publicMode` если анализ помечен shared, иначе модалка. |
| `/analyses/:analysisId/metrics` | PR (если анализ публичный) | Расширение того же контракта (ADR-122). |
| `/game/:id`, `/game/:id/review` | PV | Личная партия. Только просмотр. |
| `/games/live`, `/games/:id/watch` | PR | Уже без `ProtectedRoute` — это наблюдение за чужими live-партиями. Подтверждаем PR. |
| `/workshop`, `/workshop/pgn-files`, `/workshop/pgn-files/:fileId` | PV | Личные PGN-файлы пользователя. Тут открывать гостю нечего; для SEO нужен отдельный PM-лендинг — см. §4.1. |
| `/broadcasts`, `/broadcasts/:tournamentId`, `/broadcasts/:tournamentId/:roundId`, `/broadcasts/:tournamentId/:roundId/:gameId`, `/broadcasts/:tournamentId/:roundId/:gameId/live` | PR | Гость видит список, заходит на трансляцию, смотрит партии в live. Action: чат / лайки / комменты — модалка. |
| `/players` | PR | Рейтинг и поиск игроков. Действия на чужом профиле (вызов, написать) — action. |
| `/player/:username` | PR | Публичный профиль игрока (рейтинги, история, статистика). Вызов/чат — action. Скрыть для гостя: email (если был), приватные настройки, list of friends если они private. |
| `/coach/:username` | PR | Витрина тренера (ADR-113). Action — запись на лекцию. |
| `/lectures`, `/lectures/:id` | PR | Лендинг лекции (free preview) — гостю open. Покупка / запись на live / просмотр приватной записи — action, модалка. Текущие `LecturesListPage` и `LectureLandingPage` уже без `ProtectedRoute` — подтверждаем. |
| `/lectures/:id/live` | PX | Live-эфир. Гостю — превью первых N минут (если ADR-119 позволяет) или сразу модалка. По умолчанию модалка, free-preview — отдельный тикет. |
| `/lectures/:id/replay`, `/lectures/:id/unavailable` | PV → PX | Replay требует ownership. Unavailable — public-info страница. |
| `/archive`, `/archive/games/:id`, `/archive/players/:slug` | PR | Архив партий уже не под `ProtectedRoute`. Подтверждаем. |
| `/lessons` (если `lessonsEnabled`) | PV → частично PR | Сейчас `ProtectedRoute`. Решение: `/lessons` лендинг (PR-каталог системных курсов) + `/lessons/discover` уже PR. Запись на курс / просмотр уроков — action. **Менять с осторожностью** — это завязано на ADR-026 / ADR-054. См. §11.2. |
| `/lessons/discover` | PR | Уже работает. |
| `/lessons/my`, `/lessons/my-active`, `/lessons/editor`, `/lessons/:courseSlug`, `/lessons/:courseSlug/:lessonSlug` | PV | Привязано к пользователю. |
| `/feedback`, `/feedback/:id` | PR | Доска идей — гость читает, голосовать / писать — action. |
| `/drills`, `/drills/about`, `/drills/sprint*`, `/drills/:type` | PR (`/drills/about`) + PM (лобби) + PV (sprint setup/play/results) | `/drills/about` уже public (ADR-035 §7). Лобби `/drills` сейчас под `drillsEnabled`-флагом без auth-guard, но без открытого API — пустой layout. Минимально нужен PM-лендинг. |
| `/opening-trainer`, `/opening-trainer/*` | PV | Личные репертуары. Лендинг — отдельный PM-кандидат (§4.1), не обязательный. |
| `/guess`, `/guess/stats`, `/guess/history`, `/guess/sessions/:id` | PV | Гейтятся `GUESS_ENTRY_ENABLED` в проде. Когда выйдет — лендинг можно сделать PR/PM. |
| `/blind-board`, `/blind-board/*` | PV | Скоро лендинг (PM). |
| `/live/:slug` | PR | Зритель live-анализа (ADR-110). Уже public. `noindex` страница ставит сама. |
| `/messages`, `/messages/:userId`, `/friends`, `/profile`, `/settings` | PV | Личные. |
| `/admin/feature-flags`, `/admin/*` | PV (admin) | `AdminRoute`. |
| `/dev-bypass`, `/__dev/*`, `/dev/*` | DV | Только dev/staging. |

### 4.1. Кандидаты на отдельный PM-лендинг (даже если намерения не лезть в действия)

Маршруты, которые сейчас классифицированы PV или PM-неполный, но
имели бы реальную SEO-ценность при минимальном лендинге:

- `/play` — «Играй в шахматы онлайн».
- `/workshop` — «Анализ своих партий, PGN-импорт».
- `/precision` — «Тренировка точного расчёта» (ADR-048).
- `/puzzle-rush` — «Решай задачи на скорость».
- `/drills` — «Тематические тренажёры» (ADR-035).
- `/opening-trainer` — «Тренируй свои дебюты».
- `/blind-board` — «Тренируй слепую игру».
- `/guess` — «Угадай ход чемпиона» (после выхода `GUESS_ENTRY_ENABLED`).

Каждый — отдельный лендинг через **унифицированный шаблон**
`<MarketingLanding>` (см. §7.2). Контент-копирайт — отдельная задача
(content + marketing), не в scope этого ADR.

---

## 5. Модель «read vs action» по public-read маршрутам

Для каждого PR-маршрута: что видит гость, что требует auth, какие
GET-эндпоинты должен открыть backend, какие поля DTO скрывать
для анонимов, какой rate-limit.

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

---

## 6. UX-паттерн модалки логина

Единый компонент `<LoginRequiredModal>` (новый), используется во всех
PR-маршрутах для action-кнопок. До его внедрения — fallback на
`<Navigate to="/login?returnUrl=...">` через тот же
`setAuthReturnUrl`-механизм.

### 6.1. Контракт компонента

```tsx
// apps/web/src/components/auth/LoginRequiredModal.tsx
interface LoginRequiredModalProps {
  isOpen: boolean;
  onClose(): void;
  /** Что хотел сделать гость — для текста заголовка модалки. */
  actionLabel: string;          // 'Решить задачу', 'Зарегистрироваться в турнире', ...
  /** Куда вернуть после успешного логина. По умолчанию current URL. */
  returnUrl?: string;
  /** Если действие подразумевает регистрацию — заранее открыть таб register. */
  defaultTab?: 'login' | 'register';
}
```

Поведение:
1. Открывается inline (без редиректа), затемнение фона, esc/клик-вне
   закрывают.
2. Текст: «Чтобы {actionLabel}, войдите или зарегистрируйтесь».
3. Две вкладки: «Войти» и «Создать аккаунт». Внутри — формы из
   `LoginPage` / `RegisterPage` (переиспользовать компоненты-формы,
   а не страницы целиком).
4. OAuth-кнопки (Google / Facebook) — те же, что на `/login`.
5. Перед редиректом на OAuth — `setAuthReturnUrl(returnUrl)`. После
   возврата `OAuthCallbackPage` обычным путём заберёт returnUrl через
   `consumeAuthReturnUrl()`.
6. Кнопка «Подробнее на странице входа» → `/login?returnUrl=…` как
   fallback.

### 6.2. Хук `useRequireAuth`

```tsx
// apps/web/src/hooks/useRequireAuth.ts
const requireAuth = useRequireAuth();
// в обработчике:
onClick={(e) => {
  if (!requireAuth({ actionLabel: 'Решить задачу' })) return;
  // ... action logic
}}
```

`useRequireAuth` отдаёт функцию: если `user==null` — открывает модалку и
возвращает `false`; если есть — `true`. Модалка хранится в Context
(`<LoginRequiredModalProvider>` оборачивает `<MainLayout>`), один
инстанс на приложение.

### 6.3. Deep-link после логина

Реюз существующего `authReturnUrl`:
- При открытии модалки сохраняем
  `setAuthReturnUrl(location.pathname + location.search + '#' + intentHash)`.
  `intentHash` — короткий идентификатор намерения (`#act=solve-puzzle:abc`),
  страница после логина может его прочитать и сразу повторить
  action (например, открыть задачу и запустить таймер).
- После регистрации — то же поведение, плюс onboarding-сценарий
  (отдельно, не в этом ADR).

### 6.4. Что НЕ делает модалка

- Не делает passwordless / magic-link (отдельная фича).
- Не делает «продолжить как гость» — намеренно: гость уже на странице,
  модалка появилась именно потому, что нажал action.

### 6.5. Edge case: ProtectedRoute остаётся для прямой ссылки

Если гость пришёл по прямой ссылке на чисто-private маршрут
(`/settings`, `/messages`, `/profile`) — `ProtectedRoute` продолжает
редиректить на `/login`. Модалка нужна только на PR-маршрутах для
action-кнопок. Это сохраняет существующий контракт `returnUrl`.

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

Подробные тексты — content + chess-expert (KS-5 декомпозиции, теперь
расширенный).

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

### Волна 1 — открыть PR-витрины + поднять prerender-сервис

Параллельные потоки:

1. **`/broadcasts`, `/tournaments`, `/players`, `/feedback`, `/lectures`**
   — снять `ProtectedRoute` (frontend, KS-4119), открыть GET-эндпоинты
   с `OptionalJwtGuard` (backend, KS-4118). Витрина списка работает
   через build-time prerender (skeleton + sitemap).
2. **Исправить `/features`** (KS-4119 п.2). Отдельный компонент от `/`.
3. **`apps/prerender-service`** — поднять заготовку сервиса (§7.3): SQS,
   ECS task с Playwright, S3 bucket, CloudFront маппинг §7.3.4. Без
   реальных триггеров — только инфраструктура и smoke-test на одной
   ручной задаче.

### Волна 2 — динамический prerender по приоритету сущностей

4. **Lectures + Coaches** (низкий объём, on-demand-only) — backend
   mutation hooks (§7.3.7) на `LectureService.publish` /
   `CoachService.updateProfile`. Sitemap-генератор для двух сущностей.
   Per-route метатеги + JSON-LD. Это даёт первое индексируемое тело
   карточек с минимальным риском.
5. **Tournaments** (десятки, cron 30 мин + on-demand) — то же самое для
   `ArenaService.finish` + cron-фид.
6. **Broadcasts** (тяжелее — live-обновления, on-demand при
   `finishRound`, cron 15 мин для активных) — broadcast-worker
   (ADR-021) шлёт enqueue, prerender-service слушает.

### Волна 3 — PM-лендинги по шаблону

7. **`/play`** — лендинг «играй онлайн».
8. **`/puzzle-rush`** — лендинг режима.
9. **`/precision`** — лендинг «тренируй точный расчёт».
10. **`/workshop`** — лендинг «анализ партий».

### Волна 4 — top-N policy для players и archive

11. **Players top-1000** — cron + sitemap. Sitemap включает только
    top-1000; остальные `/player/:u` отдают skeleton без `noindex`
    (Google WRS их обработает, Яндекс — нет, это намеренно).
12. **Archive games policy** (avgElo ≥ 2400 или TWIC top-1000) —
    `ArchiveImporterService.afterImport` hook. **Перед началом —
    сверка policy с chess-expert и marketing** на тему SEO-объёма.
13. **Archive players top-1000** — аналогично.

### Волна 5 — расширение PR и остальные PM

14. **`/lobby`** — публичный список открытых вызовов (требует backend
    эндпоинта `GET /lobby/open-challenges` + публичного DTO).
15. **`/lessons`, `/lessons/discover`** — открыть каталог курсов для
    гостя (зависит от ADR-026 / ADR-054, сверка с chess-expert и
    content).
16. **`/drills`**, **`/opening-trainer`**, **`/blind-board`**,
    **`/guess`** (когда выйдет под флагом). По одному лендингу через
    `<MarketingLanding>`.

### Волна 6 — динамический og:image и top-N broadcast games

17. **`apps/og-image-service`** (§7.5 (c)) — Lambda, генерация PNG
    превью для broadcast / player / lecture / tournament.
18. **Top-N broadcast games** — по rule (avgElo, GM-вес) per-game
    карточки `/broadcasts/:tid/:rid/:gid` с превью текущей позиции.

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

| # | Тикет | Что | Исполнитель | Размер | Зависит от |
|---|-------|-----|-------------|--------|------------|
| 1 | KS-4118 (rewrite) | Backend: открыть `GET /broadcasts*`, `GET /arena*`, `GET /players*`, `GET /coaches/*`, `GET /feedback*`, `GET /lectures*` через `OptionalJwtGuard`; `@nestjs/throttler` 60 req/min на IP для гостя; скрыть приватные поля DTO | backend | M | этот ADR |
| 2 | KS-4119 (rewrite) | Frontend: снять `ProtectedRoute` с витрин; рендер для гостя; починить `/features` | frontend | M | 1 |
| 3 | KS-новый | Frontend: `<LoginRequiredModal>` + `useRequireAuth` + `<LoginRequiredModalProvider>` | frontend | M | этот ADR |
| 4 | KS-новый | Frontend: шаблон `<MarketingLanding>` + переводы каркаса | frontend + content | M | этот ADR |
| 5 | KS-новый | Контент: тексты `/features`, `/play`, `/puzzle-rush`, `/precision`, `/workshop` (h1, description, sections, og:image) | content + marketing | L | 4 |
| 6 | KS-новый | Frontend: внедрить `useRequireAuth` в action-кнопки витрин (`/puzzles`, `/broadcasts/:id`, `/tournaments/:id`, `/players/:u`, `/feedback`) | frontend | M | 3 |
| 7 | KS-новый | Frontend: SEO-метатеги per-route + JSON-LD через `react-helmet-async`; по странице на PR/PM маршрут | frontend + content | L | 1, 2 |
| **DYNAMIC PRERENDER (новый блок, KS-4121)** | | | | | |
| 8 | KS-новый | DevOps: SQS `kingside-prerender-tasks`, S3 bucket `kingside-prerender-store`, IAM-роли, CloudFront Function маппинга путей §7.3.4 | devops | M | 1 |
| 9 | KS-новый | Backend: новый воркспейс `apps/prerender-service` (ECS Fargate task, Playwright headless Chromium), слушает SQS, рендерит маршруты, кладёт HTML в S3 (§7.3.3, §7.3.6) | backend + devops | L | 8 |
| 10 | KS-новый | Shared: `packages/shared/prerender-client.ts` (§7.3.7) — обёртка `SQS.sendMessage` с типизацией `PrerenderTask` | backend | S | 8 |
| 11 | KS-новый | Backend: интеграция mutation-hooks для on-demand prerender — `CoachService.updateProfile`, `LectureService.publish`/`update`, `ArenaService.finish`, `ArchiveImporterService.afterImport`; broadcast-worker enqueue на `finishRound` | backend | M | 9, 10 |
| 12 | KS-новый | DevOps: EventBridge schedule'ы — `prerender-broadcasts-active` (15 мин), `prerender-tournaments-active` (30 мин), `prerender-lectures-list` (30 мин), `prerender-players-top1000` (24 ч), `prerender-archive-list` (24 ч), per-entity safety-net (24 ч) | devops | M | 9 |
| 13 | KS-новый | Backend: policy-фильтры (§7.4) для players (top-1000 по сумме рейтингов) и archive (avgElo ≥ 2400 / TWIC top-1000) — сверка с chess-expert и marketing | backend + chess-expert + marketing | M | 9 |
| 14 | KS-новый | Backend: расширение `react-helmet-async` метатегами + JSON-LD (`SportsEvent`, `Person`, `Course`, `Article`) на каждой PR-карточке (§7.6) | frontend + content | L | 7, 9 |
| 15 | KS-новый | Backend: per-entity sitemap'ы (`sitemap-broadcasts.xml`, `sitemap-coaches.xml`, …) + sitemap-index (§7.10) | backend | M | 11 |
| 16 | KS-новый | Frontend: SEO-content для PR-карточек (broadcast title format «{tournament} — {round}», player «{u} — {rating}», coach «{name} — chess coach», lecture «{title} — by {coach}», archive game «{white} vs {black} ({result})») | content + chess-expert | L | 14 |
| 17 | KS-новый | DevOps: `apps/og-image-service` (Lambda + node-canvas) — динамические og:image превью для broadcast/player/lecture/tournament (§7.5 (c)). Можно отложить до волны 6 — статические per-section og:image на старте | devops + backend | L | 9 |
| **СТАРЫЙ БЛОК (продолжение)** | | | | | |
| 18 | KS-новый | Backend: открыть `GET /lobby/open-challenges` (волна 5) | backend | S | 1 |
| 19 | KS-новый | Backend + frontend: открыть `/lessons`, `/lessons/discover` каталоги гостю (волна 5, требует сверки с chess-expert) | backend + frontend | M | 1 |
| 20 | KS-новый | Frontend: обновить `PUBLIC_ROUTES` реестр (флаг `dynamic: true` для шаблонных путей) | frontend | XS | 4 |
| 21 | KS-новый | Поднять статус ADR-128 Proposed → Accepted после волны 2, обновить ADR фактами замеров SEO (Yandex Webmaster, GSC) | architect | S | 1–14 |

---

## 11. Открытые вопросы

> **Закрыто ревизией 2026-06-14 (KS-4121)**: бывшие §11.1 (где брать
> данные для prerender) и §11.4 (SSR для динамических сегментов)
> закрыты §7.2–§7.4 новой редакции (per-entity cron + on-demand +
> CloudFront mapping без User-Agent sniffing). Нумерация сохранена для
> ссылочной целостности — пункты 11.1/11.4 ниже помечены как resolved.

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
- сверка с **chess-expert + content** на тему, какие курсы и какой
  free-preview подходят для индексации.

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
marketing + chess-expert + пользователем**:
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

### 11.12. Где лежит HTML-снапшот: одна S3-папка vs per-domain (новый, KS-4121)

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
  (rewrite), KS-4119 (rewrite), KS-новые по §10 (включая 14 тикетов
  динамического prerender от KS-4121).
- Не пишет тексты лендингов и метатегов (KS-5, KS-16).
- Не дизайнит модалку логина / лендинги в Figma.
- Не выбирает финальные значения policy top-N для players и archive —
  это §11.8, требует сверки с marketing/chess-expert.
- Не меняет policy admin-маршрутов, dev-bypass, OAuth-flow.
- Не вводит passwordless / magic-link / SSO с третьими сторонами.
- Не пересматривает `noindex` для `/analysis/public/:id`, `/live/:slug`,
  `/lectures/:id/replay`.
- Не пересматривает деплой-pipeline (ADR-127). Если §11.12 решится в
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
