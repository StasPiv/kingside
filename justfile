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
    @until docker exec kingside-postgres pg_isready -U kingside > /dev/null 2>&1; do sleep 1; done
    @echo "PostgreSQL is ready"
    @echo "Waiting for Redis..."
    @until docker exec kingside-redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done
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
