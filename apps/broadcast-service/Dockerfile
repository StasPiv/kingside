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
# пакета `packages/broadcasts-db`, в runtime broadcast-service не нужна.
#
# KS-3925: devops вынес `prisma migrate deploy` для broadcasts-db в
# отдельный миграционный образ `kingside-broadcast-service-migrations`
# (по образцу `kingside-api-migrations` из KS-3924). Поэтому в runtime
# `prisma` CLI больше не нужна и `--omit=optional` теперь безопасен —
# раньше он ломал `[migrate-check broadcast]` шаг `scripts/deploy-aws.sh`
# (см. откат 8f0d0732 от 2026-06-08), сейчас миграции идут до runtime
# из отдельного образа.
#
# `--omit=optional` снимает prisma + @prisma/engines + транзитивы
# (`@prisma/config`, `effect`, `fast-check`, `jiti`, `c12` и т.п.) +
# платформ-специфичные нативные модули, не нужные в linux/x64-
# контейнере (`@esbuild/darwin-*`, `@rollup/rollup-win32-*`, `fsevents`,
# `pg-cloudflare`). На api-образе (KS-3924, коммит 89f389fb) аналогичная
# правка дала −66 МБ сжатых.
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
