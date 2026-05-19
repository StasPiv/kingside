#!/usr/bin/env bash
# Поднять fs.inotify лимиты навсегда. Идемпотентно, поддерживает WSL2.
# Запуск:  sudo bash scripts/inotify-fix.sh

set -euo pipefail

WATCHES=524288
INSTANCES=512
CONF=/etc/sysctl.d/99-inotify.conf

echo "=== before ==="
sysctl fs.inotify.max_user_watches fs.inotify.max_user_instances

echo
echo "=== 1. apply runtime ==="
sysctl -w fs.inotify.max_user_watches=$WATCHES
sysctl -w fs.inotify.max_user_instances=$INSTANCES

echo
echo "=== 2. persist to $CONF ==="
tee "$CONF" >/dev/null <<EOF
fs.inotify.max_user_watches=$WATCHES
fs.inotify.max_user_instances=$INSTANCES
EOF
ls -la "$CONF"
echo "--- contents ---"
cat "$CONF"

echo
echo "=== 3. reload from files ==="
sysctl --system 2>&1 | grep -E '(inotify|99-inotify)' || true

echo
echo "=== 4. detect WSL ==="
IS_WSL=0
if grep -qi microsoft /proc/version 2>/dev/null || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  IS_WSL=1
  echo "WSL detected"
else
  echo "Not WSL"
fi

if [ "$IS_WSL" = "1" ]; then
  WSL_CONF=/etc/wsl.conf
  touch "$WSL_CONF"
  if ! grep -q '^\[boot\]' "$WSL_CONF"; then
    printf '\n[boot]\nsystemd=true\ncommand="sysctl -p /etc/sysctl.d/99-inotify.conf"\n' >> "$WSL_CONF"
    echo "added [boot] section to $WSL_CONF"
  else
    grep -q '^systemd=true' "$WSL_CONF" || sed -i '/^\[boot\]/a systemd=true' "$WSL_CONF"
    if ! grep -q 'command=.*99-inotify.conf' "$WSL_CONF"; then
      sed -i '/^\[boot\]/a command="sysctl -p /etc/sysctl.d/99-inotify.conf"' "$WSL_CONF"
    fi
    echo "updated [boot] in $WSL_CONF"
  fi
  echo "--- $WSL_CONF ---"
  cat "$WSL_CONF"
  echo
  echo "ВАЖНО: после этого выполни в PowerShell на Windows:  wsl --shutdown"
  echo "WSL стартует заново и применит настройки. Без shutdown ребут хоста ничего не даст."
else
  echo
  echo "=== 5. verify systemd-sysctl (non-WSL) ==="
  if systemctl is-active systemd-sysctl.service >/dev/null 2>&1; then
    systemctl status systemd-sysctl.service --no-pager | head -5
    echo "OK: systemd-sysctl активен, значения переживут ребут"
  else
    echo "WARN: systemd-sysctl неактивен. Дописываю автозапуск в /etc/rc.local"
    if [ ! -f /etc/rc.local ]; then
      cat > /etc/rc.local <<'EOR'
#!/bin/sh
sysctl -p /etc/sysctl.d/99-inotify.conf || true
exit 0
EOR
      chmod +x /etc/rc.local
      echo "созданo /etc/rc.local"
    else
      grep -q '99-inotify.conf' /etc/rc.local || sed -i '/^exit 0/i sysctl -p /etc/sysctl.d/99-inotify.conf || true' /etc/rc.local
    fi
  fi
fi

echo
echo "=== after ==="
sysctl fs.inotify.max_user_watches fs.inotify.max_user_instances

echo
echo "=== готово ==="
echo "Ожидается: max_user_watches=$WATCHES, max_user_instances=$INSTANCES"
if [ "$IS_WSL" = "1" ]; then
  echo "Не забудь: wsl --shutdown в PowerShell, чтобы /etc/wsl.conf применился."
fi
