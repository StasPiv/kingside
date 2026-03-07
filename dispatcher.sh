#!/bin/bash
# Dispatcher — проверяет Jira на новые задачи и запускает соответствующего агента
unset CLAUDECODE

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

POLL_INTERVAL=${1:-60}  # интервал в секундах, по умолчанию 60

JIRA_TOOLS="mcp__jira-personal__*"

echo "Dispatcher запущен. Проверка Jira каждые ${POLL_INTERVAL}с..."

while true; do
    TASKS=$(cd "$PROJECT_DIR" && claude -p "Используй MCP jira-personal. Найди задачи JQL: project = KS AND status in ('К выполнению', 'В работе') ORDER BY priority DESC. Верни JSON массив: [{\"key\": \"KS-1\", \"summary\": \"...\", \"labels\": [\"backend\"]}]. Только JSON, без пояснений." --allowedTools "$JIRA_TOOLS" --output-format json 2>/dev/null)

    if [ -z "$TASKS" ] || [ "$TASKS" = "[]" ]; then
        sleep "$POLL_INTERVAL"
        continue
    fi

    echo "$TASKS" | python3 -c "
import sys, json, re

try:
    data = json.load(sys.stdin)
    result = data.get('result', '') if isinstance(data, dict) else ''
    # Убираем markdown обёртку
    result = re.sub(r'^\`\`\`json\s*', '', result.strip())
    result = re.sub(r'\`\`\`\s*$', '', result.strip())
    tasks = json.loads(result)
    if not isinstance(tasks, list):
        sys.exit(0)
    for task in tasks:
        key = task.get('key', '')
        summary = task.get('summary', '')
        labels = task.get('labels', [])

        agent = None
        for label in labels:
            mapping = {'architecture': 'architect'}
            label = mapping.get(label, label)
            if label in ('backend', 'frontend', 'devops', 'qa', 'architect'):
                agent = label
                break

        if agent and key:
            print(f'{key}|{agent}|{summary}')
except:
    pass
" | while IFS='|' read -r KEY AGENT SUMMARY; do
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Запуск $AGENT для $KEY: $SUMMARY"

        cd "$PROJECT_DIR" && claude -p "
Ты работаешь над задачей $KEY: $SUMMARY

1. Сначала переведи задачу в статус 'In Progress' через MCP jira-personal
2. Прочитай описание задачи из Jira
3. Выполни задачу
4. Добавь комментарий в Jira с результатом
5. Переведи задачу в статус 'Done'
" --agent "$AGENT" --dangerously-skip-permissions --output-format stream-json --verbose >> "$LOG_DIR/agents.log" 2>&1 &

        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $AGENT запущен для $KEY (PID: $!)"
    done

    sleep "$POLL_INTERVAL"
done
