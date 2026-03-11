#!/bin/bash
# Быстрый хотфикс API: пересборка и перезапуск контейнера без фронтенда
# Запуск на сервере: bash scripts/api-hotfix.sh
#
# Предполагает:
# - репозиторий склонирован в ~/kingside
# - docker compose запущен (postgres, redis работают)
#
# Использовать при: 404 на /api/*, контейнер запущен на старом образе

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Хотфикс API (пересборка + перезапуск) ==="
echo ""

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
    if curl -sf http://localhost:3001/api/health &>/dev/null; then
        echo "  API готов (health check OK)."
        API_READY=1
        break
    fi
    sleep 2
done

if [ "$API_READY" -eq 0 ]; then
    echo "  WARN: health check не прошёл за 60 сек — проверьте логи:"
    echo "  docker compose logs api --tail=50"
fi

echo ""
echo "=== Проверка маршрутов ==="

# Проверяем публичный endpoint puzzle-rush (без авторизации)
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    "http://localhost:3001/api/puzzle-rush/leaderboard?timeMode=3" 2>/dev/null || echo "ERR")
if [ "$STATUS" = "200" ]; then
    echo "  GET /api/puzzle-rush/leaderboard → $STATUS OK"
else
    echo "  GET /api/puzzle-rush/leaderboard → $STATUS (ожидался 200)"
fi

# Проверяем POST /api/puzzle-rush/solve (без токена → 401, не 404)
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
    -X POST http://localhost:3001/api/puzzle-rush/solve \
    -H "Content-Type: application/json" \
    -d '{"uci":"e2e4"}' 2>/dev/null || echo "ERR")
if [ "$STATUS" = "401" ]; then
    echo "  POST /api/puzzle-rush/solve → $STATUS (маршрут найден, нет токена — ОК)"
elif [ "$STATUS" = "404" ]; then
    echo "  POST /api/puzzle-rush/solve → $STATUS FAIL — маршрут не зарегистрирован!"
    echo "  Проверьте: docker compose logs api --tail=100"
    exit 1
else
    echo "  POST /api/puzzle-rush/solve → $STATUS"
fi

echo ""
echo "Завершено."
