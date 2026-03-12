# Disk Cleanup Log — Kamatera Chess (63.250.57.89)

## 2026-03-12 (KS-448)

**Trigger:** rsync деплой завершился с ошибкой "No space left on device" (диск 100%)

### Before cleanup
- Used: 30G / 30G (100%, 0B free)

### Root cause
- `/root/kingside/.claude/worktrees/` — 61 старых Claude agent worktree (~4.7G)
- Docker build cache — 1.97GB + unused images + volumes
- `/root/kingside/.worktrees/` — 15 старых worktree (~380MB)

### Actions performed
- `docker system prune -af --volumes` — freed **4.814 GB**
- `rm -rf /root/kingside/.claude/worktrees/` — freed **~4.7 GB** (61 worktree)
- `rm -rf /root/kingside/.worktrees/` — freed **~380 MB** (15 worktree)
- `journalctl --vacuum-size=50M` — freed **176 MB**
- `truncate -s 0 /var/log/btmp /var/log/btmp.1` — freed **~221 MB** (SSH brute-force logs)
- `truncate -s 0 /root/kingside/logs/agents.log` — freed **108 MB**
- `truncate -s 0 /root/kingside/logs/webhook-dump.json` — freed **24 MB**
- `rm -rf /root/kingside/.turbo/cache/` — freed **~149 MB**

### After cleanup
- Used: 20G / 30G (69%, 8.9G free)

### Notes
- Kingside containers remained running throughout (api, postgres, redis)
- `.claude/worktrees/` — накапливаются автоматически Claude агентами; требуется периодическая очистка
- Рекомендуется настроить cron для регулярной очистки Docker и worktrees

---

## 2026-03-11 (KS-430)

**Script:** `scripts/disk-cleanup.sh`

### Before cleanup
- Used: 25G / 30G (90%, 3.0G free)

### Actions performed
- `docker system prune -f` — freed **803.7 MB** (1 image + 21 build cache objects)
- `journalctl --vacuum-size=200M` — freed **168 MB** (5 archived journal files)

### After cleanup
- Used: 24G / 30G (86%, 4.0G free)

### Notes
- Target <80% was not reached (86% after cleanup)
- Large consumers remaining: `/var/log/btmp.1` (137M), `/var/log/btmp` (83M), `/var/log/auth.log.1` (50M)
- btmp logs contain failed SSH login attempts (brute force); rotation is handled by logrotate
