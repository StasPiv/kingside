#!/bin/bash
# Очистка диска на Kamatera Chess (KS-429, KS-515)
# Цель: освободить диск до уровня менее 80%

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== Disk usage before cleanup ==="
df -h /

echo ""
echo "=== Removing unused Docker objects (images, build cache) ==="
docker system prune -af --volumes 2>/dev/null || docker system prune -f

echo ""
echo "=== Removing Docker builder cache ==="
docker builder prune -f 2>/dev/null || true

echo ""
echo "=== Cleaning up Claude agent worktrees ==="
if [ -d "$REPO_DIR/.claude/worktrees" ]; then
    WSIZE=$(du -sh "$REPO_DIR/.claude/worktrees" 2>/dev/null | awk '{print $1}')
    rm -rf "$REPO_DIR/.claude/worktrees"
    echo "  Removed .claude/worktrees ($WSIZE)"
fi

echo ""
echo "=== Cleaning up git worktrees (KS-*) ==="
if [ -d "$REPO_DIR/.worktrees" ]; then
    WSIZE=$(du -sh "$REPO_DIR/.worktrees" 2>/dev/null | awk '{print $1}')
    rm -rf "$REPO_DIR/.worktrees"
    echo "  Removed .worktrees ($WSIZE)"
fi

echo ""
echo "=== Cleaning up Turbo build cache ==="
if [ -d "$REPO_DIR/.turbo/cache" ]; then
    TSIZE=$(du -sh "$REPO_DIR/.turbo/cache" 2>/dev/null | awk '{print $1}')
    rm -rf "$REPO_DIR/.turbo/cache"
    echo "  Removed .turbo/cache ($TSIZE)"
fi

echo ""
echo "=== Journal logs disk usage ==="
journalctl --disk-usage

echo ""
echo "=== Vacuuming journal logs (keep max 50M) ==="
journalctl --vacuum-size=50M

echo ""
echo "=== Top disk consumers in /var/log ==="
du -sh /var/log/* 2>/dev/null | sort -hr | head -20

echo ""
echo "=== Disk usage after cleanup ==="
df -h /
