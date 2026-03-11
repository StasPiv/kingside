# Руководство по деплою Kingside на kamatera-chess

**Сервер**: kamatera-chess
**IP**: 63.250.57.89
**OS**: Ubuntu 22.04.5 LTS
**Задача**: KS-435

---

## 1. Состояние сервера (2026-03-11)

| Ресурс | Значение | Статус |
|--------|----------|--------|
| CPU | 1 vCPU | ⚠️ Shared |
| RAM | 957 MB, ~500 MB свободно | ⚠️ Ограничено |
| Диск | 30 GB, ~7 GB свободно | ✅ После очистки (KS-434) |
| Docker | 27.3.1 + Compose v2.29.7 | ✅ |
| nginx | 1.18.0 | ✅ |

---

## 2. Первый деплой (настройка с нуля)

### 2.1 Клонировать репозиторий

```bash
git clone https://github.com/your-org/kingside.git ~/kingside
cd ~/kingside
```

### 2.2 Настроить .env

```bash
cp .env.example .env
nano .env
```

Обязательно задать:

```env
JWT_SECRET=<случайная строка 32+ символа>
POSTGRES_PASSWORD=<сложный пароль>
CORS_ORIGIN=https://YOUR_DOMAIN
STOCKFISH_MAX_INSTANCES=1
```

### 2.3 Установить nginx конфиг

```bash
sudo cp infra/nginx/kingside.conf /etc/nginx/sites-available/kingside
# Заменить SERVER_NAME на реальный домен
sudo sed -i 's/SERVER_NAME/your-domain.com/g' /etc/nginx/sites-available/kingside
sudo ln -sf /etc/nginx/sites-available/kingside /etc/nginx/sites-enabled/kingside
sudo nginx -t
```

### 2.4 Получить SSL-сертификат

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### 2.5 Создать директорию для frontend

```bash
sudo mkdir -p /var/www/kingside
```

### 2.6 Запустить деплой

```bash
bash scripts/deploy.sh
```

---

## 3. Обновление (повторный деплой)

```bash
cd ~/kingside
bash scripts/deploy.sh
```

Или без пересборки frontend (только API):

```bash
bash scripts/deploy.sh --skip-build
```

---

## 4. Проверка готовности

```bash
bash scripts/server-check.sh
```

---

## 5. Архитектура на сервере

```
Internet → nginx (80/443)
              ├── / → /var/www/kingside (React SPA)
              ├── /api/ → localhost:3001 (NestJS API)
              └── /socket.io/ → localhost:3001 (WebSocket)

Docker Compose:
  kingside-api      (порт 3001, mem_limit 400m)
  kingside-postgres (порт 5432, mem_limit 256m)
  kingside-redis    (порт 6380, mem_limit 64m)
```

---

## 6. Управление контейнерами

```bash
# Статус
docker compose ps
docker stats --no-stream

# Логи API
docker compose logs -f api --tail=100

# Перезапуск
docker compose restart api

# Полная остановка
docker compose down
```

---

## 7. Ограничения ресурсов

Заданы в `docker-compose.yml`:

| Контейнер | mem_limit |
|-----------|-----------|
| api | 400m |
| postgres | 256m |
| redis | 64m |

`STOCKFISH_MAX_INSTANCES=1` — обязательно для 1 vCPU.

---

## 8. Риски

| Риск | Уровень | Митигация |
|------|---------|-----------|
| Нехватка RAM при нагрузке | ⚠️ | Swap 2 GB; ограничения mem_limit |
| Рост диска (логи, Docker-образы) | ⚠️ | `docker system prune` раз в неделю |
| 1 vCPU shared | ⚠️ | `STOCKFISH_MAX_INSTANCES=1` |
| Нет CI/CD | ℹ️ | Деплой через `scripts/deploy.sh` вручную |
