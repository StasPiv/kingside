# Screenshot Tooling — How-To

Как агенту снять скриншот страницы Kingside (с логином и без) через `scripts/screenshot.mjs`.

Подробности реализации — в шапке `scripts/screenshot.mjs` и в ADR-036/ADR-039.

## Когда применять

- QA проверяет визуальные acceptance-критерии задачи (этап E4 ADR-036).
- Frontend/layout снимает «до/после» для PR.
- Воспроизведение бага под реальным авторизованным пользователем.
- Сверка mobile + desktop вёрстки, тёмной/светлой темы, `ru/en` локалей.

Скрипт лежит в `scripts/screenshot.mjs` (а не `tools/`, как в первичной формулировке ADR-036). Запуск только из корня репозитория, чтобы Playwright нашёлся в `node_modules`.

## Быстрый старт

### 1. Анонимный скрин (без логина)

```bash
node scripts/screenshot.mjs \
  --url=https://kingside.site/lobby \
  --out=/tmp/KS-XXXX/lobby-anon.png
```

### 2. Залогиненный скрин (test-аккаунт)

```bash
node scripts/screenshot.mjs \
  --url=https://kingside.site/lobby \
  --out=/tmp/KS-XXXX/lobby-auth.png \
  --auth=test
```

`--auth=test` ходит на `POST /internal/screenshot-token` (без пароля, без env-переменных) и логинит под скрытым служебным аккаунтом `__screenshot_agent` (`isTestAccount=true`, `isHidden=true`, рейтинг 1500). Токен живёт 15 минут — для одного снимка хватает с запасом.

### 3. Mobile

```bash
node scripts/screenshot.mjs \
  --url=https://kingside.site/lobby \
  --out=/tmp/KS-XXXX/lobby-auth-mobile.png \
  --auth=test --viewport=mobile
```

Доступные viewport: `desktop` (1280×800, default), `mobile` (iPhone 13), `mobile-small` (iPhone SE 375×667), `tablet` (iPad Pro 11).

### 4. Полная страница, тёмная тема, русская локаль

```bash
node scripts/screenshot.mjs \
  --url=https://kingside.site/profile \
  --out=/tmp/KS-XXXX/profile-dark-ru.png \
  --auth=test --full-page --theme=dark --locale=ru
```

### 5. Ждать селектор (страница рендерится асинхронно)

```bash
node scripts/screenshot.mjs \
  --url=https://kingside.site/analysis \
  --out=/tmp/KS-XXXX/analysis-ready.png \
  --auth=test \
  --selector='[data-testid="analysis-board"]'
```

Если селектор не появился за 10 секунд — exit 3.

### 6. Локальный dev (Vite + Nest)

```bash
node scripts/screenshot.mjs \
  --url=http://localhost:5173/lobby \
  --out=/tmp/KS-XXXX/lobby-local.png \
  --auth=test
```

API base скрипт выводит автоматически (`localhost:5173` → `localhost:3001`). Принудительно — через `SCRN_API_BASE_URL`.

## Все аргументы

| Аргумент | Значения | По умолчанию |
|----------|----------|--------------|
| `--url` | URL страницы | обязательный |
| `--out` | путь к выходному PNG | обязательный |
| `--auth` | `test` \| `none` | `none` |
| `--viewport` | `desktop` \| `mobile` \| `mobile-small` \| `tablet` | `desktop` |
| `--wait-for` | `load` \| `domcontentloaded` \| `networkidle` \| `commit` | `networkidle` |
| `--selector` | CSS-селектор | — |
| `--full-page` | флаг | false |
| `--theme` | `light` \| `dark` | — |
| `--locale` | `en` \| `ru` | — |
| `--debug` | флаг (логи в stderr) | false |

## Куда класть скриншоты

- В контейнере агента есть `RW` только на `/tmp`. Все артефакты — в `/tmp/KS-XXXX/<name>.png`, где `KS-XXXX` — ключ задачи трекера. QA читает из этой же директории и сверяет с Gherkin acceptance.
- НЕ класть `*.png` в репозиторий — это бинарные артефакты, к ним нет смысла применять git.

## Stdout / Stderr / Exit codes

- **stdout** — только абсолютный путь к PNG (для парсинга в пайплайнах агента).
- **stderr** — прогресс и ошибки. Подробные логи — флагом `--debug` или `SCRN_DEBUG=1`.
- **Exit codes:**
  - `0` — OK.
  - `1` — ошибки авторизации / валидации аргументов / любые 4xx/5xx от `/internal/screenshot-token`.
  - `2` — `page.goto` или `page.screenshot` упали без сетевой причины.
  - `3` — `--selector` не найден за 10 секунд.
  - `4` — сетевая ошибка (DNS/TLS/connection refused/Playwright runtime недоступен).

## Известные грабли

- **`HTTP 503` от `/internal/screenshot-token`.** Test-аккаунт не засеян на этом env. Локально — `npm run seed:screenshot` в `apps/api`. На проде должен быть прописан seed-ом (KS-2257). См. `scripts/screenshot-agent-rotation.md`.
- **`HTTP 429`.** Сработал `RedisRateLimitGuard` на endpoint'е токена. Подождать. Бессмысленно стрелять параллельно — у одного агента это всегда последовательно.
- **`exit 4` сразу после старта.** Не запущен из корня репо или нет `node_modules/playwright`. Запускать только из `/project`. Если запускаешь из агента — Playwright уже стоит в проектных зависимостях, ничего отдельно ставить не нужно.
- **Скрин выглядит «как анонимный», хотя `--auth=test`.** Проверь `--debug` — должна быть строка `screenshot-token: OK`. Если её нет — токен не получили, фронт отрендерился без `localStorage.token`.
- **Не пиши `npx playwright`.** Это поставит другую версию рядом и сломает текущую. Только `node scripts/screenshot.mjs ...` или, при ручных манипуляциях, `/project/node_modules/.bin/playwright`.

## Пример проверки задачи (QA-flow)

1. Прочитал acceptance в задаче (Gherkin Then-критерии).
2. Снял скрин нужной страницы под `--auth=test` в `desktop` и `mobile`.
3. Открыл PNG через `Read`, сверил каждое Then-условие визуально.
4. Совпало — `Задача проверена. <что проверено>. @coordinator`.
5. Не совпало — `Задача не принята. <конкретная проблема>. @coordinator`.

## Связанные ADR и задачи

- ADR-036 §6 — общая концепция и этапы E1–E4.
- ADR-039 §6 — переход на `/internal/screenshot-token` без env-паролей.
- KS-2257 — seed test-аккаунта `__screenshot_agent`.
- KS-2304 / KS-2307 / KS-2308 — `ScreenshotTokenController` и его подключение в `AuthModule`.
- KS-2262 — обкатка инструмента (этот документ).
