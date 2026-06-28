#!/usr/bin/env bash
# KS-4761 / ADR-150 §T3. Гасит test-hints compose-профиль и удаляет volumes
# (postgres_test_hints_data, dangling) + sidecar-контейнеры migrate-main/events.
#
# После прогонки `down -v` следующий `up` стартует с пустого postgres — это
# нормально для e2e: каждая прогонка — чистое состояние БД и Redis.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PROJECT=kingside-test-hints
COMPOSE_FILE="$REPO_DIR/scripts/docker-compose.test-hints.yml"

echo "[test-hints-down] Остановка и удаление volumes ($PROJECT) ..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$REPO_DIR" down -v --remove-orphans

echo "[test-hints-down] ok"
