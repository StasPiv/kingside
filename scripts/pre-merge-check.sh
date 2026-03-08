#!/usr/bin/env bash
# Pre-merge проверка: валидирует ветку перед merge в main.
# Использование: ./scripts/pre-merge-check.sh
#
# Проверки:
# 1. Ветка соответствует конвенции feature/KS-XX
# 2. Ветка актуальна относительно main (нет отстающих коммитов)
# 3. Нет конфликтов с main (dry-run merge)
#
# Exit codes:
#   0 — все проверки пройдены
#   1 — проверка провалена

set -euo pipefail

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
MAIN_BRANCH="main"

echo "=== Pre-Merge Check ==="
echo "Branch: ${CURRENT_BRANCH}"
echo ""

# --- Check 1: Branch naming convention ---
if [[ ! "$CURRENT_BRANCH" =~ ^feature/KS-[0-9]+$ ]]; then
    echo "WARNING: Branch '${CURRENT_BRANCH}' does not follow convention 'feature/KS-XX'" >&2
    echo "Expected format: feature/KS-<number>" >&2
    # Warning only, not blocking — worktree branches may have different names
fi

# --- Check 2: Main branch is up to date ---
echo "Fetching latest main..."
git fetch origin "${MAIN_BRANCH}" 2>/dev/null || echo "WARNING: Could not fetch origin/${MAIN_BRANCH}"

BEHIND=$(git rev-list --count "${CURRENT_BRANCH}..origin/${MAIN_BRANCH}" 2>/dev/null || echo "0")
if [[ "$BEHIND" -gt 0 ]]; then
    echo "WARNING: Current branch is ${BEHIND} commit(s) behind origin/${MAIN_BRANCH}" >&2
    echo "Consider running: git rebase origin/${MAIN_BRANCH}" >&2
    echo ""
fi

# --- Check 3: Dry-run merge to detect conflicts ---
echo "Checking for merge conflicts with ${MAIN_BRANCH}..."

# Stash any uncommitted changes
STASH_NEEDED=false
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    STASH_NEEDED=true
    git stash push -m "pre-merge-check-temp" >/dev/null 2>&1
fi

# Try merge in dry-run mode
MERGE_OK=true
git merge --no-commit --no-ff "${MAIN_BRANCH}" >/dev/null 2>&1 || MERGE_OK=false
git merge --abort 2>/dev/null || true

# Restore stashed changes
if [[ "$STASH_NEEDED" == "true" ]]; then
    git stash pop >/dev/null 2>&1 || true
fi

if [[ "$MERGE_OK" == "false" ]]; then
    echo "ERROR: Merge conflicts detected with ${MAIN_BRANCH}!" >&2
    echo "Resolve conflicts before merging." >&2
    echo "Run: git rebase ${MAIN_BRANCH}" >&2
    exit 1
fi

echo ""
echo "OK: All pre-merge checks passed."
exit 0
