FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/game-service/package.json apps/game-service/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY packages/shared ./packages/shared
COPY apps/game-service ./apps/game-service
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN cd apps/game-service && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/game-service/dist ./apps/game-service/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/game-service/prisma ./apps/game-service/prisma
COPY apps/game-service/package.json ./apps/game-service/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN cd apps/game-service && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_MAX_INSTANCES=4
ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

WORKDIR /app/apps/game-service
CMD ["node", "dist/main.js"]
