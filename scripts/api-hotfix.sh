#!/bin/bash
# Быстрый хотфикс API: пересборка и перезапуск контейнера без фронтенда
# Запуск на сервере: bash scripts/api-hotfix.sh
#
# Предполагает:
# - репозиторий склонирован в ~/kingside
# - docker compose запущен (postgres, redis работают)
#
# Использовать при: 404/502 на / (корневые маршруты API), контейнер упал или собран на старом образе

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Хотфикс API (пересборка + перезапуск) ==="
echo ""

# 0. Проверить диск
DISK_USED=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
echo "[0/4] Диск: ${DISK_USED}% занято"
if [ "$DISK_USED" -ge 85 ]; then
    echo "  WARN: Диск ${DISK_USED}% — запускаем очистку перед сборкой..."
    bash "$REPO_DIR/scripts/disk-cleanup.sh"
fi

# 1. Обновить код
echo "[1/4] Обновление кода..."
cd "$REPO_DIR"
git pull origin main
echo "  Код обновлён."

# 2. Пересобрать образ API
echo "[2/4] Пересборка Docker-образа API..."
docker compose build --no-cache api
echo "  Образ собран."

# 3. Перезапустить только API контейнер
echo "[3/4] Перезапуск контейнера API..."
docker compose up -d --force-recreate api
echo "  Контейнер перезапущен."

# 4. Проверить доступность
echo "[4/4] Проверка готовности API..."
API_READY=0
for i in $(seq 1 30); do
    if curl -sf http://localhost:3001/health &>/dev/null; then
        echo "  API готов (health check OK)."
        API_READY=1
        break
    fi
    sleep 2
done

if [ "$API_READY" -eq 0 ]; then
    echo "  ERROR: health check не прошёл за 60 сек. Логи:"
    docker compose logs api --tail=50
    exit 1
fi

echo ""
echo "=== Проверка маршрутов ==="

# Проверяем публичный endpoint puzzle-rush (без авторизации)
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    "http://localhost:3001/puzzle-rush/leaderboard?timeMode=3" 2>/dev/null || echo "ERR")
if [ "$STATUS" = "200" ]; then
    echo "  GET /puzzle-rush/leaderboard → $STATUS OK"
else
    echo "  GET /puzzle-rush/leaderboard → $STATUS (ожидался 200)"
fi

# Проверяем POST /puzzle-rush/solve (без токена → 401, не 404)
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST http://localhost:3001/puzzle-rush/solve \
    -H "Content-Type: application/json" \
    -d '{"uci":"e2e4"}' 2>/dev/null || echo "ERR")
if [ "$STATUS" = "401" ]; then
    echo "  POST /puzzle-rush/solve → $STATUS (маршрут найден, нет токена — ОК)"
elif [ "$STATUS" = "404" ]; then
    echo "  POST /puzzle-rush/solve → $STATUS FAIL — маршрут не зарегистрирован!"
    echo "  Проверьте: docker compose logs api --tail=100"
    exit 1
else
    echo "  POST /puzzle-rush/solve → $STATUS"
fi

echo ""
echo "Завершено."
