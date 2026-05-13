# Автодеплой: pipeline и защитные механизмы

_Обновлено в рамках KS-520 (расследование рецидивов нестабильности)_

## Как работает автодеплой

```
git merge feature/KS-XX → main
        ↓
  .git/hooks/post-commit
  (scripts/hooks/post-deploy-hook)
        ↓
  scripts/deploy-local.sh
        ↓
[локально] сборка frontend (vite)
        ↓
[rsync] код → kamatera-chess:~/kingside
  (исключены: .worktrees, .claude, node_modules, .env)
        ↓
[SSH на kamatera-chess]:
  1. disk-cleanup.sh       ← очистка Docker-кэша и worktrees
  2. Проверка диска        ← если >80% занято — ABORT (новое, KS-520)
  3. Сохранить старый образ как :pre-deploy  (новое, KS-520)
  4. docker compose build --no-cache api
  5. docker compose up -d --force-recreate api
  6. Healthcheck /api/health (40×3s = 120s)
     ├─ OK  → деплой завершён
     └─ FAIL → автооткат к :pre-deploy  (новое, KS-520)
        ↓
[SSH] sudo nginx -t && systemctl reload nginx
        ↓
[SSH] install-disk-cron.sh  ← проверка cron (новое, KS-520)
```

## Защитные механизмы (внедрены в KS-520)

### 1. Disk check перед сборкой

Если после очистки на сервере занято >80% диска — деплой прерывается до начала `docker build`.
Продакшен при этом **не затрагивается** (старые контейнеры продолжают работать).

### 2. Автооткат (rollback)

Перед `docker compose build` текущий образ тегируется как `<project>-api:pre-deploy`.
Если API не отвечает на `/api/health` за 120 сек — выполняется откат:
- `docker compose stop api`
- `docker tag <project>-api:pre-deploy <project>-api:latest`
- `docker compose up -d --no-build api`

### 3. Cron-очистка диска

Скрипт `install-disk-cron.sh` запускается автоматически после каждого деплоя.
Гарантирует, что cron-задания установлены:

| Задание | Расписание | Скрипт |
|---------|-----------|--------|
| Очистка диска | `0 3 * * *` (3:00 ежедневно) | `disk-cleanup.sh` |
| Watchdog API | `*/5 * * * *` (каждые 5 мин) | `api-watchdog.sh` |

## Почему случались рецидивы (root cause анализ)

### KS-515 → KS-519: рецидив после "исправления"

1. `disk-cleanup.sh` использовал `docker system prune -af --volumes` — флаг `--volumes`
   потенциально удалял named volumes (postgres_data, redis_data) при остановленных контейнерах.
   **Исправлено**: флаг `--volumes` убран из disk-cleanup.sh (KS-520).

2. Проверка диска отсутствовала — `docker build` стартовал даже при 95% заполненности
   и падал с "no space left on device", оставляя продакшен сломанным.
   **Исправлено**: disk check после cleanup, abort если >80% (KS-520).

3. При падении `docker build` или healthcheck не было отката — запускался сломанный контейнер.
   **Исправлено**: rollback к :pre-deploy (KS-520).

4. Cron не гарантировано устанавливался на сервере — очистка могла не работать.
   **Исправлено**: `install-disk-cron.sh` вызывается в конце каждого деплоя (KS-520).

## Worktrees на продовом сервере

Worktrees (`~/.worktrees/KS-*`) создаются только локально, на dev-машине, через `webhook-server.py`.
На продовый сервер они **не попадают** — rsync исключает `.worktrees` и `.claude`.
`disk-cleanup.sh` удаляет их если каким-либо образом появятся (страховка).

## Ручная диагностика

```bash
# Проверка состояния сервера
ssh kamatera-chess "cd ~/kingside && bash scripts/server-check.sh"

# Проверка cron
ssh kamatera-chess "crontab -l"

# Ручной запуск очистки
ssh kamatera-chess "cd ~/kingside && bash scripts/disk-cleanup.sh"

# Ручной деплой с пропуском frontend-сборки
bash scripts/deploy-local.sh --skip-frontend-build

# Логи API
ssh kamatera-chess "docker compose -f ~/kingside/docker-compose.yml logs api --tail=100"
```
