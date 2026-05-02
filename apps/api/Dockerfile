FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/game-service/package.json apps/game-service/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN npm ci --ignore-scripts
# KS-2216: отдельно запускаем postinstall @prisma/engines (он же скачивает schema-engine
# для текущей платформы). Без этого `npx prisma migrate deploy` в production-стадии
# не находит бинарь schema-engine для debian-openssl-3.0.x.
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/data ./apps/api/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/package.json ./apps/api/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/db && ln -s ../../packages/db node_modules/@kingside/db

ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_MAX_INSTANCES=4
ENV NODE_ENV=production

EXPOSE 3001

WORKDIR /app/apps/api
COPY apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
