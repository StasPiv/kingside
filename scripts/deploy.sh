#!/bin/bash
# Деплой Kingside на сервер kamatera-chess
# Запуск: bash scripts/deploy.sh [--skip-build]
#
# Предполагает:
# - репозиторий склонирован в ~/kingside
# - .env настроен
# - nginx и certbot установлены
# - domain настроен в DNS на 63.250.57.89

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIST="$REPO_DIR/apps/web/dist"
WEB_STATIC="/var/www/kingside"
SKIP_BUILD="${1:-}"

echo "=== Деплой Kingside ==="
echo "Репозиторий: $REPO_DIR"
echo ""

# 1. Обновить код
echo "[1/5] Обновление кода..."
cd "$REPO_DIR"
git pull origin main

# 2. Сборка frontend (если не пропускается)
if [ "$SKIP_BUILD" != "--skip-build" ]; then
    echo "[2/5] Сборка frontend..."
    # Генерируем apps/web/.env из VITE_-переменных корневого .env
    # (VITE_DEV_BYPASS_SECRET, VITE_API_URL и др. встраиваются в bundle)
    if [ -f "$REPO_DIR/.env" ]; then
        grep '^VITE_' "$REPO_DIR/.env" > "$REPO_DIR/apps/web/.env" || true
        echo "  Создан apps/web/.env из VITE_-переменных корневого .env"
    fi
    npm ci --workspace=apps/web
    npm run build --workspace=apps/web
else
    echo "[2/5] Сборка frontend пропущена (--skip-build)"
fi

# 3. Деплой статики frontend
echo "[3/5] Деплой frontend в $WEB_STATIC..."
if [ ! -d "$WEB_DIST" ]; then
    echo "ERROR: $WEB_DIST не найден. Запустите без --skip-build."
    exit 1
fi
sudo mkdir -p "$WEB_STATIC"
sudo rsync -a --delete "$WEB_DIST/" "$WEB_STATIC/"
echo "  Frontend обновлён."

# 4. Пересборка и перезапуск API
echo "[4/5] Перезапуск API контейнеров..."
docker compose pull postgres redis 2>/dev/null || true
docker compose build api
docker compose up -d postgres redis api

# Ждём готовности API (global prefix = /api)
echo "  Ожидание готовности API..."
API_READY=0
for i in $(seq 1 30); do
    if curl -sf http://localhost:3001/api/health &>/dev/null; then
        echo "  API готов."
        API_READY=1
        break
    fi
    sleep 2
done
if [ "$API_READY" -eq 0 ]; then
    echo "  WARN: API health check не прошёл за 60 сек — проверьте docker compose logs api"
fi

# 5. Перезагрузка nginx
echo "[5/5] Перезагрузка nginx..."
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "✅ Деплой завершён."
echo ""
echo "Проверка:"
echo "  docker ps"
echo "  docker stats --no-stream"
echo "  bash scripts/server-check.sh"
