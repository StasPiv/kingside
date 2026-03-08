# Production-логи API

## Конфигурация

Docker-контейнер `api` использует `json-file` logging driver:
- **max-size**: 50 MB на файл
- **max-file**: 5 файлов (ротация)
- **tag**: `kingside-api`

Логи хранятся в стандартном расположении Docker: `/var/lib/docker/containers/<container-id>/`.

## Просмотр логов

### Через justfile

```bash
# Все логи API
just logs

# Последние 100 строк + follow
just logs-follow

# Только логи Puzzle Rush
just logs-puzzle-rush

# С дополнительными параметрами docker compose logs
just logs --tail=50
just logs --since=1h
just logs --since="2026-03-01"
```

### Напрямую через Docker

```bash
# Все логи
docker compose logs api

# Follow
docker compose logs -f api

# Фильтрация по времени
docker compose logs --since=2h api

# Фильтрация по содержимому
docker compose logs api 2>&1 | grep "PuzzleRushService"
```

## Что логируется

NestJS Logger пишет в stdout контейнера. Для Puzzle Rush доступны:
- Начало/завершение сессий (`Puzzle Rush ended for ...`)
- Ошибки при обработке запросов
- Стандартные HTTP-логи NestJS
