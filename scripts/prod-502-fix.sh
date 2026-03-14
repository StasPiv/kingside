#!/bin/bash
# Диагностика и устранение 502 Bad Gateway на проде (KS-515)
# Запуск на сервере: bash scripts/prod-502-fix.sh
#
# Проверяет:
# 1. Статус API контейнера
# 2. Логи контейнера
# 3. Свободное место на диске
# 4. Доступность /api/health
# При необходимости — чистит диск и перезапускает API

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Диагностика 502 Bad Gateway ==="
echo ""

# 1. Проверка контейнера API
echo "[1] Статус контейнера API:"
docker compose -f "$REPO_DIR/docker-compose.yml" ps api 2>/dev/null || echo "  docker compose ps failed"
echo ""

# 2. Свободное место на диске
DISK_USED=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
DISK_FREE_GB=$(df -BG / | tail -1 | awk '{print $4}' | tr -d 'G')
echo "[2] Диск: ${DISK_USED}% занято, ${DISK_FREE_GB}GB свободно"

if [ "$DISK_USED" -ge 85 ]; then
    echo "  WARN: Диск критически заполнен — запускаем очистку..."
    bash "$REPO_DIR/scripts/disk-cleanup.sh"
    DISK_USED=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
    DISK_FREE_GB=$(df -BG / | tail -1 | awk '{print $4}' | tr -d 'G')
    echo "  После очистки: ${DISK_USED}% занято, ${DISK_FREE_GB}GB свободно"
fi
echo ""

# 3. Проверка доступности API
echo "[3] Проверка API health endpoint:"
if curl -sf http://localhost:3001/api/health &>/dev/null; then
    echo "  API отвечает (HTTP 200). Причина 502 — nginx?"
    echo "  Проверяем nginx:"
    sudo nginx -t && sudo systemctl reload nginx
    echo "  nginx перезагружен."
    exit 0
else
    echo "  API НЕ отвечает на :3001"
fi
echo ""

# 4. Логи API за последние 100 строк
echo "[4] Последние логи API:"
docker compose -f "$REPO_DIR/docker-compose.yml" logs api --tail=100 2>&1 || true
echo ""

# 5. Перезапуск API
echo "[5] Перезапуск контейнера API..."
cd "$REPO_DIR"
docker compose up -d --force-recreate api

echo "  Ожидание готовности API..."
API_READY=0
for i in $(seq 1 30); do
    if curl -sf http://localhost:3001/api/health &>/dev/null; then
        echo "  API готов (попытка $i)."
        API_READY=1
        break
    fi
    sleep 3
done

if [ "$API_READY" -eq 0 ]; then
    echo ""
    echo "  FAIL: API не стартовал. Требуется пересборка образа:"
    echo "  bash scripts/api-hotfix.sh"
    echo ""
    echo "  Логи:"
    docker compose logs api --tail=50
    exit 1
fi

# 6. Перезагрузка nginx
echo ""
echo "[6] Перезагрузка nginx..."
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== Готово. Проверка: ==="
echo "POST https://chess-analyze.online/api/auth/login"
curl -sf -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST https://chess-analyze.online/api/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrongpassword"}' \
    2>/dev/null || echo "  (401 — маршрут работает, не 502)"
