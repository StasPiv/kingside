FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/puzzle-worker/package.json apps/puzzle-worker/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/broadcast-worker/package.json apps/broadcast-worker/
COPY apps/game-service/package.json apps/game-service/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY apps/puzzle-worker ./apps/puzzle-worker
COPY packages/shared ./packages/shared
COPY tsconfig.base.json ./
RUN PRISMA_VER=$(node -e "console.log(require('/app/node_modules/prisma/package.json').version)") \
    && npm install --no-workspaces "@prisma/client@${PRISMA_VER}" \
    && cd apps/puzzle-worker \
    && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/puzzle-worker/src ./apps/puzzle-worker/src
COPY --from=build /app/apps/puzzle-worker/prisma ./apps/puzzle-worker/prisma
COPY --from=build /app/node_modules ./node_modules
COPY apps/puzzle-worker/package.json ./apps/puzzle-worker/
COPY apps/puzzle-worker/tsconfig.json ./apps/puzzle-worker/
RUN node -e "const p=require('./apps/puzzle-worker/package.json');delete p.type;require('fs').writeFileSync('./apps/puzzle-worker/package.json',JSON.stringify(p,null,2))"

ENV NODE_ENV=production
ENV STOCKFISH_PATH=/usr/games/stockfish

WORKDIR /app/apps/puzzle-worker
CMD ["npx", "tsx", "src/index.ts"]
