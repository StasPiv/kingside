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
RUN PRISMA_VER=$(node -e "console.log(require('/app/node_modules/prisma/package.json').version)") \
    && npm install --no-workspaces "@prisma/client@${PRISMA_VER}" \
    && cd apps/broadcast-worker \
    && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/broadcast-worker/src ./apps/broadcast-worker/src
COPY --from=build /app/apps/broadcast-worker/prisma ./apps/broadcast-worker/prisma
COPY --from=build /app/node_modules ./node_modules
COPY apps/broadcast-worker/package.json ./apps/broadcast-worker/
COPY apps/broadcast-worker/tsconfig.json ./apps/broadcast-worker/
RUN node -e "const p=require('./apps/broadcast-worker/package.json');delete p.type;require('fs').writeFileSync('./apps/broadcast-worker/package.json',JSON.stringify(p,null,2))"

ENV NODE_ENV=production

WORKDIR /app/apps/broadcast-worker
CMD ["npx", "tsx", "src/index.ts"]
