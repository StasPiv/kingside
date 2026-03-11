# Руководство по деплою Kingside на kamatera-chess

**Сервер**: kamatera-chess
**IP**: 63.250.57.89
**OS**: Ubuntu 22.04.5 LTS
**Домен**: chess-analyze.online
**Задача**: KS-435, KS-436

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
cp .env.production.example .env
nano .env
```

Обязательно задать:

```env
JWT_SECRET=<случайная строка 32+ символа>
POSTGRES_PASSWORD=<сложный пароль>
CORS_ORIGIN=https://chess-analyze.online
STOCKFISH_MAX_INSTANCES=1
```

### 2.3 Установить nginx конфиг

```bash
sudo cp infra/nginx/kingside.conf /etc/nginx/sites-available/kingside
sudo ln -sf /etc/nginx/sites-available/kingside /etc/nginx/sites-enabled/kingside
sudo nginx -t
```

Домен `chess-analyze.online` уже прописан в конфиге.

### 2.4 Получить SSL-сертификат

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d chess-analyze.online -d www.chess-analyze.online
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

## 8. Обновление только nginx конфига (hotfix)

Если изменился только `infra/nginx/kingside.conf`, без полного редеплоя:

```bash
cd ~/kingside
bash scripts/nginx-hotfix.sh
```

Скрипт выполняет:
1. `git pull origin main`
2. `sudo cp infra/nginx/kingside.conf /etc/nginx/sites-available/kingside`
3. `sudo nginx -t && sudo systemctl reload nginx`
4. Проверку `POST /api/auth/register`

### Исправление KS-438 (2026-03-11)

Проблема: trailing slash в `proxy_pass http://localhost:3001/` срезал `/api/` префикс — backend получал `/auth/register` вместо `/api/auth/register`.

Исправление (коммит `014b24b`): `proxy_pass http://localhost:3001;` — без trailing slash.

---

## 9. Риски

| Риск | Уровень | Митигация |
|------|---------|-----------|
| Нехватка RAM при нагрузке | ⚠️ | Swap 2 GB; ограничения mem_limit |
| Рост диска (логи, Docker-образы) | ⚠️ | `docker system prune` раз в неделю |
| 1 vCPU shared | ⚠️ | `STOCKFISH_MAX_INSTANCES=1` |
| Нет CI/CD | ℹ️ | Деплой через `scripts/deploy.sh` вручную |
