# Dev Bypass — аутентификация в локальном окружении

## Что это

Механизм быстрой аутентификации под тестового пользователя без Google/Facebook OAuth.  
Доступен только когда `DEV_BYPASS_SECRET` задан в окружении API.

## Как использовать

Открыть в браузере:

```
http://localhost:5173/?dev_bypass=secret
```

Фронтенд автоматически вызывает `POST /api/auth/dev-bypass?token=secret`,  
API возвращает JWT, пользователь входит как тестовый аккаунт.

## Переменная окружения

`DEV_BYPASS_SECRET` — секрет, который проверяет endpoint.

В `docker-compose.yml` задано значение по умолчанию `secret`:

```yaml
DEV_BYPASS_SECRET: ${DEV_BYPASS_SECRET:-secret}
```

Переопределить через `.env` в корне проекта:

```
DEV_BYPASS_SECRET=my-custom-secret
```

Тогда URL: `http://localhost:5173/?dev_bypass=my-custom-secret`

## Продакшн

На проде переменная **не должна быть задана** (или задана случайной строкой).  
Endpoint вернёт 403 на любой запрос, если `DEV_BYPASS_SECRET` пуст.

## Диагностика

**403 Invalid secret** — значение `DEV_BYPASS_SECRET` в контейнере API не совпадает с тем, что передаёт фронтенд.  
Проверить:

```bash
docker compose exec api printenv DEV_BYPASS_SECRET
```

Если пусто — перезапустить API после правки `.env`:

```bash
docker compose up -d api
```
