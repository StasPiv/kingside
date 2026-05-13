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

## 9. Хотфикс API (404 на /api/*)

Если на проде возвращается `404 Cannot POST /api/...` — контейнер запущен на устаревшем образе.

```bash
cd ~/kingside
bash scripts/api-hotfix.sh
```

Скрипт выполняет:
1. `git pull origin main`
2. `docker compose build --no-cache api`
3. `docker compose up -d --force-recreate api`
4. Health check `GET /api/health`
5. Проверку `POST /api/puzzle-rush/solve` (ожидается 401, не 404)

### Исправление KS-442 (2026-03-11)

Проблема: `POST /api/puzzle-rush/solve` возвращал 404 на проде.

Причина: API-контейнер работал на устаревшем образе. Контроллер `puzzle-rush`
на сервере имел маршрут `POST /answer`, тогда как frontend обращался к `POST /solve`.

**Важно**: git-репозиторий на сервере находится на начальном коммите (9d60271).
Локальные изменения никогда не пушились на GitHub. `api-hotfix.sh` и `git pull`
не приносят новый код пока не выполнен `git push` на remote.

Применённое исправление (вручную через SSH):
1. Добавлен `@Post('solve')` в контроллер на сервере:
   ```bash
   scp apps/api/src/puzzle-rush/puzzle-rush.controller.ts \
       kamatera-chess:~/kingside/apps/api/src/puzzle-rush/
   ```
2. `docker compose build --no-cache api`
3. `docker compose up -d --force-recreate api`
4. Проверка: `POST /api/puzzle-rush/solve` → 401 (маршрут найден).

---

## 10. Исправление KS-452 (2026-03-12): VITE_API_URL не передавался при продакшен-сборке

### Проблема

После KS-451 (включение сборки frontend в `deploy-local.sh`) на проде перестали
работать логин и регистрация.

**Причина**: frontend собирался локально без явного `VITE_API_URL`.
В коде `apps/web/src/api.ts`:

```ts
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
```

Если переменная не задана при сборке Vite, в бандл запекается `http://localhost:3001`.
Браузер пользователя пытался обращаться к `localhost:3001` — запросы уходили в никуда.

### Исправление

В `scripts/deploy-local.sh` добавлена переменная `PROD_API_URL` и передача в сборку:

```bash
VITE_API_URL="$PROD_API_URL" npm run build --workspace=apps/web
```

По умолчанию `PROD_API_URL=https://chess-analyze.online`. Можно переопределить:

```bash
VITE_API_URL=https://другой-домен.com bash scripts/deploy-local.sh
```

### Как проверить корректность сборки

После деплоя убедиться, что в бандле нет `localhost:3001`:

```bash
grep -o "localhost:3001" /var/www/kingside/assets/*.js && echo "BAD" || echo "OK"
```

---

## 11. Риски

| Риск | Уровень | Митигация |
|------|---------|-----------|
| Нехватка RAM при нагрузке | ⚠️ | Swap 2 GB; ограничения mem_limit |
| Рост диска (логи, Docker-образы) | ⚠️ | `docker system prune` раз в неделю |
| 1 vCPU shared | ⚠️ | `STOCKFISH_MAX_INSTANCES=1` |
| Нет CI/CD | ℹ️ | Деплой через `scripts/deploy.sh` вручную |
