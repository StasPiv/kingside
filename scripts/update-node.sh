#!/usr/bin/env bash
# Обновить Node.js на хосте разработки до версии из .nvmrc.
# Поддерживаемые менеджеры: nvm, fnm, asdf. Если ни один не установлен —
# выводит инструкцию для ручной установки через apt/nodesource или brew.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NVMRC_FILE="$REPO_ROOT/.nvmrc"

if [ ! -f "$NVMRC_FILE" ]; then
    echo "Ошибка: $NVMRC_FILE не найден" >&2
    exit 1
fi

TARGET_VERSION="$(cat "$NVMRC_FILE" | tr -d '[:space:]')"
echo "Целевая версия Node.js (из .nvmrc): $TARGET_VERSION"

CURRENT_VERSION="$(node --version 2>/dev/null || echo 'не установлен')"
echo "Текущая версия Node.js: $CURRENT_VERSION"

# nvm
if [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo "Обнаружен nvm. Обновляю..."
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm install "$TARGET_VERSION"
    nvm alias default "$TARGET_VERSION"
    nvm use "$TARGET_VERSION"
    echo "Готово. Node.js: $(node --version), npm: $(npm --version)"
    exit 0
fi

# fnm
if command -v fnm >/dev/null 2>&1; then
    echo "Обнаружен fnm. Обновляю..."
    fnm install "$TARGET_VERSION"
    fnm default "$TARGET_VERSION"
    fnm use "$TARGET_VERSION"
    echo "Готово. Node.js: $(node --version), npm: $(npm --version)"
    exit 0
fi

# asdf
if command -v asdf >/dev/null 2>&1; then
    echo "Обнаружен asdf. Обновляю..."
    asdf plugin add nodejs 2>/dev/null || true
    asdf install nodejs "$TARGET_VERSION"
    asdf global nodejs "$TARGET_VERSION"
    echo "Готово. Node.js: $(node --version), npm: $(npm --version)"
    exit 0
fi

cat >&2 <<EOF

Не найдено ни одного менеджера версий Node.js (nvm/fnm/asdf).
Установите Node.js $TARGET_VERSION одним из способов:

  # Ubuntu/Debian (через NodeSource)
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # macOS (через Homebrew)
  brew install node@22

  # Любой OS (через nvm)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # Перезапустите shell и выполните:
  nvm install $TARGET_VERSION

EOF
exit 1
