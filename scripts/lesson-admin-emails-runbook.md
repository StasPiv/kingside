# LESSON_ADMIN_EMAILS — runbook

Связано: KS-1962 (план), KS-1963 (`AdminEmailGuard` на бэке), KS-1973 (выкатка ENV).

> Основной проектный обзор должен жить в `docs/devops/`. До переноса (требует
> ownership architect/coordinator) единственный источник — этот runbook в
> `scripts/`. См. сообщение @coordinator в KS-1973.

## Что это

ENV-переменная API, через которую `AdminEmailGuard` решает, у кого есть доступ
к `/lessons/admin/*` (создание/редактирование курсов, уроков, шагов).
Применяется поверх `JwtAuthGuard`: сначала JWT, затем email сверяется с
whitelist'ом. Если email не в списке — 403.

Зеркало фронтового `VITE_LESSON_EDITOR_EMAILS` (тот ограничивает только UI).
ENV здесь — единственная защита API; в `User` нет поля `role`/`isAdmin`.

## Формат

CSV, регистронезависимо, пробелы вокруг email'ов игнорируются.

```
LESSON_ADMIN_EMAILS=alice@example.com,bob@example.com
```

Спецзначения:

- `*` — разрешить всем аутентифицированным. **Только для тестов**, не для прода.
- Пустая строка / переменная не задана — запрет всем. Безопасный дефолт.

## Где задаётся

### Production (AWS ECS)

Хранится в task-definition `kingside-api` (контейнер `kingside-api`,
`containerDefinitions[0].environment`). Менять через `aws ecs
register-task-definition` + `aws ecs update-service` (см. runbook ниже).

В `scripts/deploy-aws.sh` хелпер `register_new_task_def_with_image` меняет
только `image`. Для изменения env идём отдельным путём — см. runbook ниже.

### Local dev (Docker Compose)

В `docker-compose.yml` для сервисов `api` и `api-green`:

```yaml
LESSON_ADMIN_EMAILS: ${LESSON_ADMIN_EMAILS:-staspivovartsev@gmail.com}
```

Дефолт — email владельца. Переопределить локально через `.env` в корне:

```
LESSON_ADMIN_EMAILS=alice@example.com,bob@example.com
```

## Runbook: добавить/изменить админов в production

```bash
NEW_ADMINS="staspivovartsev@gmail.com,new-admin@example.com"

# 1. Получаем текущий task-def, заменяем env LESSON_ADMIN_EMAILS, регистрируем revision.
export TMP=$(mktemp --suffix=.json)
aws ecs describe-task-definition --task-definition kingside-api \
  --query 'taskDefinition' --output json > /tmp/td-current.json

NEW_ADMINS="$NEW_ADMINS" node -e '
const fs = require("fs");
const td = JSON.parse(fs.readFileSync("/tmp/td-current.json","utf8"));
const target = process.env.NEW_ADMINS;
for (const c of td.containerDefinitions) {
  c.environment = (c.environment || []).filter(e => e.name !== "LESSON_ADMIN_EMAILS");
  c.environment.push({ name: "LESSON_ADMIN_EMAILS", value: target });
}
for (const k of ["taskDefinitionArn","revision","status","compatibilities",
                 "requiresAttributes","registeredAt","registeredBy",
                 "deregisteredAt","enableFaultInjection"]) {
  delete td[k];
}
fs.writeFileSync(process.env.TMP, JSON.stringify(td));
'

NEW_ARN=$(aws ecs register-task-definition --cli-input-json "file://$TMP" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "new revision: $NEW_ARN"
rm -f "$TMP"

# 2. Раскатываем новую revision (image не меняется).
aws ecs update-service --cluster kingside --service kingside-api \
  --task-definition "$NEW_ARN" --force-new-deployment

# 3. Ждём стабилизации и smoke /health.
aws ecs wait services-stable --cluster kingside --services kingside-api
curl -fsS https://api.kingside.site/health
```

Guard читает `process.env` на каждом запросе — перезапуск не требуется.
Rolling deploy ECS подтянет новую revision, новый email доступен сразу.

## Откат

Предыдущая revision task-def — тот же image, другой env:

```bash
PREV_REV=27   # подставить нужное
aws ecs update-service --cluster kingside --service kingside-api \
  --task-definition kingside-api:$PREV_REV --force-new-deployment
aws ecs wait services-stable --cluster kingside --services kingside-api
```

## Проверка текущего значения

```bash
aws ecs describe-task-definition --task-definition kingside-api \
  --query 'taskDefinition.containerDefinitions[0].environment[?name==`LESSON_ADMIN_EMAILS`]' \
  --output json
```

## Перезапуск local dev после изменения `.env`

NestJS watch-mode НЕ реагирует на изменения `apps/api/.env` — нужен touch
исходника, чтобы процесс перечитал ENV:

```bash
touch apps/api/src/main.ts
```

`scripts/hooks/post-deploy-hook` делает то же самое автоматически после
любого коммита в `main` (через установленный `.git/hooks/post-commit`).
Для агентов без RW-доступа к `apps/api/src/` это единственный путь
триггернуть рестарт без прямого `touch`.

## История

| Дата       | Revision | Значение                    | Тикет   |
|------------|----------|-----------------------------|---------|
| 2026-04-26 | 28       | `staspivovartsev@gmail.com` | KS-1973 |
