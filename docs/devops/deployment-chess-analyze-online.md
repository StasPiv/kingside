# Деплой Kingside на chess-analyze.online

Дата: 2026-03-11
Задача: KS-437

## Выполненные шаги

### 1. Frontend сборка (локально)
```bash
VITE_API_URL=https://chess-analyze.online npm run build --workspace=apps/web
```

### 2. Деплой статики
```bash
rsync -avz --delete apps/web/dist/ kamatera-chess:/var/www/kingside/
```

### 3. Nginx конфиг
```bash
scp infra/nginx/kingside.conf kamatera-chess:/tmp/kingside.conf
# На сервере:
sudo cp /tmp/kingside.conf /etc/nginx/sites-available/kingside
sudo rm /etc/nginx/sites-enabled/chess-analyze.online
sudo ln -sf /etc/nginx/sites-available/kingside /etc/nginx/sites-enabled/kingside
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Переменные окружения
В `/root/kingside/.env` добавлено:
```
CORS_ORIGIN=https://chess-analyze.online
```

### 5. docker-compose.yml
Обновлён на сервере: добавлена переменная `CORS_ORIGIN` в секцию environment api-сервиса.

### 6. Перезапуск API
```bash
cd ~/kingside && docker compose stop api && docker compose up -d api
```

## Результат

- URL: https://chess-analyze.online
- SSL: Let's Encrypt, действителен до 2026-04-22
- Frontend: статика в `/var/www/kingside/`
- API: Docker-контейнер `kingside-api-1`, порт 3001
- nginx конфиг: `/etc/nginx/sites-available/kingside`

## Состояние сервисов

| Сервис | Статус |
|--------|--------|
| kingside-api-1 | Running |
| kingside-postgres-1 | Running |
| kingside-redis-1 | Running |
| nginx | Active |
| SSL cert | Valid (до 2026-04-22) |
