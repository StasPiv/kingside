FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/broadcast-worker/package.json apps/broadcast-worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY apps/broadcast-worker ./apps/broadcast-worker
COPY packages/shared ./packages/shared
COPY tsconfig.base.json ./
RUN cd apps/broadcast-worker && npm install @prisma/client@6.4.1 && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/broadcast-worker/src ./apps/broadcast-worker/src
COPY --from=build /app/apps/broadcast-worker/prisma ./apps/broadcast-worker/prisma
COPY --from=build /app/apps/broadcast-worker/node_modules ./apps/broadcast-worker/node_modules
COPY --from=build /app/node_modules ./node_modules
COPY apps/broadcast-worker/package.json ./apps/broadcast-worker/
COPY apps/broadcast-worker/tsconfig.json ./apps/broadcast-worker/

ENV NODE_ENV=production

WORKDIR /app/apps/broadcast-worker
CMD ["npx", "tsx", "src/index.ts"]
