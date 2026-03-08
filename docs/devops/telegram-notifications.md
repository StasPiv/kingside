# Telegram-уведомления по задачам Jira

## Описание

Webhook-сервер (`webhook-server.py`) отправляет уведомления в Telegram-чат при следующих событиях Jira:

- Создание задачи (`jira:issue_created`)
- Обновление задачи (`jira:issue_updated`) — статус, исполнитель, приоритет, метки
- Новый комментарий (`comment_created`)

## Настройка

### 1. Переменные окружения

```bash
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_CHAT_ID=<ID чата или группы>
```

Если переменные не заданы, уведомления не отправляются (без ошибок).

### 2. Получение TELEGRAM_CHAT_ID

1. Добавить бота в группу
2. Отправить любое сообщение в группу
3. Запросить `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Найти `chat.id` в ответе

### 3. Запуск

Уведомления работают автоматически при запуске webhook-сервера:

```bash
just webhook
```
