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
COMPOSE_FILE="$REPO_DIR/scripts/docker-compose.test-hints.yml"

log() { echo "[test-hints-up $(date +%H:%M:%S)] $*"; }

compose() {
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --project-directory "$REPO_DIR" "$@"
}

log "Запуск postgres + redis + миграции (init-стадия)..."
compose up -d --build postgres redis migrate-main migrate-events

log "Жду завершения migrate-main / migrate-events ..."
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

# KS-4763: events.actor_events партиционирована BY RANGE created_at, но
# на test-стеке pg_partman не установлен → партиций нет, любой INSERT
# падает с `no partition of relation found for row`. Создаём DEFAULT-
# партицию, чтобы seedEvents с произвольным created_at работал.
log "Создаю DEFAULT-партицию для events.actor_events ..."
docker exec "${PROJECT}-postgres-1" psql -U kingside -d kingside -v ON_ERROR_STOP=1 -c \
    "CREATE TABLE IF NOT EXISTS events.actor_events_default PARTITION OF events.actor_events DEFAULT;" \
    >/dev/null
log "actor_events_default: ok"

# KS-4763: сидируем правила hints из tools/seed-test-hints.sql.
# Без сидов admin/hints?enabled=true пуст → HintsService.checkFor всегда
# возвращает null → e2e падает «hint should appear». ON CONFLICT-апсерт
# делает шаг идемпотентным.
SEED_FILE="$REPO_DIR/tools/seed-test-hints.sql"
if [[ -f "$SEED_FILE" ]]; then
    log "Сидирую правила hints из tools/seed-test-hints.sql ..."
    docker exec -i "${PROJECT}-postgres-1" psql -U kingside -d kingside -v ON_ERROR_STOP=1 \
        < "$SEED_FILE" >/dev/null
    log "hints seed: ok"
else
    log "WARN: $SEED_FILE не найден — правила не сидированы, e2e упадёт."
fi

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
  postgres     → localhost:5434  (user/pass: kingside/kingside)
  redis        → localhost:6381  (tmpfs, эфемерный)
  game-service → localhost:3102

  Логи:   docker compose -p $PROJECT -f $COMPOSE_FILE logs -f <service>
  Гасить: bash scripts/test-hints-down.sh

EOF
