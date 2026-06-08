FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/broadcast-service/package.json apps/broadcast-service/
COPY packages/shared/package.json packages/shared/
COPY packages/broadcasts-db/package.json packages/broadcasts-db/
RUN npm ci --ignore-scripts
COPY apps/broadcast-service ./apps/broadcast-service
COPY packages/shared ./packages/shared
COPY packages/broadcasts-db ./packages/broadcasts-db
COPY tsconfig.base.json ./
RUN cd packages/shared && npx tsc --build
RUN cd packages/broadcasts-db && BROADCASTS_DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/broadcast-service && npx nest build
# KS-3058 / KS-3051 (ADR-045 E4): отбросить devDependencies.
# KS-3924 (deploy-perf): `prisma` CLI перенесена в `devDependencies`
# пакета `packages/broadcasts-db`, в runtime broadcast-service не нужна
# (миграции на pre-rollout идут отдельным образом). Однако `@prisma/client`
# объявляет `prisma` как optional peer-dep → npm помечает её `devOptional`
# и `--omit=dev` её НЕ убирает. Добавлен `--omit=optional`: убирает
# prisma + @prisma/engines + транзитивы (`@prisma/config`, `effect`,
# `fast-check`, `jiti`, `c12` и т.п.) + платформ-специфичные нативные
# модули, не нужные в linux/x64-контейнере. На api-образе эта правка
# дала −66 МБ сжатых, api здоров. См. KS-3924 коммит 89f389fb.
RUN npm prune --omit=dev --omit=optional --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/broadcast-service/dist ./apps/broadcast-service/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/broadcasts-db ./packages/broadcasts-db
COPY apps/broadcast-service/package.json ./apps/broadcast-service/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/broadcasts-db && ln -s ../../packages/broadcasts-db node_modules/@kingside/broadcasts-db

ENV NODE_ENV=production

WORKDIR /app/apps/broadcast-service
CMD ["node", "dist/main.js"]
