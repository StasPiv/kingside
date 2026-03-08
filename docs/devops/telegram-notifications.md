# Telegram-уведомления по задачам Jira

## Описание

Webhook-сервер (`webhook-server.py`) обеспечивает двустороннюю связь между Jira и Telegram:

**Jira → Telegram** (уведомления):
- Создание задачи (`jira:issue_created`)
- Обновление задачи (`jira:issue_updated`) — статус, исполнитель, приоритет, метки
- Новый комментарий (`comment_created`)

**Telegram → Jira** (комментарии):
- Сообщения из Telegram-чата автоматически пересылаются как комментарии в задачу Jira (по умолчанию KS-118)
- В каждом комментарии добавляется тег `@coordinator`
- Формат: `[Telegram] @username: текст сообщения`

## Настройка

### 1. Переменные окружения

```bash
# Telegram
TELEGRAM_BOT_TOKEN=<токен от @BotFather>
TELEGRAM_CHAT_ID=<ID чата или группы>

# Jira API (для отправки комментариев из Telegram)
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=<email аккаунта Jira>
JIRA_API_TOKEN=<API-токен Jira>
JIRA_TARGET_ISSUE=KS-118
```

Если `TELEGRAM_BOT_TOKEN` не задан — уведомления и polling отключены.
Если `JIRA_*` переменные не заданы — пересылка в Jira отключена.

### 2. Получение TELEGRAM_CHAT_ID

1. Добавить бота в группу
2. Отправить любое сообщение в группу
3. Запросить `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Найти `chat.id` в ответе

### 3. Получение JIRA_API_TOKEN

1. Перейти на https://id.atlassian.com/manage-profile/security/api-tokens
2. Создать новый API-токен

### 4. Запуск

Всё работает автоматически при запуске webhook-сервера:

```bash
just webhook
```
