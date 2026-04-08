FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/matchmaker/package.json apps/matchmaker/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY apps/matchmaker ./apps/matchmaker
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY packages/shared ./packages/shared
COPY tsconfig.base.json ./
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate
RUN cd apps/matchmaker && npx tsc

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/matchmaker/dist ./apps/matchmaker/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY apps/matchmaker/package.json ./apps/matchmaker/

ENV NODE_ENV=production

WORKDIR /app/apps/matchmaker
CMD ["node", "dist/index.js"]
