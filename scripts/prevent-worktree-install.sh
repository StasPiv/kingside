#!/bin/bash
# Блокирует npm install из git worktree и .claude worktree,
# чтобы не сломать node_modules основного репо.
# Используется как preinstall hook в package.json.
#
# Проблема: worktree имеет symlink node_modules -> main/node_modules.
# Когда npm install запускается из worktree, npm перезаписывает workspace-симлинки
# (@kingside/*) в main/node_modules, указывая их на worktree-пути → main ломается.

CWD="$(pwd)"

# Блокировать из .claude/worktrees (Claude Code SDK worktrees)
if echo "$CWD" | grep -q '\.claude/worktrees'; then
  echo ""
  echo "ERROR: npm install запрещён из .claude worktree!"
  echo "  CWD: $CWD"
  echo "  npm install сломает node_modules основного репо."
  echo ""
  exit 1
fi

# Блокировать из .worktrees (git worktrees агентов)
if echo "$CWD" | grep -q '\.worktrees/'; then
  echo ""
  echo "ERROR: npm install запрещён из git worktree!"
  echo "  CWD: $CWD"
  echo "  node_modules — симлинк на основной репо, npm install сломает его."
  echo ""
  echo "  Если нужно добавить зависимость — выполни npm install в основном репо:"
  echo "    cd /home/pivovartsev/work/kingside && npm install <package>"
  echo ""
  exit 1
fi

# В worktree .git — это файл, а не директория
if [ -f "$CWD/.git" ]; then
  echo ""
  echo "ERROR: npm install запрещён из git worktree!"
  echo "  CWD: $CWD"
  echo "  node_modules — симлинк на основной репо, npm install сломает его."
  echo ""
  echo "  Если нужно добавить зависимость — выполни npm install в основном репо:"
  echo "    cd /home/pivovartsev/work/kingside && npm install <package>"
  echo ""
  exit 1
fi
