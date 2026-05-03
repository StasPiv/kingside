# Ротация пароля test-аккаунта `__screenshot_agent`

ADR-036 §3.5 (этап E2). Источник: KS-2258.

## Назначение

Пароль prod-аккаунта `__screenshot_agent` (`isTestAccount=true, isHidden=true`)
используется CLI `scripts/screenshot.mjs` (KS-2259) для логина под обычным
юзером и снятия скриншотов с защищённых страниц без прав администратора.

## Места хранения

| Где                             | Что                                                  | Назначение                              |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| AWS SSM Parameter Store         | `/kingside/prod/SCRN_AGENT_PASSWORD` (SecureString)  | Источник истины. Регион `eu-central-1`. |
| Production БД kingside (RDS)    | bcrypt-хеш в `users` где `username='__screenshot_agent'` | Что реально проверяет API на логине.    |
| Env агентского контейнера       | `SCRN_AGENT_PASSWORD`                                | Используется `scripts/screenshot.mjs`.  |

## Расписание ротации

**Каждые 90 дней.** Cron-напоминание не настроено — owner devops, контроль через
`aws ssm describe-parameters --filters Key=Name,Values=/kingside/prod/SCRN_AGENT_PASSWORD --query 'Parameters[0].LastModifiedDate'`.

Принудительная ротация — в любой момент при подозрении на компрометацию,
после ухода человека с доступом к Vault/SSM, после публичного git push с
утечкой (см. процедуру ниже).

## Процедура ротации

Ротация атомарна по следующему ряду шагов:

1. Сгенерировать новый пароль 40 символов (base64, без `/+=`):

   ```bash
   NEW_PASSWORD="$(openssl rand -base64 36 | tr -d '/+=' | head -c 40)"
   echo "len=${#NEW_PASSWORD}"   # должно быть 40
   ```

2. Перезаписать SSM SecureString:

   ```bash
   aws ssm put-parameter \
     --name /kingside/prod/SCRN_AGENT_PASSWORD \
     --value "$NEW_PASSWORD" \
     --type SecureString \
     --overwrite \
     --region eu-central-1
   ```

3. Обновить пароль пользователя в prod БД через `seed:screenshot` (скрипт
   идемпотентный, при повторном запуске обновляет пароль без падения):

   ```bash
   # task-definition revision сейчас — kingside-api:53; для текущего deploy
   # подставь свежий: aws ecs describe-task-definition --task-definition kingside-api --query 'taskDefinition.revision'
   TD_REV=$(aws ecs describe-task-definition --task-definition kingside-api \
     --query 'taskDefinition.revision' --output text --region eu-central-1)
   VPC=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" \
     --query 'Vpcs[0].VpcId' --output text --region eu-central-1)
   SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" \
     "Name=cidr-block,Values=10.0.1.0/24" --query 'Subnets[0].SubnetId' \
     --output text --region eu-central-1)
   SG=$(aws ec2 describe-security-groups --filters \
     "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$VPC" \
     --query 'SecurityGroups[0].GroupId' --output text --region eu-central-1)

   cat > /tmp/seed-overrides.json <<EOF
   {
     "containerOverrides": [
       {
         "name": "kingside-api",
         "command": ["npm","run","seed:screenshot"],
         "environment": [
           {"name": "SCRN_AGENT_PASSWORD", "value": "$NEW_PASSWORD"}
         ]
       }
     ]
   }
   EOF

   TASK_ARN=$(aws ecs run-task \
     --cluster kingside \
     --task-definition "kingside-api:$TD_REV" \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
     --overrides file:///tmp/seed-overrides.json \
     --region eu-central-1 \
     --query 'tasks[0].taskArn' --output text)

   aws ecs wait tasks-stopped --cluster kingside --tasks "$TASK_ARN" --region eu-central-1
   aws ecs describe-tasks --cluster kingside --tasks "$TASK_ARN" --region eu-central-1 \
     --query 'tasks[0].containers[0].exitCode' --output text
   # ожидаем 0; в логе /ecs/kingside-api/<task-id> должно быть
   # "✓ seed-screenshot-account: updated user __screenshot_agent"
   rm -f /tmp/seed-overrides.json
   ```

4. Обновить env агентского контейнера. На хосте (в среде, где запускается
   `webhook-server.py` с агентами):

   ```bash
   # 1) положить новое значение в .env, который читает webhook-server при
   #    запуске агентских контейнеров (точное имя файла см. на хосте).
   sed -i.bak "s|^SCRN_AGENT_PASSWORD=.*|SCRN_AGENT_PASSWORD=$NEW_PASSWORD|" /path/to/agent.env
   # либо вычитывать из SSM в момент старта контейнера (предпочтительно):
   #   SCRN_AGENT_PASSWORD=$(aws ssm get-parameter \
   #     --name /kingside/prod/SCRN_AGENT_PASSWORD --with-decryption \
   #     --region eu-central-1 --query 'Parameter.Value' --output text)
   # 2) перезапустить webhook + агентские контейнеры:
   just webhook-stop && just webhook
   ```

5. Smoke-проверка `scripts/screenshot.mjs` (после KS-2259):

   ```bash
   node scripts/screenshot.mjs \
     --url=https://kingside.site/lobby \
     --out=/tmp/scrn-rotation-check.png \
     --auth=test
   echo "exit=$?"   # 0 — логин работает
   ```

6. Если шаги 1–5 прошли — ротация завершена. Старый пароль больше нигде
   не используется. SSM SecureString хранит только текущий (предыдущая
   версия доступна через `aws ssm get-parameter-history`, но не валидна).

## Что делать при сбое

| Шаг падает | Действие                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2 (SSM)    | Проверить IAM-permissions `kingside-ci`/owner. Старый пароль остаётся в SSM, агент работает. Повторить.                            |
| 3 (RunTask)| `seed:screenshot` exit ≠ 0 → читать `/ecs/kingside-api/<task-id>` в CloudWatch Logs. Откатить SSM на предыдущую версию через `put-parameter --value $(aws ssm get-parameter-history --name ... --query 'Parameters[-2].Value')`. |
| 4 (env)    | Если уже прошёл шаг 3 — старый пароль не валиден. Срочно вычитать новый из SSM и перезапустить агентов.                            |
| 5 (smoke)  | См. шаг 4 — наиболее вероятно env не подхватился.                                                                                  |

## Аварийная процедура (компрометация)

1. Сгенерировать новый пароль (шаг 1 выше).
2. Шаги 2 + 3 — параллельно (или последовательно). После шага 3 старый
   пароль не валиден.
3. Если есть подозрение, что злоумышленник успел залогиниться:
   - инвалидировать active sessions test-аккаунта (через API: revoke refresh
     tokens по `userId=a498048d-fef4-435a-b1a6-08db43928a54`);
   - аудит CloudWatch Logs `/ecs/kingside-api` за период с момента утечки
     до момента ротации — поиск login событий с этим username.

## История

| Дата        | Кто     | Версия SSM | Тикет     | Комментарий                |
| ----------- | ------- | ---------- | --------- | -------------------------- |
| 2026-05-03  | devops  | 1          | KS-2258   | Первичная установка пароля.|
