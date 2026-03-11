#!/bin/bash
# Очистка диска перед деплоем на Kamatera Chess (KS-429)
# Цель: освободить диск до уровня менее 80%

set -e

echo "=== Disk usage before cleanup ==="
df -h /

echo ""
echo "=== Removing unused Docker objects ==="
docker system prune -f

echo ""
echo "=== Journal logs disk usage ==="
journalctl --disk-usage

echo ""
echo "=== Vacuuming journal logs (keep max 200M) ==="
journalctl --vacuum-size=200M

echo ""
echo "=== Top disk consumers in /var/log ==="
du -sh /var/log/* 2>/dev/null | sort -hr | head -20

echo ""
echo "=== Disk usage after cleanup ==="
df -h /
