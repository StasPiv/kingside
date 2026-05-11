#!/usr/bin/env bash
# Подкачивает Prisma engine-бинарники под `debian-openssl-3.0.x`, если в системе
# openssl 3.x, а в node_modules лежат только сборки под openssl 1.1.x.
#
# Причина: версия prisma, зафиксированная в проекте, по умолчанию выкачивает
# `schema-engine-debian-openssl-1.1.x` и `libquery_engine-debian-openssl-1.1.x.so.node`,
# а в окружении агента системный openssl — 3.x, и prisma при запуске ищет
# `*-debian-openssl-3.0.x`. Подсунуть 1.1-бинарник через PRISMA_SCHEMA_ENGINE_BINARY
# нельзя: он динамически слинкован с libssl.so.1.1, которой нет в системе.
#
# Скрипт source-ится из prisma-migrate-deploy.sh и prisma-generate-all.sh и
# экспортирует функцию `ensure_prisma_engines`. Сам по себе ничего не делает,
# чтобы случайный запуск не качал бинарники.
#
# Идемпотентно: если нужные файлы уже на месте — выходит без работы.

ensure_prisma_engines() {
  local root_dir="${1:-${ROOT_DIR:-$PWD}}"
  local engines_dir="$root_dir/node_modules/@prisma/engines"

  if [[ ! -d "$engines_dir" ]]; then
    # До npm install. Пропускаем — после установки скрипт вызовется снова.
    return 0
  fi

  # Определяем major-версию системного openssl.
  if ! command -v openssl >/dev/null 2>&1; then
    echo "[prisma:engines] openssl CLI не найден, пропускаю проверку"
    return 0
  fi
  local openssl_major
  openssl_major="$(openssl version 2>/dev/null | awk '{print $2}' | cut -d. -f1)"
  if [[ "$openssl_major" != "3" ]]; then
    # 1.1.x — стандартные бинарники, ставшие из npm install, подходят.
    return 0
  fi

  local target="debian-openssl-3.0.x"
  local schema_engine="$engines_dir/schema-engine-$target"
  local query_engine="$engines_dir/libquery_engine-$target.so.node"

  if [[ -x "$schema_engine" && -f "$query_engine" ]]; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "[prisma:engines] нужен curl для подкачки $target, не найден"
    return 1
  fi
  if ! command -v gunzip >/dev/null 2>&1; then
    echo "[prisma:engines] нужен gunzip для подкачки $target, не найден"
    return 1
  fi

  local engines_version_pkg="$root_dir/node_modules/@prisma/engines-version/package.json"
  if [[ ! -f "$engines_version_pkg" ]]; then
    echo "[prisma:engines] @prisma/engines-version/package.json не найден"
    return 1
  fi

  local engine_hash
  engine_hash="$(node -e "process.stdout.write(require('$engines_version_pkg').prisma.enginesVersion || '')" 2>/dev/null || true)"
  if [[ -z "$engine_hash" ]]; then
    echo "[prisma:engines] не могу прочитать prisma.enginesVersion"
    return 1
  fi

  local base_url="https://binaries.prisma.sh/all_commits/$engine_hash/$target"

  if [[ ! -x "$schema_engine" ]]; then
    echo "[prisma:engines] загружаю schema-engine для $target ($engine_hash)..."
    if curl -fsSL "$base_url/schema-engine.gz" -o "$schema_engine.gz"; then
      gunzip -f "$schema_engine.gz"
      chmod +x "$schema_engine"
      echo "[prisma:engines] $schema_engine готов"
    else
      echo "[prisma:engines] не удалось загрузить $base_url/schema-engine.gz"
      return 1
    fi
  fi

  if [[ ! -f "$query_engine" ]]; then
    echo "[prisma:engines] загружаю libquery_engine для $target ($engine_hash)..."
    if curl -fsSL "$base_url/libquery_engine.so.node.gz" -o "$query_engine.gz"; then
      gunzip -f "$query_engine.gz"
      echo "[prisma:engines] $query_engine готов"
    else
      echo "[prisma:engines] не удалось загрузить $base_url/libquery_engine.so.node.gz"
      return 1
    fi
  fi

  return 0
}
