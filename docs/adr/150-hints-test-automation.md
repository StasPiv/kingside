# ADR-150 — Автоматизированное тестирование правил подсказок: юнит + end-to-end на localhost

- Статус: **Proposed** (2026-06-28)
- Дата: 2026-06-28
- Связанные задачи: KS-4758 (этот ADR), KS-4744/KS-4753 (правила hints), KS-4750/ADR-149 (game-event self-emit)
- Связанные ADR: ADR-147 (контекстные подсказки), ADR-148 (data-driven hints), ADR-149 (game-events single entry)
- Автор: architect

---

## 0. TL;DR

Каждое правило hints получает **два теста**:
1. **Юнит-тест** на бекенде — `hints-rules.spec.ts` загружает все активные правила из `/admin/hints` при старте suite и для каждого прогоняет evaluator на синтетических `actor_events` (true-ветка + false-ветка как минимум).
2. **E2E-сценарий** в новом workspace `apps/e2e-hints/` — Playwright поднимает реальный браузер, ходит реальными кликами; backdating «давно прошедших» событий — через тестовый endpoint `POST /test/seed/events` (доступен только при `HINTS_TEST_MODE=1`); throttle/session-лимиты обнуляются через `HINTS_DEFAULTS_OVERRIDE_JSON` env-override. **Сами события (game_end, page_view, session_idle, guest_play_attempted) не подкладываются — они приходят от реальных кликов в реальном UI.**

Изолированный compose-профиль `test-hints` с собственными Postgres/Redis (порт +100: 5433/6380/3101/3102/5174) гарантирует, что разработка не пересекается с тестовым прогоном.

План — 6 тикетов (~5–6 дн) на backend (юниты + test-endpoint), devops (compose-профиль), content (Playwright-suite по 8 правилам KS-4753 + bridge-promo).

---

## 1. Текущее состояние

- Юнит-тесты на чистый DSL evaluator — есть (`apps/api/src/hints/hints-dsl.evaluator.spec.ts`). Проверяют `count/exists/timeSince/page/actorType/all/any/not` на синтетических входах, **без привязки к конкретным правилам в БД**.
- Юнит-тесты на конкретные правила (KS-4753 список 8 + bridge-promo) — **нет**. Если кто-то отредактирует rule в админке так, что оператор сломается — никакой автотест не упадёт.
- E2E-тесты на правила hints — **нет**. Есть Playwright-workspace `apps/e2e/` под другие задачи (drag-drop, game-flow), но hints там не покрыты.
- Регресс ловится только пользователем вручную: запустил браузер, прошёл сценарий, посмотрел появилась ли подсказка. По описанию пользователя — «надоело это делать самому».
- Существующая инфра, на которую опираемся:
  - Jest e2e в `apps/api/test/` (NestJS supertest, jest-e2e.config.ts).
  - Playwright workspace `apps/e2e/` с конфигом и фикстурами.
  - `docker-compose.yml` с postgres+redis+api+game-service (профилей пока нет).

## 2. Требования

| # | Требование |
|---|------------|
| R1 | Каждое активное правило из `/admin/hints` имеет **юнит-тест** на матчинг DSL. |
| R2 | Каждое правило имеет **e2e-сценарий**, где события приходят от реальных пользовательских действий в браузере. |
| R3 | Временные окна правил (`windowDays=7`, `cooldownSec=86400`) **не ждут реальное время** — задержки эмулируются. |
| R4 | **События сами не эмулируются** — клик «Сдаться», окончание партии, page_view, idle — всё через UI. |
| R5 | Тестовый запуск **изолирован от dev-окружения** (отдельные Postgres/Redis, тестовые пользователи). |
| R6 | Новое правило → автор обязан добавить юнит + e2e в том же PR. Без этого правило не публикуется. |
| R7 | E2E может запускаться локально одним скриптом, опционально в CI (тяжелые, nightly). Юниты — в обычный jest run. |

## 3. Архитектура

### 3.1. Уровни тестирования

```
┌────────────────────────────────────────────────────────────────┐
│ L1. evaluator-юнит (apps/api/src/hints/hints-dsl.evaluator.   │
│     spec.ts)                                                   │
│     — Чистая функция от (rule, ctx). Проверяет операторы.     │
│     — Уже существует, не трогаем.                              │
├────────────────────────────────────────────────────────────────┤
│ L2. rules-юнит (НОВЫЙ: apps/api/test/hints-rules.e2e-spec.ts) │
│     — beforeAll: GET /admin/hints?enabled=true → live-список   │
│       активных правил из тестовой БД.                          │
│     — Для каждого правила: 2+ describe (`matches`, `no_match`) │
│       подкладывают актер_events fixture + actor consent →      │
│       прогоняют через HintsService.checkFor (без выхода в WS). │
│     — Проверяют `selectedHint?.key === expectedKey`.           │
├────────────────────────────────────────────────────────────────┤
│ L3. e2e Playwright (НОВЫЙ workspace: apps/e2e-hints/)         │
│     — Реальный браузер на localhost:5174 (test-профиль).       │
│     — Реальные клики → реальные XADD → реальный HintsEngine →  │
│       реальный WS hint:show → DOM-popover.                     │
│     — Backdating старых событий через POST /test/seed/events.  │
│     — Throttle/session обнуляется env-override.                │
└────────────────────────────────────────────────────────────────┘
```

### 3.2. Где живёт код

| Часть | Расположение | Зона ответственности |
|-------|--------------|----------------------|
| Юнит L1 (evaluator) | `apps/api/src/hints/hints-dsl.evaluator.spec.ts` | backend (уже есть) |
| Юнит L2 (правила) | `apps/api/test/hints-rules.e2e-spec.ts` | backend (T4) |
| Test-endpoint backdating | `apps/api/src/hints/test/hints-test.controller.ts` | backend (T1) |
| ENV-override лимитов | `apps/api/src/hints/hints-limits.service.ts` + `feature-flags.service.ts` | backend (T2) |
| Compose-профиль `test-hints` | `docker-compose.test-hints.yml` + `scripts/test-hints-up.sh` | devops (T3) |
| Playwright-сценарии | `apps/e2e-hints/tests/<rule-key>.spec.ts` + `apps/e2e-hints/playwright.config.ts` + `apps/e2e-hints/fixtures/*` | content/playwright (T5) |
| CI-job (опц.) | `scripts/ci-hints-e2e.sh` | devops (T6 nice-to-have) |

### 3.3. Изоляция через compose-профиль

Файл `docker-compose.test-hints.yml` поднимает **отдельные** контейнеры со всеми портами +100:

| Сервис | dev-порт | test-hints-порт | Volume |
|--------|----------|------------------|--------|
| postgres | 5432 | **5433** | `pg_data_test_hints` (свой) |
| redis | 6379 | **6380** | tmpfs (полностью эфемерный, перезапуск = чистый) |
| api | 3001 | **3101** | — |
| game-service | 3002 | **3102** | — |
| web (vite) | 5173 | **5174** | — |

ENV-переменные для test-профиля:
```
HINTS_TEST_MODE=1
HINTS_DEFAULTS_OVERRIDE_JSON={"hints.global_throttle_seconds":0,"hints.session_max_shows":1000,"hints.smart_dismiss_window_hours":24,"hints.enabled":true}
INTERNAL_EVENTS_SECRET=test-hmac-secret-do-not-use-in-prod
ANALYTICS_CONSENT_BYPASS=1   # для test-fixture пользователей, см. §3.5
NODE_ENV=test
DATABASE_URL=postgres://kingside:kingside@postgres:5432/kingside  (внутри сети контейнера)
EVENTS_DATABASE_URL=...      (та же БД, схема events; см. ADR-149 §1.4)
REDIS_URL=redis://redis:6379
```

Поднимается одной командой:
```bash
docker-compose -f docker-compose.test-hints.yml --profile test-hints up -d
scripts/test-hints-wait-healthy.sh   # ждёт healthchecks
npx playwright test --config apps/e2e-hints/playwright.config.ts
```

Тестовый запуск **не делит** Postgres/Redis с разработкой — можно гонять параллельно с dev-сервером.

### 3.4. Тестовые пользователи

Фикстура `apps/e2e-hints/fixtures/test-users.ts`:
```ts
export const TEST_USERS = [
  { email: 'test-rule-puzzle-comeback@kingside.test', password: 'Test12345!' },
  { email: 'test-rule-discover-rush@kingside.test',  password: 'Test12345!' },
  { email: 'test-rule-mistakes-diary@kingside.test', password: 'Test12345!' },
  // ... по одному на каждое правило, чтобы сценарии могли идти параллельно
];
```

Перед каждым сценарием — глобальный `beforeEach` чистит сущности этого actor'а:
```
DELETE FROM events.actor_events       WHERE actor_id = $1;
DELETE FROM events.actor_hint_states  WHERE actor_id = $1;
UNLINK Redis: agg:<id>:* + hints:throttle:<id> + hints:session:<id>:*
```

Это инкапсулировано в helper `cleanActor(email)` — отдельный test-endpoint `POST /test/clean-actor` (gated `HINTS_TEST_MODE=1`).

### 3.5. Consent — bypass для test-fixture

ADR-147 §6.2 требует явного согласия (`analyticsConsent=true`) для записи событий. В тестовых сценариях согласие выставляется **один раз в seed**: `INSERT INTO users (email, analytics_consent) VALUES ($1, true)` через test-endpoint `POST /test/users` или через ENV-флаг `ANALYTICS_CONSENT_BYPASS=1` (применяется только в `EventsService.hasUserConsent` под `if (process.env.NODE_ENV === 'test')`).

Лёгкий вариант — `ANALYTICS_CONSENT_BYPASS=1` (одна строка кода в `hasUserConsent`), не требует дополнительного endpoint'а. Рекомендую его.

## 4. Эмуляция времени без эмуляции событий

### 4.1. Что НЕ эмулируем

- **Сами события** (`game_end`, `page_view`, `session_idle`, `puzzle_solved`, `puzzle_failed`, `hint_used`, `guest_play_attempted`, `resign`...) — приходят от реальных кликов в Playwright. Это требование R4.
- **Глобальное время** (`now()`) — двигать **запрещено**: сломается game-clock, rating-snapshot, partman partition rotation, JWT exp, и десятки других мест. Только локальный backdating отдельных событий.

### 4.2. Что эмулируем — backdating отдельных событий

**Test-endpoint** `POST /test/seed/events` (новый, в `apps/api/src/hints/test/hints-test.controller.ts`):

```http
POST /test/seed/events
X-Test-Mode: 1
Content-Type: application/json

{
  "events": [
    {
      "actor_id":  "<uuid-of-test-user>",
      "actor_type":"user",
      "type":      "game_end",
      "payload":   {"result":"loss","termination":"resignation","rating_delta":-12,"color":"white","game_id":"<uuid>"},
      "created_at":"2026-06-21T10:00:00Z"
    },
    ...
  ]
}
```

Endpoint:
- Доступен **только** при `HINTS_TEST_MODE=1` (проверка в guard'е), иначе 404.
- Пишет напрямую в `events.actor_events` (минуя XADD-pipeline) — XADD не позволяет задать `created_at` в прошлом, writer всегда ставит `now()` в момент чтения из stream'а.
- НЕ дёргает `EventsService.track()` listeners (HintsEngine.onTrack) — реактивный hint не должен показываться на backdated-events, иначе сценарий получит лишние подсказки до того, как сделал реальный клик. Это «история», не «свежее».
- Возвращает `{inserted: N}`.

### 4.3. Что эмулируем — throttle и session-лимиты

ADR-147 §5.2: глобальные лимиты конфигурируются через `feature-flags`-модуль. В test-профиле — ENV-override `HINTS_DEFAULTS_OVERRIDE_JSON='{"hints.global_throttle_seconds":0,"hints.session_max_shows":1000}'`:
- `global_throttle_seconds=0` → между показами не ждём ни секунды.
- `session_max_shows=1000` → за сценарий показов сколько угодно.
- `smart_dismiss_window_hours=24` оставляем как в проде — это часть бизнес-семантики правила.
- `hints.enabled=true` — обязательно, без этого engine ничего не вернёт.

Реализация: `HintsLimitsService.getConfig()` сейчас читает из `FeatureFlagsService.getConfig('hints')`. В test-mode — поверх читается `process.env.HINTS_DEFAULTS_OVERRIDE_JSON` (если задано) и сливается через `Object.assign` поверх БД-значений. Local-cache 60s в тестах не нужен — отключается при `HINTS_TEST_MODE=1`.

### 4.4. Что НЕ эмулируем нигде

- **Redis hot counters** (`agg:<actor_id>:*`) — пишутся из real-stream writer'ом. Backdated-события через test-endpoint в Redis-counters **не попадают** (только в Postgres). Это правильно: правила, которые читают только короткие окна через Redis (если такие появятся), будут тестироваться через реальный клик.
- **Materialized views** (`actor_event_counts_24h/7d/30d`) — рефрешатся каждые 30–60s. После backdating старых событий нужно **дёрнуть refresh вручную** через тот же test-endpoint `POST /test/refresh-matviews` (один SQL `REFRESH MATERIALIZED VIEW CONCURRENTLY events.actor_event_counts_*`). Альтернатива — отключить matview-cache на test-profile и читать всегда raw `actor_events`, что и так делает текущий evaluator (см. `hints-dsl.evaluator.ts:108–121` — он ходит в raw, не в matview, специально потому что нужно ровно окно из правила).

## 5. Шаблон юнит-теста (L2)

`apps/api/test/hints-rules.e2e-spec.ts`:

```ts
describe('hints rules — matches/no-match', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let events: EventsPrismaService;
  let hints: HintsService;
  let activeRules: Hint[];

  beforeAll(async () => {
    app = await bootstrapTestModule();
    prisma = app.get(PrismaService);
    events = app.get(EventsPrismaService);
    hints = app.get(HintsService);
    // Загружаем live-список из /admin/hints?enabled=true тестовой БД.
    // Юниты НЕ дублируют DSL правил у себя — источник истины один (БД).
    activeRules = await prisma.hint.findMany({ where: { enabled: true, deletedAt: null } });
  });

  afterEach(async () => {
    await cleanAllTestActors(events, prisma);
  });

  describe.each(activeRules)('rule $key', (rule) => {
    it('matches when fixture satisfies the rule', async () => {
      const actor = await createTestActor({ type: rule.targetActorTypes[0] as ActorType });
      await seedFixture(events, actor, fixtureFor(rule, 'matches'));
      const result = await hints.checkFor(actor, { page: pageHintFor(rule) });
      expect(result?.key).toBe(rule.key);
    });

    it('does NOT match when fixture is the inverse', async () => {
      const actor = await createTestActor({ type: rule.targetActorTypes[0] as ActorType });
      await seedFixture(events, actor, fixtureFor(rule, 'no_match'));
      const result = await hints.checkFor(actor, { page: pageHintFor(rule) });
      expect(result?.key).not.toBe(rule.key);
    });
  });
});
```

`fixtureFor(rule, 'matches' | 'no_match')` — конвенция: для каждого правила в `apps/api/test/hints-fixtures/<rule-key>.ts` лежит пара массивов событий + ожидаемая страница, обеспечивающие true/false ветку. Это **единственная ручная часть юнит-теста** — массив фейк-событий, который автор правила прикладывает к PR одновременно с самим правилом.

Если для нового правила фикстуры нет — `describe.each` не упадёт молча, а провалится с явным message `fixture missing for rule "<key>"` (валидация в `fixtureFor()`).

## 6. Шаблон e2e-сценария (L3)

`apps/e2e-hints/tests/puzzle-comeback-after-week.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { cleanActor, seedEvents, loginUser } from '../fixtures/helpers';

test.describe('rule: puzzle-comeback-after-week', () => {
  const USER = 'test-rule-puzzle-comeback@kingside.test';

  test.beforeEach(async () => {
    await cleanActor(USER);
    // Никаких backdated puzzle_start — это правило срабатывает по timeSince
    // (puzzle_start gtDays 7). У свежего actor'а событий нет → timeSince
    // = бесконечно давно → true.
  });

  test('shows popover on /play when user has never solved puzzles', async ({ page }) => {
    await loginUser(page, USER);

    // R4: реальный клик, не подкладывание события
    await page.goto('/play');     // эмитит page_view через хук usePageViewTracking
    await expect(page.locator('[data-hint-anchor="home-puzzles-tile"]')).toBeVisible();

    // Подсказка приходит реактивно через WS hint:show
    await expect(page.locator('[data-hint-popover][data-hint-key="puzzle-comeback-after-week"]'))
      .toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Не решал пазлы неделю')).toBeVisible();
  });

  test('does NOT show when last puzzle_start was within 7 days', async ({ page }) => {
    // R3: backdating одного «свежего» события чтобы выключить правило
    await seedEvents(USER, [
      { type: 'puzzle_start', payload: { puzzle_id: 'fake-uuid' },
        created_at: daysAgo(3) },  // 3 дня назад → не «бесконечно давно»
    ]);

    await loginUser(page, USER);
    await page.goto('/play');
    await expect(page.locator('[data-hint-anchor="home-puzzles-tile"]')).toBeVisible();
    await expect(page.locator('[data-hint-popover][data-hint-key="puzzle-comeback-after-week"]'))
      .toHaveCount(0);
  });
});
```

Для правил с реальным `game_end` (после KS-4750/G4) сценарий длиннее: «нажми Играть → выбери бота → сделай 1–2 хода → нажми Сдаться → дождись модалки → проверь подсказку». Шаблон тот же, ключевое — `seedEvents()` подкладывает **только историю**, текущий триггер — клик в UI.

## 7. CI / процесс

| Уровень | Где запускается | Когда |
|---------|-----------------|-------|
| L1 evaluator-юнит | `npm run test --filter=api` | Каждый PR, обязательно green |
| L2 rules-юнит | `npm run test:e2e --filter=api` (jest-e2e) | Каждый PR, обязательно green |
| L3 Playwright | `npm run test:e2e --filter=e2e-hints` | **Локально** перед мерджем; CI — nightly или on-demand (тяжёлые, минуты) |

Регресс-процесс зашиваем в шаблон PR (`docs/process/PULL_REQUEST_TEMPLATE.md` обновляется в составе T6):
```
- [ ] Если правило hints новое — добавлен `apps/api/test/hints-fixtures/<key>.ts`
- [ ] Если правило hints новое — добавлен `apps/e2e-hints/tests/<key>.spec.ts`
- [ ] L1/L2 локально проходят
```

Это не auto-enforce (можно проигнорировать checkbox), но даёт точку ревью: координатор отказывается мерджить без галочек.

Жёсткий enforcement — отдельный follow-up: pre-commit hook `scripts/check-hints-coverage.sh`, который сверяет список activeRules с наличием fixture + spec-файла. Не сейчас (даёт false-positive на правила в админке, которых нет в репо).

## 8. План внедрения

| # | Тикет | Кто | Содержание | Зависимости |
|---|-------|-----|------------|-------------|
| **T1** | **backend: test-endpoint `POST /test/seed/events`** | backend | Новый controller `apps/api/src/hints/test/hints-test.controller.ts` под `HintsTestModule`, регистрируется только при `HINTS_TEST_MODE=1`. Endpoints: `POST /test/seed/events` (массив с явным `created_at`, прямой INSERT в `events.actor_events`), `POST /test/clean-actor` (чистка events + states + Redis), `POST /test/refresh-matviews` (одна команда REFRESH). Guard: при `HINTS_TEST_MODE !== '1'` модуль не подключается. Тесты: smoke на guard (без env → модуль не подключён → 404). | — |
| **T2** | **backend: ENV-override для hints-лимитов в test-mode** | backend | `HintsLimitsService.getConfig()`: при `HINTS_TEST_MODE=1` поверх БД-конфига слить `JSON.parse(process.env.HINTS_DEFAULTS_OVERRIDE_JSON ?? '{}')`. Local-cache отключить в test-mode. `EventsService.hasUserConsent()`: при `ANALYTICS_CONSENT_BYPASS=1 && NODE_ENV='test'` всегда возвращать `true`. Юнит-тесты на оба override. | — |
| **T3** | **devops: compose-профиль `test-hints` + healthcheck-скрипт** | devops | `docker-compose.test-hints.yml` (отдельный файл, не дополнение к основному): postgres-test:5433, redis-test:6380 (tmpfs), api-test:3101, game-service-test:3102, web-test:5174. Volumes отдельные, INTERNAL_EVENTS_SECRET и HINTS_TEST_MODE прописаны. `scripts/test-hints-up.sh` (up -d + ждёт healthchecks через `healthcheck.status`). `scripts/test-hints-down.sh` (`down -v` для полной очистки). README по запуску в `apps/e2e-hints/README.md`. | T1, T2 |
| **T4** | **backend: юнит-suite для правил `hints-rules.e2e-spec.ts`** | backend | Новый файл в `apps/api/test/`. `beforeAll` загружает active rules из БД. Для каждого правила — `describe.each` с двумя `it`: matches + no-match. Фикстуры — отдельные TS-файлы в `apps/api/test/hints-fixtures/<key>.ts` (для 8 правил KS-4753 + bridge-promo + 1 заготовка для будущего analyze-after-loss). Запускается под Jest-e2e config, требует поднятый postgres-test (через T3). | T1, T2, T3 |
| **T5** | **content: Playwright workspace `apps/e2e-hints/` + сценарии** | content (playwright) | Новый workspace по образцу `apps/e2e/`: `package.json`, `playwright.config.ts` (baseURL `http://localhost:5174`), `tsconfig.json`, `tests/<rule-key>.spec.ts` × 9 правил (8 KS-4753 + bridge-promo), `fixtures/helpers.ts` (cleanActor, seedEvents, loginUser, daysAgo). Тесты разбиты пофайлово — каждое правило отдельный spec-файл с user_id-фикстурой; параллельный run безопасен (разные actor'ы). Каждый сценарий — minimum «matches» + «does NOT match». README с инструкциями: `scripts/test-hints-up.sh && npx playwright test`. | T3, T4 |
| **T6** | **docs/process: чек-лист в PR-template + раздел в DEVELOPMENT.md** | architect | Обновить `.github/PULL_REQUEST_TEMPLATE.md` (или создать) с checkbox-ами на юнит/e2e для нового правила. Добавить раздел «Hints rules — workflow» в `docs/dev/` (или CONTRIBUTING.md) — где описано: «Чтобы добавить правило, нужны 4 артефакта в одном PR: rule в seed/админке + fixture + e2e-spec + ru/en тексты». | T4, T5 |

### 8.1. Параллелизация

- T1 + T2 параллелятся (разные файлы backend).
- T3 параллелен T1/T2 (devops).
- T4 ждёт T1/T2/T3.
- T5 ждёт T3 (для запуска), может стартовать параллельно с T4 (Playwright не зависит от backend-юнитов).
- T6 — финальный, после T4/T5.

Суммарно ~5–6 дн с учётом параллелизации (~3.5 дн backend, ~2 дн content, ~0.5 дн devops, ~0.5 дн docs).

### 8.2. Совместимость с прод-окружением

- Прод **не получает test-endpoint'ы** — `HintsTestModule` подключается только при `HINTS_TEST_MODE=1`, в проде env не задаётся.
- ENV-override лимитов также gated, в проде не активен.
- `ANALYTICS_CONSENT_BYPASS` gated `NODE_ENV='test'`, в `production` бесполезен.

Это **разные DI-графы по env**, не «магические флаги в проде». Безопасно.

### 8.3. Что НЕ входит

- **Visual regression** (скриншоты подсказок): отдельная задача, не обязательна для R1–R7.
- **Нагрузочное тестирование hints**: масштабирование RDS и Redis Streams отрабатывается мониторингом prod (Grafana §7A.2 ADR-147), не e2e.
- **Тестирование smart-dismiss** (acceptedBy): покрывается L2 (юниты) + по одному e2e-сценарию на правило с `acceptedBy` (например, `analyze-after-loss`: показать → выполнить acceptedBy-событие через UI → проверить что `acted_at` обновился через GET-проверку или повторный показ не приходит).
- **A/B-тестирование** правил: не входит в scope ADR-150 (это другая фича, см. ADR-148 §10).

---

## 9. Что НЕ меняется

- `HintsService.checkFor()` контракт — без правок.
- `EventsService.track()` — без правок (consent-bypass добавлен только под `NODE_ENV=test`).
- DSL evaluator — без правок.
- Прод docker-compose.yml — без правок (test-hints в отдельном файле).
- Прод env — без правок (`HINTS_TEST_MODE` не задаётся).
- Существующие правила hints, активные в проде — не трогаем.

---

## 10. Открытые вопросы (вне scope)

1. **Стабильность `data-hint-popover` атрибута для Playwright.** Сейчас в `<HintHost>` нет фиксированного `data-hint-popover` — Playwright цепляется через role/text. Чтобы тесты были stable, нужно ввести атрибут `data-hint-popover` + `data-hint-key="<key>"` на корневом узле popover'а. Это **одна строка JSX в `apps/web/src/components/hints/HintHost.tsx`** — выносим в T5 как часть подзадачи frontend (фронт-разработчик добавляет атрибут на этапе подготовки к Playwright-suite). Не блокирует архитектуру.
2. **Параллелизация e2e на разных user'ах.** Playwright `fullyParallel: true` уже в `apps/e2e/playwright.config.ts`. Для hints это безопасно, если каждый сценарий пользуется уникальным `test-rule-<key>@kingside.test`, чтобы actor'ы не конфликтовали по `actor_hint_states`. Конвенция «один сценарий — один уникальный user» в T5.
3. **Cleanup между retry.** Playwright retry в CI = 2. `beforeEach` чистит actor'а — повторный прогон не должен унаследовать состояние от failed-первого. Дополнительно — после flaky-теста надо чистить ещё и WS-сокет (закрытое соединение в браузере может сохраниться); решается стандартным `page.context().close()` в `afterEach`. Standard playwright-pattern, не требует отдельного механизма.

---

## 11. Резюме

- **Два уровня тестов на каждое правило**: L2-юнит на бекенде (rules-spec прогоняет evaluator на фикстурах) + L3-Playwright в новом workspace `apps/e2e-hints/`.
- **Backdating через test-endpoint** `POST /test/seed/events` (gated `HINTS_TEST_MODE=1`), throttle/session обнуляются через `HINTS_DEFAULTS_OVERRIDE_JSON`, consent для test-actor'ов через `ANALYTICS_CONSENT_BYPASS=1`. **Сами события не подкладываются — приходят от реальных кликов.**
- **Изолированный docker-compose профиль** `test-hints` (порты +100), отдельные Postgres/Redis volumes, не делятся с разработкой.
- **План — 6 тикетов на ~5–6 дн**: T1/T2 backend test-инфра, T3 devops compose-профиль, T4 backend юнит-suite, T5 content Playwright-сценарии для 9 правил, T6 docs/PR-template.
- **Прод не получает test-endpoint'ы и не зависит от test-env** — это разные DI-графы по `HINTS_TEST_MODE`, не флаги поверх production-кода.
