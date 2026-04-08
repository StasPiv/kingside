FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/matchmaker/package.json apps/matchmaker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY apps/matchmaker ./apps/matchmaker
COPY packages/shared ./packages/shared
COPY tsconfig.base.json ./
RUN cd apps/matchmaker && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate
RUN cd apps/matchmaker && npx tsc || true

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/matchmaker/dist ./apps/matchmaker/dist
COPY --from=build /app/apps/matchmaker/src/generated ./apps/matchmaker/dist/generated
COPY --from=build /app/node_modules ./node_modules
COPY apps/matchmaker/package.json ./apps/matchmaker/

ENV NODE_ENV=production

WORKDIR /app/apps/matchmaker
CMD ["node", "dist/index.js"]
