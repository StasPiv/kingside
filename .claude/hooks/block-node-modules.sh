#!/bin/bash
# Блокирует чтение файлов из node_modules только для layout-агента

INPUT=$(cat)
AGENT=$(echo "$INPUT" | jq -r '.agent_type // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ "$AGENT" == "layout" && -n "$FILE_PATH" && "$FILE_PATH" == *"node_modules"* ]]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"ЗАПРЕЩЕНО читать файлы из node_modules. Используй CSS override в файлах проекта."}}'
  exit 0
fi

exit 0
