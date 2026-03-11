#!/bin/bash
# Применить обновлённый nginx конфиг без полного редеплоя
# Запуск на сервере: bash scripts/nginx-hotfix.sh
#
# Предполагает:
# - репозиторий склонирован в ~/kingside
# - nginx настроен и запущен

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_CONF="$REPO_DIR/infra/nginx/kingside.conf"
NGINX_SITES="/etc/nginx/sites-available/kingside"

echo "=== Применение nginx конфига ==="
echo ""

# 1. Обновить код
echo "[1/3] Обновление кода..."
cd "$REPO_DIR"
git pull origin main
echo "  Код обновлён."

# 2. Скопировать конфиг
echo "[2/3] Копирование конфига..."
sudo cp "$NGINX_CONF" "$NGINX_SITES"
echo "  Конфиг скопирован: $NGINX_SITES"

# 3. Проверить и перезагрузить nginx
echo "[3/3] Перезагрузка nginx..."
sudo nginx -t
sudo systemctl reload nginx
echo "  nginx перезагружен."

echo ""
echo "=== Проверка ==="
echo "POST https://chess-analyze.online/api/auth/register"
curl -sf -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST https://chess-analyze.online/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{}' || echo "  (ожидается 400/422, но не 404)"

echo ""
echo "Завершено."
