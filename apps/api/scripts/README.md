# apps/api/scripts

One-off служебные скрипты, которые **не** запускаются регулярно
runtime'ом сервиса. Для тех, что нужны в каждом запуске API,
используется bootstrap-логика модулей (например, `FeatureFlagsService`).

## Список скриптов

| Скрипт | Назначение | Запуск локально | Запуск на проде |
|---|---|---|---|
| `seed-screenshot-account.ts` | KS-2257 — seed аккаунта `__screenshot_agent` для screenshot-tooling | `SCRN_AGENT_PASSWORD=... npm run seed:screenshot --workspace=@kingside/api` | ECS RunTask, см. ниже |

---

## seed-screenshot-account

**Что делает:** идемпотентно создаёт/обновляет в `users` запись
`__screenshot_agent` с флагами `isTestAccount=true`, `isHidden=true` и
паролем из env `SCRN_AGENT_PASSWORD`. Аккаунт публично невидим (фильтр
KS-2256 в публичных endpoints), без админских прав. Используется
screenshot-tooling'ом для авторизации в UI без dev-bypass.

**Идемпотентность:** upsert по `username = '__screenshot_agent'`. При
повторном запуске обновит `passwordHash` (если ротация) и принудительно
вернёт `isTestAccount=true / isHidden=true`.

### Локально

```bash
SCRN_AGENT_PASSWORD='<min-12-chars-random>' \
  npm run seed:screenshot --workspace=@kingside/api
```

`DATABASE_URL` берётся из `apps/api/.env` (тот же, что у dev-API).

### На проде

Скрипт **не запускается** автоматически при деплое. Запуск разовый,
через ECS RunTask на том же task-definition, что и API:

```bash
# 1. Подготовить параметр в SSM (один раз)
aws ssm put-parameter \
  --name '/kingside/prod/SCRN_AGENT_PASSWORD' \
  --value '<min-12-chars-random>' \
  --type SecureString

# 2. Запустить one-off задачу (overrides command + inject env)
aws ecs run-task \
  --cluster kingside \
  --task-definition kingside-api:<latest-rev> \
  --launch-type FARGATE \
  --network-configuration '<production-net-config>' \
  --overrides '{
    "containerOverrides": [{
      "name": "kingside-api",
      "command": ["npm", "run", "seed:screenshot"],
      "environment": [
        {"name": "SCRN_AGENT_PASSWORD", "valueFrom": "/kingside/prod/SCRN_AGENT_PASSWORD"}
      ]
    }]
  }'
```

Конкретные параметры `cluster`, `task-definition`, network — у devops в
`scripts/deploy.sh` и AWS-профиле проекта.

### Проверка

После запуска:

```sql
SELECT id, username, is_test_account, is_hidden
  FROM users
 WHERE username = '__screenshot_agent';
```

Ожидаемо: ровно одна запись с `is_test_account = true`, `is_hidden = true`.

### Безопасность

- Имя `__screenshot_agent` **нельзя** добавлять в `KS_ADMIN_USERS` —
  иначе аккаунт получит admin-доступ к `/admin/*` endpoints.
- Пароль хранится в SSM как `SecureString`, не светится в логах ECS.
- Флаг `isHidden=true` обеспечивает, что аккаунт не появляется в
  публичных leaderboard'ах / search / профилях (KS-2256).
