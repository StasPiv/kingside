# Production логи

## Конфигурация

API-сервис использует Docker json-file logging driver с ротацией:
- Максимальный размер файла: 50MB
- Максимум файлов: 5 (итого до 250MB)
- Тег: `kingside-api`

Файлы логов хранятся в стандартном каталоге Docker:
```
/var/lib/docker/containers/<container-id>/<container-id>-json.log
```

## Команды

```bash
# Последние 100 строк логов API
just logs

# Последние N строк
just logs 500

# Логи в реальном времени
just logs-follow

# Поиск по паттерну (например, ошибки)
just logs-grep "ERROR"
just logs-grep "puzzle-rush"
just logs-grep "Redis"

# Docker compose напрямую
docker compose logs api --since 1h --timestamps
docker compose logs api --since "2024-01-15T10:00:00" --until "2024-01-15T12:00:00"
```

## Уровни логирования NestJS

- `LOG` — штатные операции
- `WARN` — предупреждения
- `ERROR` — ошибки (Redis, Prisma, etc.)

## Примечания

- Логи переживают перезапуск контейнера (json-file driver хранит на хосте)
- При `docker compose down -v` логи НЕ удаляются (они не в volumes)
- При `docker rm` контейнера логи удаляются вместе с ним
