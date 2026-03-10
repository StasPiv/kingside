#!/usr/bin/env bash
# Обнаруживает зависшие задачи: worktree существует, но не было коммитов дольше TTL.
# Использование: ./scripts/detect-stuck-tasks.sh [TTL_HOURS]
#
# По умолчанию TTL = 2 часа. Если последний коммит в worktree старше TTL —
# задача считается потенциально зависшей.
#
# Exit codes:
#   0 — зависших задач не найдено
#   1 — найдены зависшие задачи

set -euo pipefail

TTL_HOURS="${1:-2}"
TTL_SECONDS=$((TTL_HOURS * 3600))
NOW=$(date +%s)
STUCK_COUNT=0

echo "=== Stuck Task Detection (TTL: ${TTL_HOURS}h) ==="
echo ""

while IFS= read -r line; do
    WT_PATH="$(echo "$line" | awk '{print $1}')"
    WT_COMMIT="$(echo "$line" | awk '{print $2}')"
    WT_BRANCH="$(echo "$line" | sed 's/.*\[\(.*\)\].*/\1/')"

    # Only check feature branches (skip main)
    if [[ ! "$WT_BRANCH" =~ ^feature/KS-[0-9]+ && ! "$WT_BRANCH" =~ ^worktree- ]]; then
        continue
    fi

    # Extract task ID from branch name
    TASK_ID=""
    if [[ "$WT_BRANCH" =~ (KS-[0-9]+) ]]; then
        TASK_ID="${BASH_REMATCH[1]}"
    else
        continue
    fi

    # Get last commit timestamp in this worktree
    LAST_COMMIT_TS=$(git -C "$WT_PATH" log -1 --format="%ct" 2>/dev/null || echo "0")

    if [[ "$LAST_COMMIT_TS" == "0" ]]; then
        echo "STUCK: ${TASK_ID} (${WT_PATH})"
        echo "  Branch: ${WT_BRANCH}"
        echo "  Reason: No commits found"
        echo ""
        STUCK_COUNT=$((STUCK_COUNT + 1))
        continue
    fi

    AGE_SECONDS=$((NOW - LAST_COMMIT_TS))
    AGE_HOURS=$((AGE_SECONDS / 3600))
    AGE_MINUTES=$(( (AGE_SECONDS % 3600) / 60 ))

    if [[ $AGE_SECONDS -gt $TTL_SECONDS ]]; then
        echo "STUCK: ${TASK_ID} (${WT_PATH})"
        echo "  Branch: ${WT_BRANCH}"
        echo "  Last commit: ${AGE_HOURS}h ${AGE_MINUTES}m ago"
        echo "  Commit: ${WT_COMMIT}"
        echo ""
        STUCK_COUNT=$((STUCK_COUNT + 1))
    fi
done < <(git worktree list 2>/dev/null)

echo "---"
if [[ $STUCK_COUNT -gt 0 ]]; then
    echo "Found ${STUCK_COUNT} potentially stuck task(s)."
    echo ""
    echo "To resolve:"
    echo "  1. Check Jira status of the task"
    echo "  2. If agent crashed: transition task back to 'To Do' in Jira"
    echo "  3. Remove stale worktree: git worktree remove <path>"
    exit 1
else
    echo "No stuck tasks found."
    exit 0
fi
