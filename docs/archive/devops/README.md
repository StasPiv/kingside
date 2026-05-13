# docs/archive/devops/

**Эти документы НЕ описывают текущую инфраструктуру.** Архив оставлен для исторического контекста — чтобы можно было понять, какие решения принимались на предыдущем этапе и почему от них отказались.

## Что было до AWS

До текущей инфраструктуры (AWS — S3+CloudFront+ECS+ALB) проект жил на одном VPS у [Kamatera](https://www.kamatera.com/). Деплой шёл через self-hosted git-хуки и серию bash-скриптов. Тот сервер заброшен (см. KS-2956), скрипты удалены из `scripts/` и `justfile`. Документация переехала сюда в рамках KS-2957 (2026-05-13).

## Состав

| Файл | О чём |
|---|---|
| `kamatera-deploy-guide.md` | Полное руководство по деплою на Kamatera VPS. |
| `autodeploy-pipeline.md` | Описание автодеплой-пайплайна через git-хуки. |
| `auto-deploy-git-hooks.md` | Конкретика git-хуков post-receive. |
| `deployment-chess-analyze-online.md` | Деплой ранней инкарнации проекта (домен `chess-analyze-online`). |
| `disk-cleanup-log.md` | Журнал ручных чисток диска на VPS. |
| `disk-cleanup-candidates.md` | Кандидаты на удаление при нехватке места. |
| `server-capacity-assessment.md` | Оценка ёмкости VPS — CPU/RAM/диск под нагрузку. |
| `deploy-readiness-report.md` | Отчёт о готовности к запуску на VPS (исторический). |

## Где смотреть актуальное

- **Текущий деплой**: `scripts/deploy-aws.sh`, MCP-тул `deploy({scope})`.
- **Инфра-обзор**: `docs/adr/045-backend-deploy-perf.md`, `docs/adr/017-service-subdomains.md`, `docs/adr/018-archive-service-extraction.md`, `docs/adr/021-broadcast-service-extraction.md`.
- **Логи/мониторинг (актуальные)**: `docs/devops/centralized-logging.md`, `docs/devops/production-logs.md`.

Если зашёл сюда искать команды для текущего деплоя — это не тот каталог.
