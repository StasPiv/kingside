# Disk Cleanup Log — Kamatera Chess (63.250.57.89)

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
