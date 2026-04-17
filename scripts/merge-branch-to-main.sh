#!/bin/bash
# Мердж произвольной ветки в main с возвратом на исходную ветку.
#
# Назначение: использовать как безопасная операция мерджа из webhook-сервера
# или вручную с хоста. Сохраняет текущую рабочую ветку, переключается на main,
# делает git merge <branch>, возвращается обратно.
#
# Причина: прежний /merge endpoint webhook-сервера выполнял `git merge <branch>`
# в текущей рабочей директории без checkout main — если webhook застрял на
# feature-ветке, merge фактически был в саму себя ("Already up to date.").
#
# Использование:
#   bash scripts/merge-branch-to-main.sh <branch> [--keep-branch]
#
# Опции:
#   --keep-branch  остаться на main после мерджа (не возвращаться на исходную)
#
# Коды возврата:
#   0  — мердж прошёл успешно или ветка уже смерджена.
#   1  — ошибка (конфликт, грязный worktree, несуществующая ветка и т.д.).
#
# Ограничения:
#   - Не делает push.
#   - Не резолвит конфликты — при конфликте прерывает merge и возвращается на
#     исходную ветку, чтобы не оставлять репо в состоянии MERGING.
#   - Требует чистого worktree (git status --porcelain пусто) — иначе exit 1.

set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <branch> [--keep-branch]" >&2
    exit 2
fi

SOURCE_BRANCH="$1"
KEEP_BRANCH=0
if [ "${2:-}" = "--keep-branch" ]; then
    KEEP_BRANCH=1
fi

# Проверка: в git-репо
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "ERROR: не git-репо: $(pwd)" >&2
    exit 1
fi

# Исходная ветка (чтобы вернуться)
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$ORIG_BRANCH" = "HEAD" ]; then
    echo "ERROR: detached HEAD, откажусь мерджить" >&2
    exit 1
fi

# Проверка: чистый worktree
if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: грязный worktree, сначала закоммить/spрятать изменения:" >&2
    git status --porcelain >&2
    exit 1
fi

# Проверка: ветка-источник существует
if ! git rev-parse --verify --quiet "$SOURCE_BRANCH" >/dev/null; then
    echo "ERROR: ветка '$SOURCE_BRANCH' не найдена" >&2
    exit 1
fi

echo "=== merge-branch-to-main ==="
echo "  source : $SOURCE_BRANCH"
echo "  target : main"
echo "  orig   : $ORIG_BRANCH"
echo ""

# Переключаемся на main
if [ "$ORIG_BRANCH" != "main" ]; then
    echo "  checkout main..."
    git checkout main
fi

# Мердж
echo "  git merge $SOURCE_BRANCH..."
if git merge --no-edit "$SOURCE_BRANCH"; then
    echo "  ✓ merge OK"
    MERGE_RC=0
else
    MERGE_RC=$?
    echo "  ✗ merge failed (rc=$MERGE_RC), отменяю..."
    git merge --abort || true
fi

# Возврат на исходную ветку (если не попросили остаться)
if [ "$KEEP_BRANCH" -eq 0 ] && [ "$ORIG_BRANCH" != "main" ]; then
    echo "  checkout $ORIG_BRANCH (возврат)..."
    git checkout "$ORIG_BRANCH"
fi

if [ "$MERGE_RC" -ne 0 ]; then
    exit 1
fi

echo ""
echo "=== Готово ==="
exit 0
