FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN npx tsc --build packages/shared
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate && npm run build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY apps/api/package.json ./apps/api/

ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_MAX_INSTANCES=4
ENV NODE_ENV=production

EXPOSE 3001

WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
