# Централизованное логирование (Grafana Loki)

## Стек

| Компонент | Назначение | Порт |
|-----------|-----------|------|
| **Loki** | Хранение и индексация логов | 3100 |
| **Promtail** | Сбор логов из Docker-контейнеров | 9080 (внутренний) |
| **Grafana** | Веб-интерфейс для просмотра логов | 3002 (настраивается через `GRAFANA_PORT`) |

## Запуск

```bash
docker compose --profile logging up -d
```

Для запуска вместе с API:

```bash
docker compose --profile logging --profile full up -d
```

## Доступ к Grafana

- URL: `http://localhost:3002`
- Логин: `admin` (или `GRAFANA_ADMIN_USER`)
- Пароль: `kingside` (или `GRAFANA_ADMIN_PASSWORD`)

Datasource Loki подключен автоматически через provisioning.

## Просмотр логов

1. Открыть Grafana → Explore
2. Выбрать datasource **Loki**
3. Примеры LogQL-запросов:
   - `{service="api"}` — логи API-сервиса
   - `{service="postgres"}` — логи PostgreSQL
   - `{service="api"} |= "error"` — ошибки в API
   - `{service="api"} | json | level="error"` — фильтрация по уровню (если логи в JSON)

## Конфигурация

- Loki: `infra/loki/loki-config.yml`
- Promtail: `infra/promtail/promtail-config.yml`
- Grafana datasources: `infra/grafana/provisioning/datasources/loki.yml`

## Хранение логов

- Логи хранятся 30 дней (настройка `retention_period` в конфиге Loki)
- Данные персистентны через Docker volume `loki_data`
- Compactor запускается каждые 10 минут для очистки устаревших данных

## Переменные окружения

| Переменная | Значение по умолчанию | Описание |
|-----------|----------------------|----------|
| `GRAFANA_PORT` | `3002` | Порт Grafana |
| `GRAFANA_ADMIN_USER` | `admin` | Логин администратора |
| `GRAFANA_ADMIN_PASSWORD` | `kingside` | Пароль администратора |
