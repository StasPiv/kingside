# Hints — workflow добавления и тестирования правил

Гайд для разработчиков и контент-команды: как **добавить новое правило контекстных подсказок** так, чтобы оно автоматически тестировалось — без ручного прохода пользователем через UI.

Архитектура — ADR-150 «Автоматизированное тестирование правил подсказок». Контракт самого правила и DSL — ADR-147 §3, ADR-148. Этот гайд — практическая инструкция «куда положить файлы, что запустить».

---

## TL;DR — 4 артефакта в одном PR

| # | Артефакт | Где | Кто пишет |
|---|----------|-----|-----------|
| 1 | Правило в БД `hints` | `POST /admin/hints` (через admin UI или curl) | content/architect |
| 2 | Backend-фикстура | `apps/api/test/hints-fixtures/<key>.ts` | backend |
| 3 | E2E-сценарий | `tools/e2e-hints/tests/<key>.spec.ts` | backend / content (Playwright) |
| 4 | Anchor (если новый) | `data-hint-anchor="<key>"` одной строкой в JSX | frontend |

Без любого из четырёх PR не мержится — см. чек-лист в `docs/dev/PULL_REQUEST_TEMPLATE.md`.

---

## 1. Поднять тестовое окружение

Изолированный compose-профиль `test-hints` (порты dev + 100). НЕ делится с разработкой — можно запускать параллельно с `npm run dev`.

```bash
# Поднять (идемпотентно): postgres-test:5433, redis-test:6380,
# api-test:3101, game-service-test:3102, web-test:5174
bash scripts/test-hints-up.sh

# Снести с volumes (полная очистка БД и Redis)
bash scripts/test-hints-down.sh
```

Под капотом — `docker compose -p kingside-test-hints -f scripts/docker-compose.test-hints.yml`. ENV в этих контейнерах:

- `HINTS_TEST_MODE=1` — подключает `HintsTestModule` с тестовыми endpoint'ами (`/test/seed/events`, `/test/clean-actor`, `/test/refresh-matviews`, `/test/check-for`, `/test/evaluate-rule`). На проде модуль не подключается, endpoint'ы дают 404.
- `HINTS_DEFAULTS_OVERRIDE_JSON='{"hints.global_throttle_seconds":0,"hints.session_max_shows":1000,"hints.enabled":true}'` — обнуляет глобальные лимиты.
- `INTERNAL_EVENTS_SECRET=...` — тот же, что в api-test и game-service-test; helper'ы Playwright прикладывают его в `X-Internal-Events-Secret`.
- `ANALYTICS_CONSENT_BYPASS=1` под `NODE_ENV=test` — для test-actor'ов consent всегда `true`, без явного семинар в БД.

После старта проверь:

```bash
curl http://localhost:3101/health           # api-test
curl http://localhost:3102/health           # game-service-test
curl http://localhost:5174                  # web-test (vite)
```

---

## 2. Завести правило в БД

Один HTTP POST под admin-токеном (например, через curl, Postman или админ-UI). Шаблон в `tools/e2e-hints/README.md` §Покрытие правил — пример для `puzzle-comeback-after-week`:

```json
{
  "key": "puzzle-comeback-after-week",
  "i18n": {
    "ru": { "title": "...", "body": "...", "ctaLabel": "К пазлам" },
    "en": { "title": "...", "body": "...", "ctaLabel": "Open puzzles" }
  },
  "cta": { "href": "/puzzles" },
  "anchor": "home-puzzles-tile",
  "placement": "right",
  "priority": 40,
  "enabled": true,
  "acceptedBy": ["puzzle_start"],
  "targetActorTypes": ["user"],
  "cooldownSec": 172800,
  "ttlSec": 0,
  "maxShows": 4,
  "rule": {
    "all": [
      { "actorType": { "equals": "user" } },
      { "any": [
        { "page": { "matches": "/play" } },
        { "page": { "matches": "/play/*" } }
      ]},
      { "timeSince": { "event": "puzzle_start", "gtDays": 7 } }
    ]
  }
}
```

Контракт полей — `apps/api/src/hints/admin/admin-hint.dto.ts`. DSL — `apps/api/src/hints/hints-dsl.evaluator.ts` (операторы `all`/`any`/`not`/`page`/`actorType`/`count`/`exists`/`timeSince`).

> **Anchor — свободная строка.** Если узла с `data-hint-anchor="<key>"` ещё нет в JSX, добавь его одной строкой в соответствующий компонент `apps/web/src/...`. Никаких правок `packages/shared` (ADR-148 §6.1).

---

## 3. Backend-фикстура (юнит)

Файл — `apps/api/test/hints-fixtures/<key>.ts`. Экспортирует `RuleFixture` по умолчанию.

```ts
// apps/api/test/hints-fixtures/puzzle-comeback-after-week.ts
import { daysAgo, hoursAgo, type RuleFixture } from './types';

const fixture: RuleFixture = {
  key: 'puzzle-comeback-after-week',
  actorType: 'user',
  matches: {
    page: '/play',
    // последний puzzle_start 10 дней назад > gtDays:7 → правило срабатывает
    events: [{ type: 'puzzle_start', created_at: daysAgo(10) }],
  },
  noMatch: {
    page: '/play',
    // недавний puzzle_start (3ч назад) → timeSince false
    events: [{ type: 'puzzle_start', created_at: hoursAgo(3) }],
  },
};
export default fixture;
```

И зарегистрировать в `apps/api/test/hints-fixtures/index.ts` (добавить строку `import puzzleComebackAfterWeek from './puzzle-comeback-after-week'` + экспорт в массиве `ALL_FIXTURES`).

Юнит-suite `apps/api/test/hints-rules.e2e-spec.ts` сам подхватит фикстуру через `describe.each` — отдельный тест писать не надо.

Helper'ы для `created_at` (`apps/api/test/hints-fixtures/types.ts`):

- `daysAgo(n)` — `n` дней назад.
- `hoursAgo(n)` — `n` часов назад.
- `minutesAgo(n)` — `n` минут назад.

Запуск только этой группы тестов:

```bash
npm run test:e2e --workspace=@kingside/api -- hints-rules.e2e-spec.ts
```

---

## 4. E2E-сценарий (Playwright)

Файл — `tools/e2e-hints/tests/<key>.spec.ts`. Пример для `puzzle-comeback-after-week`:

```ts
import { test } from '@playwright/test';
import { cleanActor, seedEvents, daysAgo } from '../fixtures/actor';
import { loginAs, TEST_USER } from '../fixtures/auth';
import { expectHintShown, expectHintNotShown } from '../fixtures/hints';

test('puzzle-comeback показывается, если puzzle_start был 8 дней назад', async ({
  context, request, page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);
  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_start', created_at: daysAgo(8) },
  ]);

  await page.goto('/play');                     // ← реальный page_view через хук

  await expectHintShown(page, 'puzzle-comeback-after-week');
});

test('puzzle-comeback НЕ показывается, если puzzle_start был вчера', async ({
  context, request, page,
}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);
  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_start', created_at: daysAgo(1) },
  ]);

  await page.goto('/play');
  await expectHintNotShown(page, 'puzzle-comeback-after-week');
});
```

Доступные helper'ы (`tools/e2e-hints/fixtures/`):

| Helper | Что делает |
|--------|------------|
| `cleanActor(request, actor)` | Чистит `actor_events`, `actor_hint_states` и Redis-counters для actor'а. **Первым** в каждом тесте. |
| `seedEvents(request, actor, events[])` | Backdating: прямой `INSERT` в `events.actor_events` с явным `created_at`. **Не** дёргает HintsEngine listeners (исторические события). |
| `refreshMatviews(request)` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` для всех hints-матвью. Нужно после `seedEvents`, если правило читает через matview (24h/7d/30d). |
| `daysAgo(n)` / `hoursAgo(n)` / `minutesAgo(n)` | ISO-строка `n` единиц назад. |
| `loginAs(context, request, actor)` | Кладёт `access_token` (через `POST /test/issue-token`) и `analytics_consent=1` в browser cookies. |
| `loginAsGuest(context, guest)` | Кладёт `guest_id` и `analytics_consent=1` для гостевых правил. |
| `expectHintShown(page, key)` | Ждёт `[data-hint-popover][data-hint-key="<key>"]` до 10 сек. |
| `expectHintNotShown(page, key, windowMs?)` | Ждёт `windowMs` (default 3000), убеждается что popover'а нет. |
| `expectNoHint(page, windowMs?)` | То же, но для любой подсказки. |

Запуск:

```bash
# Профиль test-hints должен быть поднят (см. §1).
npm run e2e:hints --workspace=@kingside/e2e-hints

# Только один файл (для отладки)
npx playwright test tools/e2e-hints/tests/<key>.spec.ts

# Видеть браузер
npm run e2e:hints:headed --workspace=@kingside/e2e-hints

# Отчёт
npm run e2e:hints:report --workspace=@kingside/e2e-hints
```

### 4.1. Когда событие — это реальный клик, не seed

`seedEvents` использовать **только для исторических событий** (счётчики «за 7 дней», `timeSince`). **Триггер** правила всегда генерируется реальным действием в браузере:

| Триггер | Как срабатывает |
|---------|-----------------|
| `page_view` | `await page.goto('/play')` — хук `usePageViewTracking` (`apps/web/src/hooks/usePageViewTracking.ts`) шлёт `track('page_view', { path })`. |
| `session_idle` | `await page.waitForTimeout(65_000)` — хук `useIdleTracking` шлёт после 60 сек простоя. Для тестов — `seedEvents` исторический + отдельный тест на реальный idle. |
| `game_end`/`resign` | Реальная партия с ботом: «Играть» → выбор бота → ходы или сдача. Зависит от KS-4750 / ADR-149 (G4) — пока game-service self-emit не выкатили, заглушка через `seedEvents`. |
| `guest_play_attempted` | Клик «Играть» на лендинге без auth — фронт шлёт `track('guest_play_attempted')`. |
| `puzzle_failed` | Реальная попытка пазла с заведомо неправильным ходом. Для счётчиков — `seedEvents` 4 шт. + реальный пятый клик. |

Чисто-сеяные тесты («event + page_view → hint») допустимы для правил, где триггер — сам `page_view` (например, `puzzle-comeback-after-week` выше).

### 4.2. Smart-dismiss (acceptedBy) — отдельный негативный кейс

Правила с `acceptedBy` (например, `puzzle-comeback-after-week` имеет `acceptedBy: ['puzzle_start']`) должны иметь сценарий «accepted-event уже было → подсказка не приходит»:

```ts
test('не показывается, если acceptedBy-событие наступило за окно', async ({...}) => {
  await cleanActor(request, TEST_USER);
  await loginAs(context, request, TEST_USER);
  // Backdating: 8 дней назад был puzzle_start (matches-сценарий) +
  // вчера тоже был puzzle_start (smart-dismiss закрыл правило)
  await seedEvents(request, TEST_USER, [
    { type: 'puzzle_start', created_at: daysAgo(8) },
    { type: 'puzzle_start', created_at: hoursAgo(20) },
  ]);
  await page.goto('/play');
  await expectHintNotShown(page, 'puzzle-comeback-after-week');
});
```

---

## 5. Frontend: добавление нового anchor

Если правилу нужна новая точка крепления — одна строка в JSX:

```tsx
// apps/web/src/components/LobbyPage.tsx (пример)
<div data-hint-anchor="my-new-anchor" className="lobby-puzzles-tile">
  ...
</div>
```

**Никаких** правок `packages/shared/src/types/hint-anchors.ts` — anchor свободная строка (ADR-148). Backend на runtime не валидирует, фронт ищет через `querySelector`. Если узла нет на текущей странице — клиент шлёт `hint:no-anchor`, сервер фиксирует `hint_dismissed{reason:'no_anchor'}` и подсказку в этом page-view больше не предлагает.

Frontend-компонент `<HintHost>` (`apps/web/src/components/hints/HintHost.tsx`) рендерит popover с атрибутами `data-hint-popover` + `data-hint-key="<rule-key>"` — это контракт для Playwright-селекторов в `expectHintShown`.

---

## 6. Локальная отладка типичных проблем

| Симптом | Проверь |
|---------|---------|
| `seed/events: 404` | `HINTS_TEST_MODE=1` не выставлен. `docker compose -p kingside-test-hints exec api-test env \| grep HINTS_TEST_MODE`. |
| `seed/events: 401` | `INTERNAL_EVENTS_SECRET` не совпадает между api и Playwright. Перепроверь `playwright.config.ts → extraHTTPHeaders` и env api-test. |
| `expectHintShown timeout` | Anchor отсутствует в DOM (страница не успела отрисоваться) — добавь `await page.waitForSelector('[data-hint-anchor="..."]')` перед `expectHintShown`. |
| Hint показался, но не тот | Конфликт правил по приоритету. Проверь через `POST /test/check-for { actor, page }` — вернёт реально выбранный `key`. |
| `expectHintShown` проходит при `seedEvents` старыми — но не на проде | Правило читает Redis hot counters (короткие окна), а `seedEvents` пишет только в Postgres. Для тестирования таких правил используй **реальный клик** на триггерный event, а не `seedEvents`. |
| Тест проходит первый раз, падает второй | `cleanActor` пропущен в `beforeEach`/в начале теста. ActorHintState от прошлого прогона блокирует через `suppressedUntil` или `maxShows`. |
| `npm run e2e:hints` падает на `webServer` | В test-профиле web-test поднят docker'ом, а Playwright `webServer.command` пытается стартовать ещё один. В `tools/e2e-hints/playwright.config.ts` стоит `reuseExistingServer: true` — проверь что web-test действительно слушает `:5174`. |

---

## 7. Что **не** делать

- **Не двигать `now()` глобально** (libfaketime / SQL патчи). Сломает game-clock, rating-snapshot, partman partition rotation, JWT exp. Используй **только** backdating отдельных событий через `seedEvents` + ENV-override лимитов.
- **Не подкладывать триггерные события через `seedEvents`** — только историю. Триггер должен быть реальным кликом, иначе тест проверяет evaluator, а не end-to-end.
- **Не добавлять anchor в `packages/shared/src/types/hint-anchors.ts`** — этого файла больше нет в роли whitelist'а (ADR-148). Anchor — свободная строка в JSX.
- **Не пропускать `cleanActor` в начале теста.** Параллельный/повторный прогон без очистки даёт race на `actor_hint_states`.
- **Не лезть в `events.actor_events` руками через psql** в e2e — это обходит контракт. Только через `POST /test/seed/events` (он гарантирует ту же сериализацию payload).

---

## 8. CI

| Уровень | Где запускается | Когда |
|---------|-----------------|-------|
| L1 evaluator-юнит (`hints-dsl.evaluator.spec.ts`) | `npm run test --filter=api` | Каждый PR |
| L2 rules-юнит (`hints-rules.e2e-spec.ts`) | `npm run test:e2e --filter=api` (требует поднятый postgres-test) | Каждый PR |
| L3 Playwright (`tools/e2e-hints/`) | `npm run e2e:hints --workspace=@kingside/e2e-hints` | **Локально перед мерджем.** В CI — nightly / on-demand (тяжёлые: каждый сценарий поднимает Chromium + реальные запросы). |

Обязательная зелёная — L1 и L2. L3 — author-responsibility перед мерджем + nightly алерт владельцам.

---

## 9. Ссылки

- **ADR-150** `docs/adr/150-hints-test-automation.md` — архитектура автоматизации тестирования.
- **ADR-147** `docs/adr/147-contextual-hints.md` — основа hints (event-pipeline, consent, lifecycle).
- **ADR-148** `docs/adr/148-hints-zero-code-rules.md` — anchor как свободная строка, data-driven правила.
- **ADR-149** `docs/adr/149-game-events-single-entry.md` — единая точка эмиссии game-событий (нужно для тестирования `analyze-after-loss`).
- **PR-template (проект)** `docs/dev/PULL_REQUEST_TEMPLATE.md` — копируется в `.github/PULL_REQUEST_TEMPLATE.md`.
- **Playwright README** `tools/e2e-hints/README.md` — детали запуска и покрытия.
- **DSL evaluator** `apps/api/src/hints/hints-dsl.evaluator.ts` — точное описание операторов и их полей.
