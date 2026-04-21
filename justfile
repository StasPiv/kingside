# Kingside - chess platform

# Start the entire project
up: _env _infra _deps _migrate _build-shared _clean-vite-cache _prebundle-vite _dev

# Deploy to AWS (auto-detect scope: frontend/api/all)
deploy:
    bash scripts/deploy-aws.sh

# Force deploy everything
deploy-all:
    bash scripts/deploy-aws.sh all

# Deploy only frontend (S3 + CloudFront)
deploy-frontend:
    bash scripts/deploy-aws.sh frontend

# Deploy only API (ECR + ECS)
deploy-api:
    bash scripts/deploy-aws.sh api

# Deploy only workers (broadcast-worker + archive-importer)
deploy-workers:
    bash scripts/deploy-aws.sh workers

# Deploy only broadcast-worker
deploy-broadcast:
    bash scripts/deploy-aws.sh broadcast-worker

# Deploy only archive-importer (TWIC + position indexer)
deploy-archive-importer:
    bash scripts/deploy-aws.sh archive-importer

# Run archive-importer worker in dev mode (uses local .env)
dev-archive-importer:
    npm run dev --workspace=apps/archive-importer

# Start archive-importer worker (prod mode) — assumes built dist/
start-archive-importer:
    npm run start --workspace=apps/archive-importer

# View archive-importer logs (last N lines). Usage: just logs-archive-importer [lines]
logs-archive-importer lines="100":
    docker compose logs archive-importer --tail {{lines}} --timestamps

# Deploy to Kamatera (legacy)
deploy-kamatera:
    bash scripts/deploy-local.sh

# Stop infrastructure
down:
    docker compose down

# Stop and remove volumes
clean:
    docker compose down -v

# View API logs (production). Usage: just logs [lines]
logs lines="100":
    docker compose logs api --tail {{lines}} --timestamps

# Follow API logs in real-time
logs-follow:
    docker compose logs api -f --timestamps

# View API logs filtered by level. Usage: just logs-grep "ERROR"
logs-grep pattern:
    docker compose logs api --no-color | grep -i "{{pattern}}"

# Run E2E tests against running dev-server (just up first)
e2e project="chromium":
    npm run test:e2e -w @kingside/e2e -- --project={{project}}

# Run only integration E2E tests (no mocks)
e2e-integration project="chromium":
    npm run test:e2e:integration -w @kingside/e2e -- --project={{project}}

# --- internal recipes ---

# Copy .env files if missing
_env:
    #!/usr/bin/env bash
    if [ ! -f .env ]; then
        cp .env.example .env
        echo "Created .env from .env.example"
    fi
    if [ ! -f apps/api/.env ]; then
        cp .env.example apps/api/.env
        echo "Created apps/api/.env from .env.example"
    fi

# Start postgres and redis
_infra:
    #!/usr/bin/env bash
    set -euo pipefail
    PG_PORT="${POSTGRES_PORT:-5432}"
    RD_PORT="${REDIS_PORT:-6380}"

    pg_ok=false
    redis_ok=false
    if pg_isready -h 127.0.0.1 -p "$PG_PORT" -U "${POSTGRES_USER:-kingside}" > /dev/null 2>&1; then
        pg_ok=true
    fi
    if redis-cli -p "$RD_PORT" ping 2>/dev/null | grep -q PONG; then
        redis_ok=true
    fi

    if $pg_ok && $redis_ok; then
        echo "PostgreSQL and Redis already running on ports $PG_PORT/$RD_PORT, skipping docker compose up"
    else
        docker compose up -d postgres redis
        echo "Waiting for PostgreSQL..."
        until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-kingside}" > /dev/null 2>&1; do sleep 1; done
        echo "PostgreSQL is ready"
        echo "Waiting for Redis..."
        until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done
        echo "Redis is ready"
    fi

# Install dependencies
_deps:
    npm install

# Run prisma migrations and generate client
_migrate:
    cd apps/api && npx prisma generate && npx prisma migrate deploy

# Build shared package
_build-shared:
    npx tsc --build packages/shared

# Drop Vite pre-bundle cache (apps/web/node_modules/.vite).
# После npm install кеш оптимизации depов может стать невалидным, что
# приводит к 504 "Outdated Optimize Dep" при открытии http://localhost:5173.
# Полное удаление заставит Vite пересобрать кеш при старте dev-сервера.
_clean-vite-cache:
    #!/usr/bin/env bash
    set -euo pipefail
    for dir in apps/web/node_modules/.vite node_modules/.vite; do
        if [ -d "$dir" ]; then
            rm -rf "$dir"
            echo "Removed Vite cache: $dir"
        fi
    done

# Manual cleanup: drop Vite cache without restarting anything
clean-vite-cache: _clean-vite-cache

# Pre-bundle Vite dependencies before starting dev server.
# Vite по умолчанию оптимизирует depы лениво — при первом запросе к /.
# Если браузер откроет страницу раньше, чем Vite закончит discovery,
# он получит 504 "Outdated Optimize Dep" на уже запрошенные URL с
# устаревшими ?v= хешами. `vite optimize --force` выполняет scan + esbuild
# синхронно до старта dev-сервера, заполняя apps/web/node_modules/.vite/deps
# валидным кешем. После этого dev-сервер стартует с готовым кешем и
# не пере-оптимизирует на лету.
_prebundle-vite:
    #!/usr/bin/env bash
    set -euo pipefail
    cd apps/web
    echo "Pre-bundling Vite dependencies..."
    npx vite optimize --force
    echo "Vite deps pre-bundled."

# Manual prebundle: force Vite to rebuild deps cache without starting dev server
prebundle-vite: _prebundle-vite

# Start dev servers
_dev:
    npx turbo run dev

# Start webhook server + SSH tunnel
webhook:
    #!/usr/bin/env bash
    if [ -f .env ]; then
        set -a
        source .env
        set +a
    fi
    pkill -f "python3.*webhook-server.py" 2>/dev/null || true
    pkill -f "ssh.*kamatera-chess.*9877" 2>/dev/null || true
    sleep 1
    # Tracker
    pkill -f "python3.*tools/tracker/main.py" 2>/dev/null || true
    sleep 0.5
    TRACKER_WEBHOOK_URL=http://localhost:9876/webhook/tracker \
      nohup python3 tools/tracker/main.py > logs/tracker-stdout.log 2>&1 &
    echo "Трекер запущен (PID: $!)"
    # Webhook server
    nohup python3 webhook-server.py > logs/webhook-stdout.log 2>&1 &
    echo "Webhook-сервер запущен (PID: $!)"
    chmod +x tunnel.sh
    setsid ./tunnel.sh > logs/tunnel.log 2>&1 &
    disown
    echo "SSH-туннель запущен (PID: $!)"
    sleep 2
    if curl -s http://127.0.0.1:9876/health | grep -q ok; then
        echo "Health check: OK"
    else
        echo "Health check: FAIL"
    fi

# View Puzzle Rush logs only
logs-puzzle-rush:
    docker compose logs api 2>&1 | grep -i "puzzle"

# Start SSH tunnel only
tunnel:
    #!/usr/bin/env bash
    pkill -f "ssh.*kamatera-chess.*9877" 2>/dev/null || true
    ssh kamatera-chess "fuser -k 9877/tcp" 2>/dev/null || true
    sleep 1
    chmod +x tunnel.sh
    setsid ./tunnel.sh > logs/tunnel.log 2>&1 &
    disown
    echo "SSH-туннель запущен (PID: $!)"
    sleep 3
    if ps -p $! > /dev/null 2>&1; then
        echo "Туннель активен"
    else
        echo "Туннель упал. Лог:"
        cat logs/tunnel.log
    fi

# Stop webhook server + SSH tunnel
webhook-stop:
    #!/usr/bin/env bash
    docker ps --filter "name=agent-" --filter "name=chat-" -q | xargs -r docker stop 2>/dev/null || true
    pgrep -f "python3 webhook-server.py" | xargs -r kill 2>/dev/null || true
    pgrep -f "python3 tools/tracker/main.py" | xargs -r kill 2>/dev/null || true
    pkill -f "ssh.*kamatera-chess.*9877" 2>/dev/null || true
    echo "Webhook, трекер, туннель и контейнеры остановлены"
