# ADR-128 — Политика публичных маршрутов и модель «гость читает / логин для действия»

- Статус: **Proposed** (2026-06-14)
- Задача: KS-4120
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

### 7.1. Что меняется по prerender

После KS-4119 (+ §10) prerender начнёт снимать **реальный read-контент**
на PR-маршрутах. Текущий мок `/api/**` → пустой 200 этого не даст —
требуется либо:

- (a) **Снять моки на public-GET'ах**: prerender-скрипт делает реальные
  запросы к prod-API (или к staging) для `GET /puzzles`, `GET /broadcasts`
  и т. д., — но билд требует доступа к сетевому API. Это удлиняет
  build и привязывает frontend-build к доступности API.

- (b) **Фиксированный snapshot контента**: prerender использует SSR-
  снапшот, который backend генерирует периодически и кладёт в S3 (типа
  `s3://kingside-prerender-data/broadcasts.json`); prerender-скрипт его
  тянет вместо мока. Build не зависит от runtime API; данные обновляются
  не на каждый деплой, а по расписанию.

- (c) **Гибрид**: prerender отдаёт «каркас» (h1, описание, layout),
  данные SPA подтягивает в браузере. Это сейчас работает для `/puzzles`
  — prerender видит фильтры и h1, но не сам список (тот рендерится на
  клиенте). Для SEO достаточно: бот видит h1, description, og:image,
  внутренние ссылки на детали.

**Рекомендация архитектора: вариант (c) для MVP.** (a) и (b) — отдельные
задачи, если (c) не даёт нужной глубины индексации после двух недель
наблюдения в Yandex Webmaster / Google Search Console. Это решает
содержание SEO-snapshot'а: каркас + h1 + meta — на каждой PR-странице
руками, без зависимости от runtime API.

### 7.2. Унифицированный `<MarketingLanding>` для PM

```tsx
interface MarketingLandingProps {
  i18nKey: string;           // ключ перевода: 'landing.play', 'landing.precision', ...
  heroImage: string;         // путь к og-картинке
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
конфиг для `<MarketingLanding>` + переводы в `i18n` (en + ru +
будущие).

Дублирование 5-7 одинаковых страниц-обёрток оправдано — это не
дорого, контент-копирайт всё равно индивидуальный, шаблон даёт SEO-
консистентность (одинаковая структура h1/h2/og, одинаковая loading-
производительность).

### 7.3. Метатеги на каждой PR/PM странице

Per-route компоненты ставят `<title>`, `<meta description>`,
`<meta property="og:*">`, `<link rel="canonical">` через
`react-helmet-async` (если уже в зависимостях; если нет — обсудить
выбор библиотеки отдельной задачей). Без этого prerender отдаёт
общий title «Kingside», что обесценивает работу.

Содержание метатегов — отдельный контент-тикет. ADR фиксирует
**требование**: каждый PR/PM маршрут обязан иметь свой title +
description + canonical перед открытием в prod.

### 7.4. `/lectures`, `/coach/:username`, `/player/:username`,
`/broadcasts/:tid/:rid/:gid` — динамический prerender?

prerender сейчас снимает **только статические пути** из
`PUBLIC_ROUTES`. Динамические сегменты (`:id`, `:username`) сейчас не
рендерятся.

Решение для MVP: **не пререндерим динамические сегменты вообще** —
для них работает SPA-fallback на root index.html, который CloudFront
отдаёт. Бот, который перешёл по ссылке на `/coach/anatoly`, увидит
такой же пустой `#root` (либо `loading…`), что и сейчас.

Это **известный пробел** — открытие динамических сегментов SEO-
ботам нужно решать через SSR или server-side prerender per request
(CloudFront Function + Lambda + headless Chrome). Это вне scope
ADR-128 — отдельный архитектурный разговор (см. §11.4).

### 7.5. `noindex` для public-mixed без contenta

`/analysis/public/:id` уже ставит `noindex` через useEffect
(подтверждено ADR-110, аналогично `LiveAnalysisViewerPage`). Этот
паттерн остаётся: страницы, которые публичны по факту, но не
индексируемы (приватные шаренные ссылки), сами выставляют `noindex` в
runtime.

prerender этих маршрутов не делает (не в `PUBLIC_ROUTES` реестре) —
сам путь bot'у попадает только по shared-ссылке.

### 7.6. sitemap.xml

`PUBLIC_ROUTES` уже несёт `priority` и `changefreq` для sitemap.xml
(KS-4116 — отдельный тикет на автогенерацию). После применения этого
ADR реестр расширяется на новые PM-лендинги:

```
/, /features, /play, /lobby, /tournaments, /puzzles, /puzzle-rush,
/analysis, /workshop, /broadcasts, /players, /lectures, /feedback,
/login, /precision, /drills, /opening-trainer, /blind-board,
/games/live, /archive, /lessons (если lessonsEnabled), /lessons/discover
```

(`/daily` — алиас, в sitemap не вносится.)

---

## 8. Приоритизация

Принцип: первым делать то, где (наибольший SEO-объём) × (минимум
работы) × (нет зависимости от других тикетов).

### Волна 1 — открыть PR без значимого backend-расширения

Эти маршруты уже частично работают для гостя; нужно только снять
`ProtectedRoute` и/или открыть существующие GET'ы:

1. **`/broadcasts`, `/tournaments`, `/players`** — основной вклад в
   KS-4118 + KS-4119, ради этого ADR и пишется. Эффект: индексация
   витрин турниров и трансляций, превью в мессенджерах.
2. **Исправить `/features`** (KS-4119 п.2). Отделить компонент от
   главной, сделать собственный лендинг разделов.
3. **Подтвердить и зафиксировать `/feedback`, `/games/live`, `/archive`,
   `/live/:slug`, `/lectures`** как PR (они уже работают, нужен
   аудит и пометка в реестре).

### Волна 2 — PM-лендинги по шаблону

4. **`/play`** — лендинг «играй онлайн». Высокий поисковый объём
   (запросы «играть в шахматы онлайн»).
5. **`/puzzle-rush`** — лендинг режима.
6. **`/precision`** — лендинг «тренируй точный расчёт».
7. **`/workshop`** — лендинг «анализ партий».

### Волна 3 — расширение PR

8. **`/lobby`** — публичный список открытых вызовов (требует backend
   эндпоинта + публичного DTO).
9. **`/lessons`, `/lessons/discover`** — открыть каталог курсов для
   гостя (зависит от ADR-026 / ADR-054, нужна сверка с chess-expert и
   content).
10. **`/coach/:username`, `/player/:username`, `/lectures/:id`** —
    динамический prerender (см. §11.4) или server-side fallback. Это
    отдельная архитектурная задача.

### Волна 4 — остальные PM

11. **`/drills`**, **`/opening-trainer`**, **`/blind-board`**,
    **`/guess`** (когда выйдет под флагом). По одному лендингу на
    раздел, через единый шаблон.

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
| 1 | KS-4118 (rewrite) | Backend: открыть `GET /broadcasts*`, `GET /arena*` (читалки), `GET /players*`, `GET /coaches/*`, `GET /feedback*` через `OptionalJwtGuard`; ввести `@nestjs/throttler` с лимитом 60 req/min на IP для гостя; скрыть приватные поля DTO для анонимов | backend | M | этот ADR |
| 2 | KS-4119 (rewrite) | Frontend: снять `ProtectedRoute` с `/broadcasts*`, `/tournaments*`, `/players*`, `/player/:username`, `/coach/:username`, `/feedback*`; рендер для гостя; починить `/features` (отдельный компонент от `/`) | frontend | M | 1 |
| 3 | KS-новый | Frontend: компонент `<LoginRequiredModal>` + хук `useRequireAuth` + Context `<LoginRequiredModalProvider>` | frontend | M | этот ADR |
| 4 | KS-новый | Frontend: компонент `<MarketingLanding>` (шаблон PM-лендингов) + переводы каркаса | frontend + content | M | этот ADR |
| 5 | KS-новый | Контент: тексты `/features`, `/play`, `/puzzle-rush`, `/precision`, `/workshop` (h1, description, sections, og:image) | content + marketing | L | 4 |
| 6 | KS-новый | Frontend: использовать `useRequireAuth` для action-кнопок на `/puzzles`, `/broadcasts/:id` (чат), `/tournaments/:id` (register), `/players/:u` (вызов/сообщение), `/feedback` (голос/коммент) | frontend | M | 3 |
| 7 | KS-новый | Frontend: SEO-метатеги per-route (title/description/og/canonical) через `react-helmet-async` (или эквивалент); по странице на PR/PM маршрут | frontend + content | L | 1, 2 |
| 8 | KS-новый | Backend: открыть `GET /lobby/open-challenges` (публичный DTO, без email/userId если приватно) для волны 3 шага 8 | backend | S | 1 |
| 9 | KS-новый | Backend + frontend: открыть `/lessons`, `/lessons/discover` каталоги гостю (зависит от ADR-026 / ADR-054, требует сверки с chess-expert) | backend + frontend | M | 1 |
| 10 | KS-новый | Архитектурный research: SSR / server-side prerender для динамических сегментов (`/coach/:u`, `/player/:u`, `/lectures/:id`, `/broadcasts/:tid/:rid/:gid`) — см. §11.4 | architect | S | этот ADR (после волн 1–2) |
| 11 | KS-новый | Обновить `PUBLIC_ROUTES` реестр под расширения волн 1–4 | frontend | XS | 4 |
| 12 | KS-новый | Поднять статус ADR-128 Proposed → Accepted после волны 1, обновить ADR фактами замеров SEO (Yandex Webmaster, GSC) | architect | S | 1–7 |

---

## 11. Открытые вопросы

### 11.1. Где брать данные для prerender PR-маршрутов

Варианты §7.1: (a) live-API, (b) S3 snapshot, (c) skeleton + client-
hydration. Архитектор рекомендует (c) для MVP. Финальное решение
после первого замера в Yandex Webmaster — отдельная развилка с
пользователем (что важнее: индексация конкретных позиций / партий /
игроков, или общей структуры сайта).

### 11.2. `/lessons` каталог для гостя

ADR-026 / ADR-054 описывают user-courses и system-courses. Каталог
системных курсов потенциально open, но gate `lessonsEnabled` сейчас
держит весь namespace под флагом. Открытие для гостя требует:
- backend: открыть `GET /courses/system?published=true` для анонимов;
- frontend: компонент `<DiscoverCoursesPage>` (уже без auth) + лендинг
  раздела `/lessons` для гостя;
- сверка с **chess-expert + content** на тему, какие курсы и какой
  free-preview подходят для индексации.

Не делаем в волне 1 — слишком много продуктовых вопросов.

### 11.3. Onboarding после регистрации из модалки

После успешной регистрации через `<LoginRequiredModal>` пользователь
оказывается в середине сценария (например, на `/puzzles` с
открытой задачей). Нужно ли запускать минимальный onboarding (выбор
никнейма, аватара, языка) inline через тот же модал-стек? Или
полноценный onboarding пропустить, отложить на отдельный экран?

Решение — отдельная задача с пользователем (см. KS-новый). Базовый
вариант: после регистрации сразу позволяем сделать action, а
onboarding-баннер показываем в `<MainLayout>` до его прохождения.

### 11.4. SSR / server-side prerender для динамических сегментов (§7.4)

Текущий build-time prerender статичен. Для индексации профилей,
партий трансляций, лекций нужен **server-side** механизм:
- (i) **Server-side prerender on demand**: CloudFront Function проверяет
  User-Agent; если бот — Lambda@Edge запускает headless Chrome → отдаёт
  HTML; авторизованным/гостям SPA как сейчас.
- (ii) **Полноценный SSR** через `vite-ssg` / Next.js — это перепи-
  сывание приложения, по-хорошему отдельный ADR.
- (iii) **Статический prerender списка топ-N** (топ-100 коучей, топ-1000
  игроков по рейтингу) с пересборкой раз в N часов. Дёшево, но
  покрывает только head ассортимента.

Архитектор предлагает (iii) как минимум + research'нуть (i) как
полноценное решение. Это KS-10 в декомпозиции.

### 11.5. Чьи метатеги выигрывают: shell `index.html` vs route-specific

Сейчас `apps/web/index.html` содержит дефолтный `<title>` и
`<meta description>`. Prerender перезаписывает `<head>` целиком —
значит, ставить per-route метатеги нужно через React (внутри
компонента страницы), чтобы они доехали до prerender. Альтернатива
— параметризовать `index.html` через шаблон Vite и подменять title
на этапе writeHtml в prerender-скрипте.

Архитектор предлагает первый путь (через `react-helmet-async`) —
он работает и в runtime SPA, и в prerender. Финальное решение — за
frontend в KS-7 декомпозиции.

### 11.6. Rate-limit гостя vs DDoS

60 req/min на IP — это защита от случайного бота, не от DDoS.
Полноценная DDoS-защита — CloudFront WAF (если ещё не настроен) или
Cloudflare. Это вне scope ADR-128 (это деpops + security).

### 11.7. Действия, для которых модалка не подходит

WebSocket-handshake (вступление в live-партию, подписка на чат
трансляции) — гость подключается без JWT и не получает разрешение на
SUB-канал. На фронте у нас сейчас даже нет ws-канала, который попробует
переподписаться после логина в той же сессии. Решение: после успешного
логина из `<LoginRequiredModal>` форсируем `socket.io disconnect →
reconnect` с новым JWT в handshake. Реализация — KS-3 (компонент
модалки) + KS-6 (применение).

---

## 12. Что НЕ делает этот ADR

- Не пишет код (frontend / backend). Реализация — KS-4118 (rewrite),
  KS-4119 (rewrite) и KS-новые тикеты по §10.
- Не пишет тексты лендингов и метатегов (отдельный content + marketing
  тикет KS-5).
- Не дизайнит модалку логина / лендинги в Figma — задаёт только
  контракт компонентов.
- Не решает задачу SSR для динамических сегментов (§11.4 — отдельный
  research-тикет).
- Не меняет policy admin-маршрутов, dev-bypass, OAuth-flow.
- Не вводит passwordless / magic-link / SSO с третьими сторонами.
- Не пересматривает `noindex` для `/analysis/public/:id`, `/live/:slug`,
  `/lectures/:id/replay` — текущее runtime-поведение остаётся.

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
