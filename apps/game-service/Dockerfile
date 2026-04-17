FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/game-service/package.json apps/game-service/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/broadcast-worker/package.json apps/broadcast-worker/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY packages/shared ./packages/shared
COPY apps/game-service ./apps/game-service
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN cd apps/game-service && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate
RUN cd apps/game-service && npx nest build 2>&1 || true
RUN cp -r apps/game-service/src/engine/*.json apps/game-service/dist/engine/ 2>/dev/null || true
RUN cp -r apps/game-service/src/i18n apps/game-service/dist/i18n 2>/dev/null || true
RUN ls apps/game-service/dist/main.js

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/game-service/dist ./apps/game-service/dist
COPY apps/game-service/data ./apps/game-service/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/game-service/prisma ./apps/game-service/prisma
COPY apps/game-service/package.json ./apps/game-service/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN cd apps/game-service && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_MAX_INSTANCES=4
ENV NODE_ENV=production
ENV GAME_SERVICE_PORT=3002

EXPOSE 3002

WORKDIR /app/apps/game-service
CMD ["node", "dist/main.js"]
