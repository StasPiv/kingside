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
COPY packages/db/package.json packages/db/
RUN npm ci --ignore-scripts
COPY apps/broadcast-worker ./apps/broadcast-worker
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY tsconfig.base.json ./
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/broadcast-worker/src ./apps/broadcast-worker/src
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
COPY apps/broadcast-worker/package.json ./apps/broadcast-worker/
COPY apps/broadcast-worker/tsconfig.json ./apps/broadcast-worker/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/db && ln -s ../../packages/db node_modules/@kingside/db
RUN node -e "const p=require('./apps/broadcast-worker/package.json');delete p.type;require('fs').writeFileSync('./apps/broadcast-worker/package.json',JSON.stringify(p,null,2))"

ENV NODE_ENV=production

WORKDIR /app/apps/broadcast-worker
CMD ["npx", "tsx", "src/index.ts"]
