# Synthetic Bot Service Dockerfile
#
# Сборка из корня монорепо (как у game-service / archive-service):
#   docker build -f apps/synthetic-bot-service/Dockerfile -t synthetic-bot-service .
#
# База: node:22-bookworm. Системный Stockfish 18 ставится apt'ом
# (путь /usr/games/stockfish — совпадает с game-service).

FROM node:22-bookworm AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- build stage ----
FROM base AS build
WORKDIR /app

# Манифесты для воркспейсов (npm ci использует root lockfile).
COPY package.json package-lock.json ./
COPY apps/synthetic-bot-service/package.json apps/synthetic-bot-service/

RUN npm ci --ignore-scripts --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY apps/synthetic-bot-service ./apps/synthetic-bot-service

RUN cd apps/synthetic-bot-service && npx nest build

# ---- runtime stage ----
FROM base AS production
WORKDIR /app

COPY --from=build /app/apps/synthetic-bot-service/dist ./apps/synthetic-bot-service/dist
COPY --from=build /app/node_modules ./node_modules
COPY apps/synthetic-bot-service/package.json ./apps/synthetic-bot-service/

ENV NODE_ENV=production
ENV STOCKFISH_PATH=/usr/games/stockfish
ENV HEALTH_PORT=3010

EXPOSE 3010

WORKDIR /app/apps/synthetic-bot-service
CMD ["node", "dist/main.js"]
