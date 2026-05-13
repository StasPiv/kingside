# Автодеплой через git hooks (KS-447)

## Описание

При каждом коммите или мерже в ветку `main` автоматически запускается деплой на сервер kamatera-chess (chess-analyze.online) через `scripts/deploy-local.sh`.

## Реализация

- `scripts/hooks/post-deploy-hook` — основной хук-скрипт (отслеживается в репозитории)
- `scripts/install-hooks.sh` — скрипт установки хуков

Хук проверяет текущую ветку: если это не `main`, деплой не запускается.

## Установка (один раз на каждой машине)

```bash
bash scripts/install-hooks.sh
```

Создаёт симлинки в `.git/hooks/`:
- `post-commit` → `scripts/hooks/post-deploy-hook`
- `post-merge` → `scripts/hooks/post-deploy-hook`

## Работа хука

1. `post-commit` — срабатывает при каждом `git commit` на ветке `main`
2. `post-merge` — срабатывает при `git merge <branch>` находясь на `main`

Оба хука запускают `scripts/deploy-local.sh`, который:
- Собирает frontend локально (`npm run build --workspace=apps/web`)
- Синхронизирует исходники через rsync на kamatera-chess
- Деплоит frontend статику в `/var/www/kingside`
- Пересобирает и перезапускает API контейнер на сервере
- Перезагружает nginx

## Причина фикса (KS-451)

До этого хук вызывал `deploy-local.sh --skip-frontend-build`. Из-за этого при мерже
frontend-изменений в `main` старый `dist` попадал на прод без пересборки. Флаг убран.

## Требования

- SSH доступ к `kamatera-chess` (настроен в `~/.ssh/config`)
- `scripts/deploy-local.sh` работоспособен (см. `docs/devops/kamatera-deploy-guide.md`)
