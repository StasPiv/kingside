FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/archive-service/package.json apps/archive-service/
COPY packages/shared/package.json packages/shared/
COPY packages/archive-db/package.json packages/archive-db/
RUN npm ci --ignore-scripts
COPY apps/archive-service ./apps/archive-service
COPY packages/shared ./packages/shared
COPY packages/archive-db ./packages/archive-db
COPY tsconfig.base.json ./
RUN cd packages/shared && npx tsc --build
RUN cd packages/archive-db && ARCHIVE_DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/archive-service && npx nest build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/archive-service/dist ./apps/archive-service/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/archive-db ./packages/archive-db
COPY apps/archive-service/package.json ./apps/archive-service/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/archive-db && ln -s ../../packages/archive-db node_modules/@kingside/archive-db

ENV NODE_ENV=production

WORKDIR /app/apps/archive-service
CMD ["node", "dist/main.js"]
