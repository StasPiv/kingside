#!/usr/bin/env bash
# Проверяет, что для задачи KS-XX не существует активного worktree другого агента.
# Использование: ./scripts/check-agent-conflict.sh KS-201
#
# Механизм:
# 1. Проверяет, есть ли worktree для данной задачи (по имени ветки feature/KS-XX)
# 2. Если worktree существует и это не текущий — выводит предупреждение
# 3. Проверяет Jira-статус задачи (требует curl и JIRA_* переменные)
#
# Exit codes:
#   0 — конфликтов нет, можно работать
#   1 — обнаружен конфликт (активный worktree или задача уже In Progress)
#   2 — ошибка аргументов

set -euo pipefail

TASK_ID="${1:-}"
if [[ -z "$TASK_ID" ]]; then
    echo "Usage: $0 <TASK_ID>" >&2
    echo "Example: $0 KS-201" >&2
    exit 2
fi

# Validate task ID format
if [[ ! "$TASK_ID" =~ ^KS-[0-9]+$ ]]; then
    echo "ERROR: Invalid task ID format: $TASK_ID (expected KS-NNN)" >&2
    exit 2
fi

BRANCH="feature/${TASK_ID}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

echo "=== Agent Conflict Check for ${TASK_ID} ==="

# --- Check 1: Worktree existence ---
CONFLICTS=0
while IFS= read -r line; do
    WT_PATH="$(echo "$line" | awk '{print $1}')"
    WT_BRANCH="$(echo "$line" | sed 's/.*\[\(.*\)\].*/\1/')"

    # Exact match or prefix match (e.g. feature/KS-201, feature/KS-201-wt)
    if [[ "$WT_BRANCH" == "$BRANCH" || "$WT_BRANCH" == "${BRANCH}-"* || "$WT_BRANCH" == "worktree-${BRANCH}" ]]; then
        # Skip if it's the current worktree
        CURRENT_WT="$(pwd)"
        if [[ "$WT_PATH" == "$CURRENT_WT" ]]; then
            continue
        fi
        echo "WARNING: Active worktree found for ${TASK_ID}:" >&2
        echo "  Path: ${WT_PATH}" >&2
        echo "  Branch: ${WT_BRANCH}" >&2
        CONFLICTS=$((CONFLICTS + 1))
    fi
done < <(git worktree list 2>/dev/null)

if [[ $CONFLICTS -gt 0 ]]; then
    echo "CONFLICT: ${CONFLICTS} existing worktree(s) for task ${TASK_ID}" >&2
    echo "Another agent may be working on this task." >&2
    exit 1
fi

# --- Check 2: Jira status (optional, requires env vars) ---
JIRA_BASE_URL="${JIRA_BASE_URL:-}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"

if [[ -n "$JIRA_BASE_URL" && -n "$JIRA_EMAIL" && -n "$JIRA_API_TOKEN" ]]; then
    echo "Checking Jira status for ${TASK_ID}..."
    HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
        -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
        "${JIRA_BASE_URL}/rest/api/3/issue/${TASK_ID}?fields=status" 2>/dev/null || echo "error")

    HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)
    RESPONSE_BODY=$(echo "$HTTP_RESPONSE" | head -n -1)

    if [[ "$HTTP_CODE" == "200" ]]; then
        STATUS=$(echo "$RESPONSE_BODY" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
        echo "Jira status: ${STATUS}"

        if [[ "$STATUS" == "В работе" || "$STATUS" == "In Progress" ]]; then
            echo "WARNING: Task ${TASK_ID} is already In Progress in Jira" >&2
            echo "Another agent may be working on this task." >&2
            exit 1
        fi
    else
        echo "WARNING: Could not fetch Jira status (HTTP ${HTTP_CODE}). Skipping check." >&2
    fi
else
    echo "Jira credentials not configured. Skipping Jira status check."
    echo "Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN to enable."
fi

echo "OK: No conflicts detected for ${TASK_ID}"
exit 0
