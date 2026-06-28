#!/usr/bin/env bash
# KS-4761 / ADR-150 §T3. Поднимает изолированный compose-профиль для e2e-прогонов
# hints (5 сервисов на портах +100 от dev). См. docker-compose.test-hints.yml.
#
# Идемпотентно: повторный запуск использует существующие контейнеры/volumes.
# Чтобы стартовать с пустого postgres — `bash scripts/test-hints-down.sh` сначала.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PROJECT=kingside-test-hints
# compose-файл лежит в scripts/ (корень репо read-only в окружении агента).
# --project-directory "$REPO_DIR" даёт compose возможность интерпретировать
# относительные пути (build.context: ., volumes: ./scripts/...) от корня репо.
COMPOSE_FILE="$REPO_DIR/scripts/docker-compose.test-hints.yml"

log() { echo "[test-hints-up $(date +%H:%M:%S)] $*"; }

compose() {
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$REPO_DIR" "$@"
}

log "Запуск postgres + redis + миграции (init-стадия)..."
# Поднимаем БД, ждём здоровья postgres, прогоняем sidecar-миграции (main + events),
# и только потом стартуем api/game-service/web — у них в depends_on условия
# service_healthy / service_completed_successfully, docker compose сам выстраивает
# порядок, но для наглядных логов разбиваем на два прохода.
compose up -d --build postgres redis migrate-main migrate-events

log "Жду завершения migrate-main / migrate-events ..."
# `compose wait` в docker compose 2.20+ ждёт run-to-completion task'ы.
# На старых версиях fallback через цикл polling ниже.
if compose wait migrate-main migrate-events 2>/dev/null; then
    :
else
    for SVC in migrate-main migrate-events; do
        for i in $(seq 1 60); do
            STATE=$(docker inspect -f '{{.State.Status}}' \
                "${PROJECT}-${SVC}-1" 2>/dev/null || echo missing)
            EXIT=$(docker inspect -f '{{.State.ExitCode}}' \
                "${PROJECT}-${SVC}-1" 2>/dev/null || echo "?")
            if [[ "$STATE" == "exited" ]]; then
                if [[ "$EXIT" != "0" ]]; then
                    log "ERROR: $SVC exited rc=$EXIT — смотри \`compose logs $SVC\`"
                    exit 1
                fi
                break
            fi
            sleep 2
        done
    done
fi
log "migrate-main / migrate-events: ok"

log "Запуск api / game-service / web ..."
compose up -d --build api game-service web

log "Жду /health api на localhost:3101 ..."
for i in $(seq 1 60); do
    if curl -sf -o /dev/null --max-time 2 http://localhost:3101/health 2>/dev/null; then
        log "api: ready"
        break
    fi
    sleep 2
done

log "Жду vite на localhost:5174 ..."
for i in $(seq 1 60); do
    if curl -sf -o /dev/null --max-time 2 http://localhost:5174/ 2>/dev/null; then
        log "web: ready"
        break
    fi
    sleep 2
done

log "ready"
cat <<EOF

  api          → http://localhost:3101
  web          → http://localhost:5174
  postgres     → localhost:5433  (user/pass: kingside/kingside)
  redis        → localhost:6380  (tmpfs, эфемерный)
  game-service → localhost:3102

  Логи:   docker compose -p $PROJECT -f $COMPOSE_FILE logs -f <service>
  Гасить: bash scripts/test-hints-down.sh

EOF
