# Мониторинг — Prometheus / Alertmanager / Grafana

Настроено по KS-1635 (ADR-016 §Этап 6) и ADR-014 §1.4.
Self-hosted deployment — по KS-1638.

## Prod-инстанс (self-hosted)

Развёрнут на EC2 t3.small в том же VPC, что ECS/RDS.

| Параметр           | Значение                                            |
| ------------------ | --------------------------------------------------- |
| Регион             | eu-central-1                                        |
| VPC / Subnet       | kingside-vpc (vpc-0d0d9344db8d11e7e) / kingside-public-a |
| Instance           | tag `Name=kingside-monitoring` (t3.small, AL2023)   |
| IAM role           | `kingside-monitoring-ec2` (SSM + ECS read + Secrets + SSM param) |
| SG                 | `kingside-monitoring-sg`                            |
| Elastic IP         | tag `Name=kingside-monitoring-eip`                  |
| Grafana URL        | `http://<EIP>:3000`                                 |
| Prometheus URL     | `http://<EIP>:9090`                                 |
| Alertmanager URL   | `http://<EIP>:9093`                                 |
| Grafana admin pwd  | SSM parameter `/kingside/monitoring/grafana_admin_password` (SecureString) |
| Systemd unit       | `kingside-monitoring.service` (автозапуск compose)  |

**Как попасть в shell EC2** (без SSH, через SSM Session Manager):

```bash
aws ssm start-session --target <instance-id> --region eu-central-1
```

**Как проверить состояние:**

```bash
curl http://<EIP>:9090/-/healthy         # Prometheus
curl http://<EIP>:9093/-/healthy         # Alertmanager
curl http://<EIP>:3000/api/health        # Grafana
curl http://<EIP>:9090/api/v1/targets    # все scrape targets
```

## Deploy / Redeploy

```bash
# Развернуть с нуля (идемпотентно — повторный запуск не создаёт дубликатов)
bash scripts/monitoring/deploy-ec2.sh

# Обновить конфиги после правки (без пересоздания EC2):
#   1. Запакуй tarball и залей в S3
bash scripts/monitoring/deploy-ec2.sh   # первые шаги обновят tarball в S3
#   2. На EC2 скачай и перезапусти compose (через SSM):
aws ssm send-command --region eu-central-1 \
  --instance-ids <i-...> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/kingside-monitoring && aws s3 cp s3://kingside-frontend-342946498289/monitoring/configs.tar.gz /tmp/c.tar.gz --region eu-central-1 && tar -xzf /tmp/c.tar.gz -C /opt/kingside-monitoring && docker compose -f compose.monitoring.yml --env-file .env up -d"]'

# Полностью удалить (terminate instance, release EIP; SG/IAM остаются)
bash scripts/monitoring/deploy-ec2.sh --destroy
```

## Два режима compose

- `docker-compose.yml` profile `monitoring` (dev/локально) — для разработки; все сервисы в одном Docker-хосте, Postgres внутренний.
- `scripts/monitoring/compose.monitoring.yml` (prod self-hosted) — для EC2; подключается к внешнему RDS, использует ECS Service Discovery через sidecar `ecs-discovery`.

## ECS Service Discovery

Координатор в KS-1638 отметил: публичный ALB скрейпить **нельзя** — per-process counters prom-client балансируются между инстансами ECS и отдают случайные слайсы. Поэтому:

1. Sidecar `ecs-discovery` (на базе `amazon/aws-cli:2.17.37` + `jq`) каждые 60 секунд читает ECS API (`ListTasks` + `DescribeTasks`).
2. Генерирует файл `/etc/prometheus/targets/kingside-api.json` с массивом `{targets: ["10.0.2.124:3001"], labels: {task_arn, task_id, ecs_health}}`.
3. Prometheus через `file_sd_config` (`refresh_interval: 30s`) подхватывает обновления — добавление/удаление тасок при rolling deploy обрабатывается без ручного вмешательства.

Требования к IAM-роли EC2:
- `ecs:ListTasks`, `ecs:DescribeTasks`, `ec2:DescribeNetworkInterfaces`.
- `secretsmanager:GetSecretValue` на `kingside/api` (для bootstrap).
- `s3:GetObject` на `kingside-frontend-<acct>/monitoring/*`.
- `ssm:PutParameter`/`GetParameter` на `/kingside/monitoring/*`.
- `AmazonSSMManagedInstanceCore` (для Session Manager).

SG: `kingside-monitoring-sg` получает inbound к `kingside-ecs-sg:3001` и `rds-sg:5432` (прописано в `deploy-ec2.sh`).

## Дев (docker-compose profile `monitoring`)

## Стек

| Сервис              | Образ                                                   | Порт (по умолчанию) | Профиль       |
| ------------------- | ------------------------------------------------------- | ------------------- | ------------- |
| prometheus          | `prom/prometheus:v2.54.1`                               | `9090`              | `monitoring`  |
| alertmanager        | `prom/alertmanager:v0.27.0`                             | `9093`              | `monitoring`  |
| postgres-exporter   | `quay.io/prometheuscommunity/postgres-exporter:v0.15.0` | `9187`              | `monitoring`  |
| grafana             | `grafana/grafana:11.5.2`                                | `3002`              | `logging` + `monitoring` |
| loki / promtail     | `grafana/loki:3.4.2`, `grafana/promtail:3.4.2`          | `3100` / internal   | `logging`     |

## Запуск

```bash
# Только мониторинг (Prometheus + Alertmanager + postgres-exporter + Grafana)
docker compose --profile monitoring up -d

# Мониторинг + логи (добавит loki / promtail)
docker compose --profile monitoring --profile logging up -d

# Полный стек (с API)
docker compose --profile monitoring --profile logging up -d
```

## Переменные окружения

В `.env` (либо в systemd-unit на проде):

```env
# Alertmanager → Telegram
TELEGRAM_BOT_TOKEN=<токен от @BotFather>  # тот же, что для webhook-server (docs/devops/telegram-notifications.md)
TELEGRAM_CHAT_ID=<chat_id>                # int64, положительный для users, отрицательный для групп

# Порты (опционально, значения по умолчанию подходят для dev)
PROMETHEUS_PORT=9090
ALERTMANAGER_PORT=9093
POSTGRES_EXPORTER_PORT=9187
GRAFANA_PORT=3002
```

При запуске контейнера alertmanager плейсхолдеры `__TELEGRAM_BOT_TOKEN__`
и `__TELEGRAM_CHAT_ID__` в `alertmanager.yml.tpl` заменяются через `sed` на
значения из env (entrypoint контейнера).

## Правила алёртов (`scripts/monitoring/prometheus/rules/archive.yml`)

### `ArchiveTreeListMismatch` (critical)
- **PromQL:** `increase(archive_tree_list_mismatch_total[5m]) > 0`
- **Источник метрики:** API, counter `archive_tree_list_mismatch_total{bucket}` (KS-1634, `archive-metrics.service.ts`).
- **Условие:** любое срабатывание `fail-closed guard` в `/archive/games/by-position` (items=[] && totalApprox>0).
- **Runbook:** `docs/adr/016-archive-tree-list-ply-sync.md` §Этап 4.

### `ArchiveGamePositionsSizeWarn` (warning)
- **PromQL:** `pg_archive_table_total_bytes{relname="archive_game_positions"} > 20 * 1024 * 1024 * 1024`
- **Источник метрики:** postgres-exporter, кастомный запрос `pg_archive_table` (`scripts/monitoring/postgres-exporter/queries.yaml`).
- **Условие:** размер таблицы (heap + indexes + toast) превышает 20 GB — триггер на партиционирование по ADR-014 §1.4.
- **Runbook:** `docs/adr/014-archive-games-by-position.md` §1.4.

### `ArchiveListPositionNotIndexed` (warning)
- **PromQL:** `increase(archive_games_list_position_not_indexed_total[15m]) > 0`
- **Источник метрики:** API, counter (если зарегистрирован; при отсутствии — алёрт просто молчит).
- **Условие:** пользовательские запросы на позиции за пределами индекса. Во время backfill KS-1636 — ожидаемо.

## Дашборд

`Kingside → Archive — ply-sync (archive_game_positions)` (`uid=archive-ply-sync`):

1. **Size (table + indexes + total)** — pg_table_size, pg_indexes_size, pg_total_relation_size + порог 20 GB.
2. **Total size now** — stat-панель с цветовыми порогами (green <15 GB, yellow 15–20, red >20 GB).
3. **n_live_tup / n_dead_tup** — live/dead rows из pg_stat_user_tables.
4. **Insert rate (rows/min)** — rate(n_tup_ins[1m]) * 60; полезно во время backfill, чтобы видеть прогресс (~30–60k rows/min при COPY).
5. **archive_tree_list_mismatch_total** — bar chart по bucket, окрашивание в красный при >0.
6. **archive_games_list_position_not_indexed_total** — bar chart по bucket.
7. **archive.list.mismatch warn-логи** — Loki LogQL-панель для ручного разбора инцидентов.

## Зависимости на backend

Метрики, которые scrape'ит Prometheus с API, обязаны экспонироваться в
prometheus text-формате на `/api/metrics`. На момент написания (2026-04-21):

- Endpoint `/api/metrics` — **не экспонирован** (404 на проде, подтверждено `curl`).
- Метрика `archive_tree_list_mismatch_total{bucket}` зарегистрирована как
  in-memory counter (`archive-metrics.service.ts`, KS-1634), но в prom-формате
  наружу не выводится.
- Для полноценного срабатывания `ArchiveTreeListMismatch` нужен endpoint
  `/api/metrics` (prom-client → `register.metrics()`) и прокидывание счётчиков
  из `ArchiveMetricsService` в glоbal `prom-client` registry.

Эта часть — в ответственности backend-агента (отдельная задача). Инфра к
интеграции готова: как только endpoint появится, Prometheus начнёт скрейпить
по job `kingside-api`, и алёрты активируются без дополнительных изменений.

## Проверка после деплоя

1. `curl http://localhost:9090/-/ready` → `Prometheus Server is Ready.`
2. `curl http://localhost:9093/-/ready` → `OK`.
3. `curl http://localhost:9187/metrics | grep pg_archive_table_total_bytes` → строка с `relname="archive_game_positions"`.
4. В Grafana (`:3002`) — datasources Prometheus/Postgres/Loki помечены зелёными, дашборд `Archive — ply-sync` открывается.
5. Симуляция `ArchiveTreeListMismatch` (после добавления `/api/metrics`):

   ```bash
   # увеличить счётчик руками (через тестовый endpoint или миграцию БД)
   # затем проверить:
   curl -s 'http://localhost:9090/api/v1/query?query=increase(archive_tree_list_mismatch_total[5m])' | jq
   # > 0 должен поднять алёрт в течение минуты
   ```

## Ограничения / открытые вопросы

- Grafana Alerting (встроенный) не используется — все алёрты идут через Alertmanager. Если в будущем понадобится SLO-мониторинг на основе логов (Loki LogQL) — проще добавить Grafana Alerting rule, чем строить отдельный log-to-metric pipeline.
- Prometheus retention 15 дней — хватает для оперативного анализа, но не для quarterly-отчётов. При необходимости — включить remote_write в Thanos / Mimir.
- Alertmanager `high availability` не настроен — один инстанс. Для prod допустимо, т.к. дедупликация работает внутри одного AM.
- postgres-exporter подключается под тем же пользователем, что и API. В проде рекомендуется создать read-only роль `postgres_exporter` с правами на `pg_stat_user_tables`, `pg_class`, `pg_namespace` и сменить `DATA_SOURCE_NAME` на неё.
