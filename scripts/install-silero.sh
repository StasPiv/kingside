#!/usr/bin/env bash
# KS-4059. Установка Silero TTS v4 (русский) на хост.
#
# Что делает:
#   1. Копирует подготовленный venv (с torch CPU + soundfile + numpy)
#      из /tmp/KS-4059/venv в /opt/silero/venv.
#   2. Копирует модель v4_ru.pt в /opt/silero/v4_ru.pt.
#   3. Копирует silero-say.py в /opt/silero/silero-say.py.
#   4. Ставит CLI-обёртку silero-say в /usr/local/bin/silero-say.
#
# Требует: sudo (пишем в /opt и /usr/local/bin).
#
# Вызов:
#   sudo bash scripts/install-silero.sh
#
# Что не трогается: piper-tts и /opt/piper-voices/ (по требованию задачи).

set -euo pipefail

SRC_DIR="${SRC_DIR:-/tmp/KS-4059}"
DEST_DIR="/opt/silero"
BIN_DIR="/usr/local/bin"

if [ "$EUID" -ne 0 ]; then
    echo "install-silero: требуется sudo (запиши в /opt + /usr/local/bin)" >&2
    exit 1
fi

for f in "$SRC_DIR/venv/bin/python3" "$SRC_DIR/v4_ru.pt" "$SRC_DIR/silero-say.py" "$SRC_DIR/silero-say"; do
    if [ ! -e "$f" ]; then
        echo "install-silero: не найден исходник: $f" >&2
        echo "  убедись что devops-агент подготовил $SRC_DIR (см. KS-4059)" >&2
        exit 2
    fi
done

echo "[install-silero] создаю $DEST_DIR ..."
mkdir -p "$DEST_DIR"

echo "[install-silero] переношу venv в $DEST_DIR/venv (≈250 МБ) ..."
rm -rf "$DEST_DIR/venv"
cp -a "$SRC_DIR/venv" "$DEST_DIR/venv"
# venv после переноса нужно перебутстрапить shebang'и (они захардкожены на исходный путь).
# Самый простой способ — пересоздать активирующие скрипты через ensurepip — но
# проще перепрописать shebang'и руками: они все ссылаются на python3 venv.
echo "[install-silero] чиню shebang'и в venv/bin/* (исходный путь $SRC_DIR/venv → $DEST_DIR/venv) ..."
grep -lr "$SRC_DIR/venv" "$DEST_DIR/venv/bin" 2>/dev/null | while read -r f; do
    sed -i "s|$SRC_DIR/venv|$DEST_DIR/venv|g" "$f"
done

echo "[install-silero] копирую модель v4_ru.pt в $DEST_DIR/v4_ru.pt ..."
cp "$SRC_DIR/v4_ru.pt" "$DEST_DIR/v4_ru.pt"
chmod 0644 "$DEST_DIR/v4_ru.pt"

echo "[install-silero] копирую silero-say.py в $DEST_DIR/silero-say.py ..."
cp "$SRC_DIR/silero-say.py" "$DEST_DIR/silero-say.py"
chmod 0755 "$DEST_DIR/silero-say.py"

echo "[install-silero] ставлю CLI $BIN_DIR/silero-say ..."
cp "$SRC_DIR/silero-say" "$BIN_DIR/silero-say"
chmod 0755 "$BIN_DIR/silero-say"

echo "[install-silero] smoke-тест ..."
TMP_WAV="$(mktemp --suffix=.wav)"
if "$BIN_DIR/silero-say" "Установка завершена" "$TMP_WAV"; then
    echo "[install-silero] OK: $TMP_WAV ($(stat -c %s "$TMP_WAV") байт)"
    rm -f "$TMP_WAV"
else
    echo "[install-silero] ERROR: silero-say smoke-тест упал. См. вывод выше." >&2
    exit 3
fi

echo "[install-silero] готово. Команда: silero-say \"текст\" /path/out.wav"
echo "[install-silero] голоса: aidar baya kseniya xenia eugene random  (default: xenia)"
echo "[install-silero] частоты: 8000 24000 48000  (default: 48000)"
