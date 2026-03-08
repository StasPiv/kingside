# Kingside - chess platform

# Start the entire project
up: _env _infra _deps _migrate _build-shared _dev

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
    nohup python3 webhook-server.py > logs/webhook-stdout.log 2>&1 &
    echo "Webhook-сервер запущен (PID: $!)"
    chmod +x tunnel.sh
    nohup ./tunnel.sh > logs/tunnel.log 2>&1 &
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

# Stop webhook server + SSH tunnel
webhook-stop:
    pkill -f "python3.*webhook-server.py" 2>/dev/null || true
    pkill -f "ssh.*kamatera-chess.*9877" 2>/dev/null || true
    echo "Webhook и туннель остановлены"
