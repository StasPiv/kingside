#!/bin/bash
# Блокирует bash-команды обращающиеся к node_modules только для layout-агента
# Исключение: запуск бинарей (eslint, tsc, vite, vitest)

INPUT=$(cat)
AGENT=$(echo "$INPUT" | jq -r '.agent_type // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ "$AGENT" == "layout" ]] && echo "$COMMAND" | grep -q 'node_modules'; then
  # Разрешаем запуск бинарей
  if echo "$COMMAND" | grep -qE 'node_modules/\.bin/(eslint|tsc|vite|vitest)'; then
    exit 0
  fi
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"ЗАПРЕЩЕНО обращаться к node_modules. Используй CSS override в файлах проекта."}}'
  exit 0
fi

exit 0
