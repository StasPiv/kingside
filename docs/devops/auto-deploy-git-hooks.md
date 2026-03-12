# Автодеплой через git hooks (KS-447)

## Описание

При каждом коммите или мерже в ветку `main` автоматически запускается деплой на сервер kamatera-chess (chess-analyze.online) через `scripts/deploy-local.sh --skip-frontend-build`.

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

Оба хука запускают `scripts/deploy-local.sh --skip-frontend-build`, который:
- Синхронизирует исходники через rsync на kamatera-chess
- Пересобирает и перезапускает API контейнер на сервере
- Перезагружает nginx

## Требования

- SSH доступ к `kamatera-chess` (настроен в `~/.ssh/config`)
- `scripts/deploy-local.sh` работоспособен (см. `docs/devops/kamatera-deploy-guide.md`)
