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
RUN PRISMA_VER=$(node -e "console.log(require('/app/node_modules/prisma/package.json').version)") \
    && npm install --no-workspaces "@prisma/client@${PRISMA_VER}" \
    && cd apps/matchmaker \
    && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/matchmaker/src ./apps/matchmaker/src
COPY --from=build /app/apps/matchmaker/prisma ./apps/matchmaker/prisma
COPY --from=build /app/node_modules ./node_modules
COPY apps/matchmaker/package.json ./apps/matchmaker/
COPY apps/matchmaker/tsconfig.json ./apps/matchmaker/
RUN node -e "const p=require('./apps/matchmaker/package.json');delete p.type;require('fs').writeFileSync('./apps/matchmaker/package.json',JSON.stringify(p,null,2))"

ENV NODE_ENV=production

WORKDIR /app/apps/matchmaker
CMD ["npx", "tsx", "src/index.ts"]
