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
# KS-3051 (ADR-045 E4): отбросить devDependencies. `prisma` CLI и
# `@prisma/client` остались — `prisma` теперь в `dependencies` пакета
# packages/broadcasts-db (нужен для pre-rollout миграций через
# `aws ecs run-task` на этом же образе).
RUN npm prune --omit=dev --ignore-scripts

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
