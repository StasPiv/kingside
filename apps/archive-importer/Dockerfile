FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/archive-importer/package.json apps/archive-importer/
COPY packages/shared/package.json packages/shared/
COPY packages/archive-db/package.json packages/archive-db/
RUN npm ci --ignore-scripts
COPY apps/archive-importer ./apps/archive-importer
COPY packages/shared ./packages/shared
COPY packages/archive-db ./packages/archive-db
COPY tsconfig.base.json ./
RUN cd packages/archive-db && ARCHIVE_DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/archive-importer/src ./apps/archive-importer/src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/archive-db ./packages/archive-db
COPY apps/archive-importer/package.json ./apps/archive-importer/
COPY apps/archive-importer/tsconfig.json ./apps/archive-importer/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/archive-db && ln -s ../../packages/archive-db node_modules/@kingside/archive-db
RUN node -e "const p=require('./apps/archive-importer/package.json');delete p.type;require('fs').writeFileSync('./apps/archive-importer/package.json',JSON.stringify(p,null,2))"

ENV NODE_ENV=production

WORKDIR /app/apps/archive-importer
CMD ["npx", "tsx", "src/index.ts"]
