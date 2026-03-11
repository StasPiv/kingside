#!/bin/bash
# Проверка готовности сервера kamatera-chess к деплою Kingside
# Запуск: bash scripts/server-check.sh

set -euo pipefail

PASS=0
WARN=0
FAIL=0

ok()   { echo "  [OK]   $1"; PASS=$((PASS+1)); }
warn() { echo "  [WARN] $1"; WARN=$((WARN+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "=== Проверка готовности сервера к деплою Kingside ==="
echo ""

# Docker
echo "--- Docker ---"
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}' | tr -d ',')
    ok "Docker установлен ($DOCKER_VERSION)"
else
    fail "Docker не установлен или не запущен"
fi

if docker compose version &>/dev/null 2>&1; then
    COMPOSE_VERSION=$(docker compose version --short)
    ok "Docker Compose установлен ($COMPOSE_VERSION)"
else
    fail "Docker Compose не установлен"
fi

# Nginx
echo ""
echo "--- Nginx ---"
if command -v nginx &>/dev/null && systemctl is-active --quiet nginx 2>/dev/null; then
    NGINX_VERSION=$(nginx -v 2>&1 | awk -F'/' '{print $2}')
    ok "nginx запущен ($NGINX_VERSION)"
else
    fail "nginx не запущен"
fi

if [ -f /etc/nginx/sites-available/kingside ]; then
    ok "nginx конфиг kingside установлен"
else
    warn "nginx конфиг не установлен (/etc/nginx/sites-available/kingside)"
fi

# SSL
echo ""
echo "--- SSL ---"
if command -v certbot &>/dev/null; then
    ok "certbot установлен"
else
    warn "certbot не установлен (нужен для HTTPS)"
fi

# Диск
echo ""
echo "--- Диск ---"
DISK_USED=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
DISK_FREE_GB=$(df -BG / | tail -1 | awk '{print $4}' | tr -d 'G')
if [ "$DISK_USED" -lt 80 ]; then
    ok "Диск заполнен на ${DISK_USED}% (свободно ${DISK_FREE_GB} GB)"
elif [ "$DISK_USED" -lt 90 ]; then
    warn "Диск заполнен на ${DISK_USED}% (свободно ${DISK_FREE_GB} GB)"
else
    fail "Диск заполнен на ${DISK_USED}% — риск нехватки места"
fi

# RAM
echo ""
echo "--- RAM ---"
MEM_AVAIL_MB=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "$MEM_AVAIL_MB" -ge 300 ]; then
    ok "Доступно RAM: ${MEM_AVAIL_MB} MB"
elif [ "$MEM_AVAIL_MB" -ge 150 ]; then
    warn "Доступно RAM: ${MEM_AVAIL_MB} MB (мало, swap может использоваться)"
else
    fail "Доступно RAM: ${MEM_AVAIL_MB} MB — недостаточно"
fi

# Порты
echo ""
echo "--- Порты ---"
check_port() {
    local port=$1
    local name=$2
    if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
        ok "Порт $port занят ($name)"
    else
        warn "Порт $port не слушается ($name не запущен?)"
    fi
}
check_port 80  "nginx HTTP"
check_port 443 "nginx HTTPS"
check_port 3001 "kingside-api"

# Контейнеры
echo ""
echo "--- Docker контейнеры ---"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "kingside-postgres"; then
    ok "kingside-postgres запущен"
else
    warn "kingside-postgres не запущен"
fi
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "kingside-redis"; then
    ok "kingside-redis запущен"
else
    warn "kingside-redis не запущен"
fi
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "kingside-api"; then
    ok "kingside-api запущен"
else
    warn "kingside-api не запущен"
fi

# .env файл
echo ""
echo "--- Конфигурация ---"
if [ -f .env ]; then
    ok ".env файл найден"
    if grep -q "JWT_SECRET=change-me" .env 2>/dev/null; then
        fail "JWT_SECRET не изменён (change-me-in-production)"
    else
        ok "JWT_SECRET задан"
    fi
else
    fail ".env файл не найден"
fi

# Frontend
echo ""
echo "--- Frontend ---"
if [ -d /var/www/kingside ] && [ -f /var/www/kingside/index.html ]; then
    ok "Frontend задеплоен в /var/www/kingside"
else
    warn "Frontend не задеплоен в /var/www/kingside"
fi

# Итог
echo ""
echo "=== Итог ==="
echo "  OK:   $PASS"
echo "  WARN: $WARN"
echo "  FAIL: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "❌ Сервер НЕ готов к деплою. Устраните FAIL-пункты."
    exit 1
elif [ "$WARN" -gt 0 ]; then
    echo "⚠️  Сервер готов к деплою, но есть предупреждения."
    exit 0
else
    echo "✅ Сервер готов к деплою."
    exit 0
fi
