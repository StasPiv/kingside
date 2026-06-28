# @kingside/e2e-hints

Playwright-сценарии для контекстных подсказок (ADR-147, ADR-150).
Каждый тест = реальный браузерный flow + проверка появления `data-hint-popover`
с заданным `data-hint-key`.

## Требования

- Локально поднят профиль `docker-compose.test-hints.yml` (KS-4761 / T3),
  порты: web `5174`, api `3101`, postgres `5433`, redis `6380`.
- В api активен `HintsTestModule` (`HINTS_TEST_MODE=1`, KS-4759 / T1) —
  без него endpoint'ы `/test/seed/events`, `/test/clean-actor`,
  `/test/refresh-matviews` отдают 404 и хелперы падают.
- В env установлен `INTERNAL_EVENTS_SECRET` (тот же, что в test-api),
  иначе все internal-эндпоинты ответят 401.
- Опционально `HINTS_DEFAULTS_OVERRIDE_JSON` (KS-4760 / T2), чтобы
  отключить глобальный throttle/session-лимиты для тестового actor'а.

## Запуск

```bash
bash scripts/test-hints-up.sh                  # поднимает 5 сервисов
npm run e2e:hints --workspace=@kingside/e2e-hints
bash scripts/test-hints-down.sh                # гасит + удаляет volumes
```

Опции:

| Команда | Что делает |
|---------|------------|
| `npm run e2e:hints:ui` | Playwright UI (debug) |
| `npm run e2e:hints:headed` | браузер видно, для отладки селекторов |
| `npm run e2e:hints:report` | посмотреть последний HTML-отчёт |

## Покрытие правил

| Правило | Anchor | Audience | Стратегия |
|---------|--------|----------|-----------|
| `bridge-promo-after-3-wasm` | `analysis-bridge-promo` | user | seed 3× engine_started{wasm} + позитив + негатив (был bridge) |
| `puzzle-comeback-after-week` | `home-puzzles-tile` | user | timeSince через backdating puzzle_start 8 дней назад |
| `home-idle-suggest-puzzles` | `home-puzzles-tile` | user | seed session_idle на /play |
| `discover-puzzle-rush` | `puzzles-rush-tab` | user | seed 10× puzzle_solved, нет rush_start |
| `rush-streak-recovery` | `puzzles-rush-tab` | user | seed 2× rush_streak_broken за сутки |
| `mistakes-diary-after-failures` | `profile-mistakes-link` | user | seed 5× puzzle_failed + негатив (был mistakes_diary_opened) |
| `hint-overuse-mistakes-diary` | `profile-mistakes-link` | user | seed 5× hint_used за неделю |
| `analyze-after-loss` | `game-end-analysis-button` | user | реальный flow «играть с ботом → проиграть» (без backdating, ждёт KS-4757) |
| `guest-register-prompt` | `landing-signup-button` | guest | seed guest_landing_viewed + негатив (был signup_form_opened) |
| `guest-play-friction` | `landing-signup-button` | guest | seed 2× guest_play_attempted |
| `guest-try-puzzles` | `landing-puzzles-tile` | guest | seed 2× guest_landing_viewed |
| `guest-features-discovery` | `landing-features-block` | guest | seed 3× guest_landing_viewed за неделю |

Итого 12 спецификаций, 14 тест-кейсов (часть с парой позитив + негатив).

## Структура

```
fixtures/
  actor.ts     — cleanActor / seedEvents / refreshMatviews + daysAgo/hoursAgo/minutesAgo
  auth.ts      — loginAs (user) / loginAsGuest (cookie) + TEST_USER / TEST_GUEST UUID
  hints.ts     — expectHintShown / expectHintNotShown / expectNoHint
tests/
  <rule-key>.spec.ts — один файл на правило
playwright.config.ts
package.json
tsconfig.json
```

## Принципы

1. **`fullyParallel: false`, `workers: 1`** — спецификации делят один tester-actor
   в БД, параллельный запуск создаёт race на seed/clean. Если в будущем выдадим
   каждому spec'у уникальный UUID (worker-id из Playwright), можно включить.
2. **`expect.timeout = 10 000 мс`** — между POST /events на frontend'е, reactive-check'ом
   на api и emit hint:show через WS обычно ≤2 сек; запас на медленную сборку.
3. **Не дёргать `analysis_engine_started` руками** — используется только реальный
   браузерный flow. Backdating через `seedEvents` оправдан для исторических
   условий (счётчики «за 7 дней»); текущий триггер всегда генерируется реальным
   действием.
4. **Smart-dismiss проверяется в негативных кейсах** — каждое правило с
   `acceptedBy` должно иметь спецификацию «событие было → подсказка не пришла».

## Зависимости

- T1 `KS-4759` — `HintsTestModule` (endpoint'ы /test/seed/events и др.).
- T2 `KS-4760` — env-override для consent-bypass и throttle-disable.
- T3 `KS-4761` — `docker-compose.test-hints.yml` + `scripts/test-hints-{up,down}.sh`.
- Frontend правка `data-hint-popover` / `data-hint-key` в `HintHost.tsx`
  (выполнено commit `694fff52`).

Без T1/T2/T3 каркас не запустится — сценарии падают с понятными ошибками
(`seed/events: 404` и т. п.).
