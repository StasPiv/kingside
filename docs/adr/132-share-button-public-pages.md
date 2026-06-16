# ADR-132 — Кнопка «Поделиться» на публичных страницах

- Статус: **Proposed** (2026-06-16)
- Задача: KS-4261
- Связанные ADR / задачи:
  - ADR-128 — публичные роуты и гостевой доступ (контекст
    публичности). §17 — динамический og:image (зависимость, не в
    scope).
  - ADR-051 §3 — существующий `ShareAnalysisButton` (analysis-страница,
    специфичный share с toggle isPublic).
  - ADR-035 §11 — `useShareSprintResult` (sprint result, с canvas
    generated PNG).
  - KS-4253 — `analysis-public` prerender hooks (образец).
  - KS-4214 — `lecture` hooks.
  - KS-4205 — `broadcast` hooks.
- Авторы: architect.

---

## 1. Контекст и цели

Пользователь хочет компактную узнаваемую кнопку «Поделиться» на всех
публичных страницах Kingside. Поведение:
- Web Share API на мобильных — нативный share-sheet.
- Запасной вариант на desktop без поддержки — popup со ссылкой и
  «Скопировать ссылку».

Индексация уже работает через mutation hooks (KS-4253, KS-4214,
KS-4205 и т.д.) — prerender обновляется при изменении контента, share
**НЕ должен** дёргать prerender сам. Кнопка — это UI-фасад, не
триггер.

Координатор просит ADR с декомпозицией по зонам ответственности
(frontend / backend / shared, без смешения).

---

## 2. Инвентаризация публичных страниц

Прошёл по `apps/web/src/App.tsx` (~30 роутов без `ProtectedRoute`).
Отбраковал служебные (`/__dev/*`, `/oauth/callback`, redirect'ы) и
лендинги без shareable-сущности (`/terms`, `/credits`, `/features`).
Получилось 5 категорий публичных контент-страниц с очевидным
share-смыслом:

### 2.1. Профильные страницы (single entity)

| Маршрут | Компонент | Prerender kind | Hook backend | title для `share()` |
|---------|-----------|----------------|--------------|---------------------|
| `/coach/:username` | `CoachProfilePage` | `coach` | `UserService.{setUsername, updateSettings, updateExternalAccounts}` ✅ | имя тренера + «тренер на Kingside» |
| `/player/:username` | `PlayerProfilePage` | `player` | **🔴 ПРОБЕЛ** (см. §3) | username + рейтинг |
| `/archive/players/:slug` | `ArchivePlayerProfilePage` | `archive-player` | **🔴 ПРОБЕЛ** (см. §3) | имя игрока (например, Magnus Carlsen) |
| `/lectures/:id` | `LectureLandingPage` | `lecture` | `LecturesService.{create, start, update, ...}` ✅ | title лекции + автор |
| `/lectures/:id/live` | `LectureLivePage` | `lecture` (тот же) | то же | то же + «идёт live» |
| `/lectures/:id/replay` | `LectureReplayPage` | `lecture` (тот же) | то же | то же + «запись» |
| `/tournaments/:id`, `/arena/:id` | `TournamentLobbyPage` | `tournament` | `ArenaService.finishTournamentEarly` + `RoundManagerService.finalizeRound` ⚠ только finish | название турнира |
| `/broadcasts/:tournamentId` | `BroadcastTournamentPage` | `broadcast` (только tid) | `BroadcastSyncService` ✅ | название турнира |
| `/broadcasts/:tournamentId/:roundId` | `BroadcastRoundPage` | `broadcast` (tid+rid) | то же ✅ | название + раунд |
| `/broadcasts/:tournamentId/:roundId/:gameId` | `BroadcastGamePage` | `broadcast` (tid+rid+gid) | то же ✅ | имена игроков + результат |
| `/archive/games/:id` | `ArchiveGamePage` | `archive-game` | `TwicImporter` (под env-флагом, off по умолчанию) ⚠ | имена игроков + событие |
| `/lessons/:courseSlug` | `CoursePage` | **нет** | — | название курса |
| `/lessons/:courseSlug/:lessonSlug` | `LessonPage` | **нет** | — | название урока |
| `/analysis/:id` (публичный) | `AnalysisPage` | `analysis-public` | `AnalysisService.{share, update, ...}` ✅ | заголовок + результат партии |
| `/games/:id/watch` | `WatchGamePage` | **нет** (live) | — (live-объект, prerender невозможен) | имена игроков + результат |
| `/puzzle/:id` | `PuzzlePage` | **нет** | — | rating задачи + тема |

### 2.2. Листинги (множественные)

| Маршрут | Компонент | Prerender kind | Hook backend | title |
|---------|-----------|----------------|--------------|-------|
| `/lectures` | `LecturesListPage` | `list` `/lectures` | `LecturesService` ✅ | «Лекции на Kingside» |
| `/tournaments` | `TournamentsPage` | `list` `/tournaments` | hook ⚠ только при finish, см. §3 | «Турниры» |
| `/broadcasts` | `BroadcastsPage` | `list` `/broadcasts` | `BroadcastSyncService` ✅ | «Live-трансляции» |
| `/archive` | `ArchiveGamesPage` | **нет** | — | «Архив партий» |
| `/players` | `PlayersPage` | **нет** | — | «Игроки» |
| `/puzzle-rush/leaderboard` | `PuzzleRushLeaderboardPage` | **нет** | — | «Лидерборд Puzzle Rush» |
| `/drills/sprint/leaderboard` | `DrillLeaderboardPage` | **нет** | — | «Лидерборд тренажёров» |

### 2.3. Что НЕ кладём кнопку

- Статичные лендинги (`/features`, `/terms`, `/credits`, `/lobby`,
  `/docs/user-courses`) — поделиться можно, но смысл слабый; решение
  пользователя на уровне дизайна, по умолчанию НЕ ставим.
- `/login`, `/register` — guest-маршруты, не для share.
- `/feedback`, `/feedback/:id` — feedback-board, технически
  публичный, но share-смысл слабый; кнопка опциональна.
- Игровые и тренировочные маршруты под `ProtectedRoute` — закрыты для
  гостей, share не имеет смысла (получатель не увидит без логина).

---

## 3. Состояние mutation hooks (пробелы)

Прошёл по всем `enqueueFireAndForget` в `apps/api`, `apps/broadcast-service`,
`apps/archive-service`. Сводная таблица:

| Kind | Источник hook'а | Покрытие | Замечание |
|------|----------------|----------|-----------|
| `lecture` | `LecturesService.create/start/update/access/...` | ✅ полное | Сделано в KS-4214. |
| `coach` | `UserService.{setUsername, updateSettings, updateExternalAccounts}` | ✅ полное | По ADR-128 рекомендации. |
| `analysis-public` | `AnalysisService.{share, update}` | ✅ полное | KS-4253. |
| `broadcast` | `BroadcastSyncService` + `BroadcastWatchdogService` | ✅ полное | KS-4205. |
| `tournament` | `ArenaService.finishTournamentEarly`, `RoundManagerService.finalizeRound` | ⚠ частичное | Hook **только при завершении**. При `create`/`update` (изменение названия, описания, формата турнира до старта) — hook отсутствует. Пробел. |
| `archive-game` | `TwicImporter` | ⚠ под env-флагом `ARCHIVE_PRERENDER_ENABLED` (off по умолчанию) | Решение из ADR-128 §10 #11 + KS-4205c: до policy-фильтра не включать. Это известное состояние. |
| `player` | **только в `admin/reindex-all`** | 🔴 ПРОБЕЛ | Никакой mutation hook на изменение профиля игрока (рейтинг после игры, username, аватар). `/player/:username` устаревает в prerender. |
| `archive-player` | **нет** | 🔴 ПРОБЕЛ | Никакой hook ни в archive-service, ни в api. `/archive/players/:slug` либо не индексируется вовсе, либо устаревает. |

### 3.1. Пробелы (не для исправления в этой задаче — отдельный backend)

1. **`player` mutation hook** — добавить в `RatingService.updateRatingsAfterGame`
   (после игры рейтинг изменился → перерендер) и в `UserService.setUsername`
   (для player'а тоже, не только coach). Дёргать `{kind:'player',
   username}`. Если игрок ещё не «coach» — отдельная сущность.
2. **`archive-player` mutation hook** — после `archiveGame.create` в
   `TwicImporter` (когда добавляется партия с участием игрока, профиль
   которого менялся). Сложнее: надо понимать `slug` каждого игрока и
   не дёргать на каждую партию. Возможно: батчинг через
   `archive-player-events-backfill` (раз в день).
3. **`tournament` hook на `create`/`update`** — добавить в
   `ArenaService.{create, ?}`. Пользователь создал турнир — он сразу
   виден в `/tournaments`, prerender должен обновиться.

Эти пробелы **не блокируют кнопку «Поделиться»** — share-button
работает независимо. Но без них пользователь может «поделиться»
устаревшим prerender (например, поделиться `/player/magnus`, а там
старый рейтинг). Влияет на UX. Решение по приоритету пробелов — за
координатором/пользователем, отдельные задачи.

---

## 4. Архитектура UI-компонента

### 4.1. Существующие паттерны

| Компонент | Использование | Заметки |
|-----------|---------------|---------|
| `ShareAnalysisButton` | `/analysis/:id` (KS-2666) | Специфичный popup с toggle `isPublic` + copy link. **НЕ Web Share API.** Сохраняется как есть — это не просто share, это control над publication state. |
| `useShareSprintResult` | `/drills/sprint/results` (KS-2251) | Хук с canvas-генерацией PNG 1200×630 → Web Share API с files. **Используется только sprint-result.** Сохраняется. |

Оба специфичны. Универсального `<ShareButton>` нет.

### 4.2. Целевой компонент `<ShareButton>` (новый)

Файл: `apps/web/src/components/share/ShareButton.tsx`.

```tsx
interface ShareButtonProps {
  /** Канонический URL для share. Дефолт — window.location.href + UTM. */
  url?: string;
  /** Title для `navigator.share()` — обычно из SeoHelmet.title. */
  title: string;
  /** Произвольный текст для share-sheet (опционально). */
  text?: string;
  /**
   * UTM-source для analytics. Зафиксированный список:
   * `coach-profile` / `player-profile` / `archive-player` /
   * `lecture` / `tournament` / `broadcast-tournament` /
   * `broadcast-round` / `broadcast-game` / `archive-game` /
   * `course` / `lesson` / `analysis-public` / `watch-game` /
   * `puzzle` / `lectures-list` / `tournaments-list` /
   * `broadcasts-list` / `puzzle-rush-leaderboard` /
   * `drills-sprint-leaderboard`.
   */
  source: ShareSource;
  /** Размер кнопки: 'compact' (по умолчанию) / 'full' (с подписью). */
  variant?: 'compact' | 'full';
  /** className для интеграции в layout страницы. */
  className?: string;
}
```

**Поведение:**

1. На клик: проверка `typeof navigator.share === 'function'` и
   `navigator.canShare?.({ url, title, text })`.
2. **Если поддерживается** — `navigator.share({ url, title, text })`:
   - resolve → state `shared`, analytics `share_completed`, тост
     «Поделились».
   - reject `AbortError` — пользователь закрыл share-sheet, state
     возвращается в `idle`, analytics `share_cancelled`.
   - reject другое — fallback на copy-link.
3. **Если не поддерживается или fallback** — popup с двумя действиями:
   - «Скопировать ссылку» (через `useCopyToClipboard`) → state
     `copied`, тост «Ссылка скопирована».
   - «Открыть в Twitter / Telegram / WhatsApp» (опционально, 3-4
     иконки с заранее сгенерированными intent-URL'ами). Минимально
     можно ограничить только copy-link для v1.

**UTM:** url обогащается перед отправкой:
`?utm_source=share&utm_medium=<source>&utm_campaign=share-button`
(паттерн как в `useShareSprintResult`).

**Состояния:**
- `idle` — иконка share + опциональная подпись.
- `pending` — спиннер (пока открыт нативный share-sheet или идёт
  copy).
- `success` — короткий success-тост (1.5 сек) с галочкой, возврат в
  `idle`.
- `error` — короткий error-тост, возврат в `idle`.

**Иконка:** стандартная share-иконка (arrow up out of square для
iOS-стиля, либо «three dots» Android-стиль). Конкретный SVG —
дизайнер решит, в коде — placeholder.

### 4.3. Хук `useShare` (внутренний для компонента)

`apps/web/src/hooks/useShare.ts` — инкапсулирует:
- Web Share API detection + invocation.
- UTM-обогащение URL.
- Fallback на copy-link.
- Analytics-events.

Чтобы `ShareButton` оставался тонким UI, а логика была отдельно
тестируемой. Юнит-тесты — на `useShare`, snapshot — на
`ShareButton`.

### 4.4. Размещение на страницах

**Правило:** кнопка идёт в шапке контента (рядом с заголовком),
размер `compact` (иконка + короткая подпись «Поделиться» на desktop,
только иконка на mobile).

Альтернативно — в action-bar (как у `ShareAnalysisButton`), если на
странице уже есть action-bar. Решение для конкретной страницы —
frontend на этапе F1.

### 4.5. Связь с дизайн-системой

Сейчас в проекте **нет общего `<Button>` компонента** —
`HelpButton`, `SidebarFontSizeButton`, `PrecisionStartTrainingButton`
и др. оформляются индивидуально. `<ShareButton>` следует тому же
паттерну: собственный CSS-модуль, цвета/шрифты из существующих
CSS-переменных проекта (то есть Kingside-палитра, не custom).

---

## 5. Что улучшить (рекомендации)

### 5.1. Не дёргать prerender на share

Кнопка **НЕ** должна вызывать backend для prerender'а. Индексация
автоматическая через mutations. Любой явный «принудительный
prerender» при share — антипаттерн (пользователь может щёлкать
много раз, очередь захлестнёт). Если страница устарела — это
проблема пробелов hooks (§3), не share-button.

### 5.2. Аналитика — отдельная задача

GA4 уже подключён через `apps/web/src/utils/analytics.ts` с
функцией `trackEvent(name, params)`. Использовать:
- `share_initiated` — клик по кнопке.
- `share_completed` — `navigator.share` resolved или copy успешный.
- `share_cancelled` — `AbortError`.
- `share_failed` — `navigator.share` отклонил с не-AbortError И
  fallback тоже упал.

`params` включают `source`, `url`, `method` ('native' / 'clipboard').

### 5.3. Динамический og:image (вне scope)

ADR-128 §17 описывает динамическую генерацию og:image для шеринга
(чтобы preview в Telegram/WhatsApp был не статичным). Это **отдельный
путь** — без него share работает (используется статичный og:image из
SeoHelmet), но preview будет менее привлекательным. Зависимость для
качества UX, не для функциональности.

### 5.4. Заполнение пробелов hooks — рекомендуемые приоритеты

Если пользователь решит закрывать пробелы из §3 — приоритет такой:
1. `player` (KS-?) — самый частый случай (рейтинг после каждой игры).
2. `tournament` на create/update (KS-?) — пользователь сам ждёт
   обновления prerender, когда создаёт турнир.
3. `archive-player` (KS-?) — низкий приоритет, archive обновляется
   редко (TWIC weekly).

Это **не блокирует ShareButton** — кнопка работает с устаревшим
prerender тоже (URL отдаст актуальный backend-render, просто SEO
может отставать).

---

## 6. Декомпозиция задач

Каждая задача — в зоне ответственности одного агента.

### F1 — Frontend: `<ShareButton>` + размещение на страницах

**Scope:** только `apps/web/src/components/share/*`,
`apps/web/src/hooks/useShare.ts`, изменения на страницах из §2.

**Что сделать:**
1. Создать `apps/web/src/components/share/ShareButton.tsx` по
   контракту §4.2.
2. Создать `apps/web/src/hooks/useShare.ts` (§4.3).
3. Создать `apps/web/src/components/share/ShareSource.ts` —
   тип-объединение всех source-литералов из §4.2.
4. Юнит-тесты:
   - `useShare.test.ts`: Web Share API доступен → вызов; AbortError
     → state idle; иной reject → fallback copy; нет
     `navigator.share` → fallback copy.
   - `ShareButton.test.tsx`: рендер в `compact`/`full`, состояния
     `idle`/`pending`/`success`/`error`, click-handler.
5. Разместить кнопку на страницах из §2.1 и §2.2 (16-18 страниц).
   На каждой — взять `title` из существующего `SeoHelmet`/state
   страницы, `url` оставить undefined (дефолт `location.href`),
   `source` из §4.2 ShareSource.
6. i18n: ключи `share.button` (Поделиться / Share), `share.copied`
   (Ссылка скопирована / Link copied), `share.failed` (Не получилось
   поделиться / Couldn't share). Через i18next.

**DoD:**
- `<ShareButton>` показывается на всех страницах из §2.1 и §2.2.
- На мобильном — открывает нативный share-sheet.
- На desktop — popup с copy-link.
- Юнит-тесты зелёные.
- `npm run lint` чисто.

**Не входит:**
- Backend hooks (отдельная задача B1, опциональная).
- Аналитика — отдельная задача F2.
- Дизайн иконки (берёт у дизайн-инфры или placeholder).

**Блокирует:** F2 (аналитика подключается после готовности кнопки).

### F2 — Frontend: аналитика share-event'ов (опционально, после F1)

**Scope:** только `apps/web/src/components/share/*`,
`apps/web/src/utils/analytics.ts` (или новое место).

**Что сделать:**
1. В `useShare` (созданном в F1) добавить вызовы `trackEvent` из
   `utils/analytics`:
   - `share_initiated` — на клик.
   - `share_completed` — при успехе.
   - `share_cancelled` — на `AbortError`.
   - `share_failed` — при ошибке.
2. Юнит-тесты на корректные параметры `trackEvent`.

**DoD:**
- Все 4 события эмитятся согласно §5.2.
- GA4 dashboard через 24 часа показывает события (manual check).

**Не входит:** новые источники, дашборды — отдельно.

### B1 — Backend: заполнение пробелов mutation hooks (опционально, отдельный путь)

**Scope:** только `apps/api/src/user/*`, `apps/api/src/game/rating.service.ts`,
`apps/api/src/arena/arena.service.ts`. НЕ трогает frontend.

**Это рекомендация, не обязательная задача.** Может идти параллельно
с F1/F2 или после, или вовсе не выполняться, если пользователь
решит, что устаревание prerender'а для `/player/:username` —
приемлемо. См. §3 и §5.4.

**Что сделать:**
1. `RatingService.updateRatingsAfterGame` — после успешного `update`
   в БД вызвать `prerender.enqueueFireAndForget({kind:'player',
   username: <white>})` и `{kind:'player', username: <black>}` для
   обоих игроков партии.
2. `UserService.setUsername` — добавить `{kind:'player', username}`
   ОДНОВРЕМЕННО с уже существующим `{kind:'coach', username}` (если
   пользователь и тренер, и игрок — старая страница `/player/<old>`
   тоже должна стать 404).
3. `ArenaService.create` / `ArenaService.update` (если есть) —
   добавить hook `{kind:'tournament', id}` + `{kind:'list',
   route:'/tournaments'}`.
4. Юнит-тесты на каждый новый hook.

**DoD:**
- После игры — `/player/:username` обоих игроков перерендеривается.
- После создания/обновления турнира — `/tournaments/:id` перерендеривается.
- Юнит-тесты зелёные.

**Не входит:**
- `archive-player` hook — сложнее, отдельный анализ.
- Фронт ничего не меняет.

**Блокирует:** ничего, опциональная.

### A2 — Architect: финализация ADR-132

**Scope:** только `docs/adr/132-*.md`.

**Что сделать:**
1. После F1 (минимум) — пометить ADR-132 как Accepted.
2. Если F2 и/или B1 выполнены — отметить покрытие в §5.
3. Если выявленные пробелы (§3) решено НЕ закрывать — пометить как
   осознанное решение.

**DoD:** ADR в Accepted, статус соответствует реализации.

---

## 7. Открытые вопросы

1. **Где НЕ должно быть кнопки?** §2.3 фиксирует мою рекомендацию,
   но пользователь может захотеть кнопку на `/lobby` и статических
   страницах (для виральности). Решение — в рамках F1 либо до её
   старта.
2. **Закрывать ли пробелы hooks из §3?** Влияет на UX share'а
   (получатель может увидеть устаревший prerender), но не на
   функциональность кнопки. Решение — пользователь.
3. **Динамический og:image (ADR-128 §17)** — отдельный путь.
   Стоит ли запускать в параллель с этим ADR — решение пользователя.
4. **Дополнительные share-targets в popup для desktop без Web Share API**
   (Twitter/Telegram/WhatsApp/Facebook) — расширение базового
   copy-link. Можно отложить до v2.
5. **Кнопка на `/games/:id/watch` и live-страницах** —
   prerender'а у них нет (динамический контент), но share-смысл
   есть («смотри, что я смотрю»). Кнопка работает, но без preview в
   social media. Решение — оставить копку, опираясь на runtime
   meta.

---

## 8. Не в scope

- Динамический og:image (ADR-128 §17, отдельный путь).
- Реализация share через картинку для не-leaderboard'ов (как
  `useShareSprintResult`). Сохраняем существующий хук для sprint,
  не расширяем на другие типы.
- Изменение `ShareAnalysisButton` (KS-2666 / ADR-051 §3) — он
  специфичный (toggle isPublic), оставляем как есть.
