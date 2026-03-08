# Kingside - chess platform

# Start the entire project
up: _env _infra _deps _migrate _build-shared _dev

# Stop infrastructure
down:
    docker compose down

# Stop and remove volumes
clean:
    docker compose down -v

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
    docker compose up -d
    @echo "Waiting for PostgreSQL..."
    @until docker compose exec -T postgres pg_isready -U kingside > /dev/null 2>&1; do sleep 1; done
    @echo "PostgreSQL is ready"
    @echo "Waiting for Redis..."
    @until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done
    @echo "Redis is ready"

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

# Stop webhook server + SSH tunnel
webhook-stop:
    pkill -f "python3.*webhook-server.py" 2>/dev/null || true
    pkill -f "ssh.*kamatera-chess.*9877" 2>/dev/null || true
    echo "Webhook и туннель остановлены"
