# scripts/

Утилиты для деплоя, инфраструктуры и поддерживающих процедур Kingside. Каждый
скрипт самодостаточен и запускается из корня репозитория.

## Скрипты для агентов

### `screenshot.mjs` — скриншоты страниц через Playwright

Headless Chromium снимает страницу Kingside, опционально под логином
test-аккаунта `__screenshot_agent`. Используется агентами для
визуальной верификации задач (KS-2259, ADR-036 §5).

Базовое использование:

```bash
node scripts/screenshot.mjs \
  --url=https://kingside.site/lobby \
  --out=/tmp/lobby.png \
  --auth=test \
  --viewport=mobile
```

**Аргументы:**

| Флаг           | Значения                                       | Дефолт         | Описание                                                |
| -------------- | ---------------------------------------------- | -------------- | ------------------------------------------------------- |
| `--url`        | URL                                            | (обязательный) | Страница для скрина.                                    |
| `--out`        | путь                                           | (обязательный) | Куда писать PNG. Каталог создаётся автоматически.       |
| `--auth`       | `test` \| `none`                               | `none`         | `test` логинит под `__screenshot_agent`.                |
| `--viewport`   | `desktop` \| `mobile` \| `mobile-small` \| `tablet` | `desktop`  | Через `playwright/devices` (iPhone 13 / iPhone SE / iPad Pro 11). |
| `--wait-for`   | `load` \| `domcontentloaded` \| `networkidle` \| `commit` | `networkidle` | `waitUntil` для `page.goto`.            |
| `--selector`   | CSS                                            | —              | Ждать селектор до 10s после goto.                       |
| `--full-page`  | флаг                                           | off            | Снимать всю страницу, не только viewport.               |
| `--theme`      | `light` \| `dark`                              | —              | `data-theme` атрибут html + `localStorage.theme`.       |
| `--locale`     | `en` \| `ru`                                   | —              | `localStorage.locale` + Accept-Language.                |
| `--debug`      | флаг                                           | off            | Подробные логи в stderr.                                |

**Stdout:** только абсолютный путь к созданному PNG. Парсится агентом —
никаких других сообщений (всё, что нужно глазам, идёт в stderr).

**Exit codes:**

| Код | Когда                                                                          |
| --- | ------------------------------------------------------------------------------ |
| 0   | OK, файл создан.                                                                |
| 1   | Auth fail (HTTP != 200 на `/auth/login`, нет токенов в ответе, отсутствует `SCRN_AGENT_PASSWORD`, неверные args). |
| 2   | Page load fail (`page.goto` бросил, `screenshot` не записал, не сетевая причина). |
| 3   | Селектор `--selector` не найден за 10s.                                         |
| 4   | Сетевая ошибка (DNS/connect refused/TLS/timeout) до или во время HTTP.          |

**Окружение:**

| Переменная             | Что это                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `SCRN_AGENT_PASSWORD`  | Пароль `__screenshot_agent`. Из AWS SSM (см. KS-2258 + `screenshot-agent-rotation.md`). Обязателен при `--auth=test`. |
| `SCRN_AGENT_USERNAME`  | Перекрытие username (default `__screenshot_agent`).                    |
| `SCRN_API_BASE_URL`    | Перекрытие API base (для логина). По умолчанию выводится из `--url`.   |
| `SCRN_DEBUG`           | `1` = эквивалент `--debug`.                                            |

**API-base inference (если `SCRN_API_BASE_URL` не задана):**

| `--url` host         | API base                  |
| -------------------- | ------------------------- |
| `kingside.site`      | `https://api.kingside.site` |
| `api.kingside.site`  | `https://api.kingside.site` |
| `localhost`          | `http://localhost:3001`   |
| прочее               | `https://api.<host>`       |

**Примеры:**

```bash
# 1. Анонимный десктопный скрин лобби.
node scripts/screenshot.mjs \
  --url=https://kingside.site/lobby --out=/tmp/lobby-desktop.png

# 2. Залогиненный мобильный full-page профиля.
node scripts/screenshot.mjs \
  --url=https://kingside.site/profile --out=/tmp/profile-mobile.png \
  --auth=test --viewport=mobile --full-page

# 3. Конкретный элемент анализа в тёмной теме.
node scripts/screenshot.mjs \
  --url=https://kingside.site/analysis --out=/tmp/analysis-dark.png \
  --auth=test --selector='[data-testid="analysis-board"]' --theme=dark

# 4. Русская локализация на планшете.
node scripts/screenshot.mjs \
  --url=https://kingside.site/puzzles --out=/tmp/puzzles-ru.png \
  --auth=test --locale=ru --viewport=tablet

# 5. Debug — увидеть все шаги (login, init-script, goto, screenshot).
node scripts/screenshot.mjs \
  --url=https://kingside.site/lobby --out=/tmp/lobby-debug.png \
  --auth=test --debug
```

**Связанные документы:**

- `scripts/screenshot-agent-rotation.md` — ротация пароля test-аккаунта (90 дней).
- `scripts/rotate-screenshot-agent-password.sh` — автоматизация ротации.
- ADR-036 — общая архитектура screenshot-инфры.

---

## Деплой / инфраструктура

| Скрипт                                | Назначение                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `deploy-aws.sh`                       | Главный деплой в AWS (frontend / api / workers / synthetic-bot / all). См. шапку файла — рунбук отката, KS-1826/KS-1897. |
| `deploy-frontend.sh`                  | Враппер `deploy-aws.sh frontend`.                                               |
| `deploy-api.sh`                       | Враппер `deploy-aws.sh api`.                                                    |
| `deploy-synthetic-bot.sh`             | Сборка + регистрация revision + update-service для synthetic-bot.               |
| `deploy-local.sh`                     | Legacy деплой на Kamatera.                                                      |
| `deploy-server-zero-downtime.sh`      | Blue/green на Kamatera-хосте (legacy).                                          |
| `archive-cutover.sh`, `archive-db-setup.sh`, `archive-infra-setup.sh`, `archive-service-aws-setup.sh`, `archive-sql.sh` | One-off bootstrap archive-service. |
| `broadcast-service-aws-setup.sh`      | One-off bootstrap broadcast-service.                                            |
| `synthetic-bot-aws-setup.sh`          | One-off bootstrap synthetic-bot.                                                |
| `cleanup-puzzle-worker-infra.sh`      | Удаление legacy puzzle-worker инфры.                                            |
| `remove-rabbitmq.sh`                  | Деинсталляция RabbitMQ (legacy).                                                |
| `nginx-hotfix.sh`, `prod-502-fix.sh`, `api-hotfix.sh` | Hotfix-процедуры на проде.                                      |
| `api-watchdog.sh`, `dev-watchdog.sh`  | Локальные watchdog'и сервисов.                                                  |

## Сопровождение БД и данных

| Скрипт                                | Назначение                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| `postgres-init/`                      | Init-скрипты PostgreSQL Docker (создание broadcasts_kingside).      |
| `fixtures/`                           | Фикстуры для разных сценариев.                                      |
| `scan-chess-results-cron.sh`          | Cron-скан chess-results.                                            |

## Мониторинг и наблюдаемость

| Скрипт                                | Назначение                                                          |
| ------------------------------------- | ------------------------------------------------------------------- |
| `monitoring/`                         | Конфиги Prometheus/Alertmanager/Grafana/postgres-exporter.          |
| `disk-cleanup.sh`, `install-disk-cron.sh` | Очистка диска + установка cron.                                  |
| `server-check.sh`                     | Быстрый health-check сервера.                                       |
| `update-node.sh`                      | Обновление Node на сервере.                                         |

## Локальные хуки / dev

| Скрипт                                | Назначение                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `hooks/`, `install-hooks.sh`          | Git-хуки.                                                                                   |
| `pre-merge-check.sh`, `post-merge-restart.sh` | Подготовка/восстановление после merge.                                            |
| `setup-worktree.sh`, `prevent-worktree-install.sh`, `check-agent-conflict.sh` | Worktree-инфра агентов.                                  |
| `detect-stuck-tasks.sh`               | Поиск зависших задач трекера.                                                               |
| `interactive-screenshot.js`           | Интерактивный screenshot-runner (legacy, замещается `screenshot.mjs`).                      |
| `record-verification.js`              | Запись Playwright-сессий для верификации.                                                   |
| `label-issues.py`                     | Массовая проставка labels в трекере.                                                        |

## Обновление документации

При добавлении нового скрипта:
1. Добавь строку в соответствующий раздел этого README.
2. В шапке скрипта — usage + назначение + ADR/тикет, если применимо.
3. Если скрипт меняет поведение, требующее ротации/runbook'а — отдельный
   `*-runbook.md` или `*-rotation.md` рядом.
