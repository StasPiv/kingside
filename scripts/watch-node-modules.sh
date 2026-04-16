#!/bin/bash
# Мониторинг node_modules/@kingside symlinks
# Ловит момент когда symlinks ломаются и логирует кто это делает
# Запуск: bash scripts/watch-node-modules.sh &

REPO="/home/pivovartsev/work/kingside"
WATCH_DIR="$REPO/node_modules/@kingside"
LOG="/tmp/node-modules-watcher.log"

echo "[$(date)] Watcher started, monitoring $WATCH_DIR" | tee -a "$LOG"

while true; do
  for link in "$WATCH_DIR"/api "$WATCH_DIR"/web "$WATCH_DIR"/shared; do
    name=$(basename "$link")
    if [ ! -e "$link" ]; then
      echo "[$(date)] BROKEN: $name — symlink target does not exist" | tee -a "$LOG"
      # Log who has node_modules open
      echo "  lsof on node_modules:" >> "$LOG"
      lsof +D "$REPO/node_modules/@kingside" 2>/dev/null | head -20 >> "$LOG"
      # Log recent npm/node processes
      echo "  Recent npm/node processes:" >> "$LOG"
      ps aux | grep -E "npm|node|tsc|nest" | grep -v grep >> "$LOG"
      # Log git worktree list
      echo "  Git worktrees:" >> "$LOG"
      git -C "$REPO" worktree list 2>/dev/null >> "$LOG"
      # Log .claude/worktrees
      echo "  .claude/worktrees:" >> "$LOG"
      ls -d "$REPO/.claude/worktrees"/*/ 2>/dev/null >> "$LOG"
      echo "---" >> "$LOG"
      # Alert once, then wait longer
      sleep 30
      break 2
    fi

    target=$(readlink "$link")
    resolved=$(readlink -f "$link")
    if [ ! -d "$resolved" ]; then
      echo "[$(date)] CORRUPTED: $name -> $target (resolves to $resolved which is not a dir)" | tee -a "$LOG"
      ps aux | grep -E "npm install|npm ci" | grep -v grep >> "$LOG"
      echo "---" >> "$LOG"
      sleep 30
      break 2
    fi
  done
  sleep 2
done

echo "[$(date)] Watcher detected issue, check $LOG" | tee -a "$LOG"
