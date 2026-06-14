FROM node:20-slim AS base

# KS-4111 (follow-up): Stockfish из game-service-образа УБРАН вовсе.
# Бот-игра в game-service использует client-side Stockfish WASM
# (`botClientSide=true`, фронт играет локально, см.
# matchmaking.service.ts и bot-move.service.ts), серверного spawn'а
# движка в `apps/game-service/src` нет. Прежние `apt-get install
# stockfish` (SF15.x) и одно-итерационный SF18 native — артефакты
# отменённого embedded-варианта; держать в образе ~50–110 МБ
# движка без потребителей смысла нет.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/game-service/package.json apps/game-service/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN npm ci --ignore-scripts
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/game-service ./apps/game-service
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/game-service && npx nest build 2>&1 || true
RUN cp -r apps/game-service/src/engine/*.json apps/game-service/dist/engine/ 2>/dev/null || true
RUN cp -r apps/game-service/src/i18n apps/game-service/dist/i18n 2>/dev/null || true
RUN ls apps/game-service/dist/main.js
# KS-3051 (ADR-045 E4): отбросить devDependencies из node_modules,
# которые не нужны в runtime (typescript, @nestjs/cli, jest, ts-jest,
# @types/*, ts-node-dev и т.п.). Ожидаемый эффект — −100..200 MB на
# образ → быстрее push в ECR и быстрее ECS task start. game-service
# не запускает миграции через run-task, prisma CLI не нужен в runtime.
RUN npm prune --omit=dev --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/game-service/dist ./apps/game-service/dist
COPY apps/game-service/data ./apps/game-service/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
COPY apps/game-service/package.json ./apps/game-service/
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/db && ln -s ../../packages/db node_modules/@kingside/db

# KS-4111 (follow-up): мёртвые ENV `STOCKFISH_PATH` и
# `STOCKFISH_MAX_INSTANCES=4` удалены вместе с Stockfish-бинарём.
# Server-side движок здесь не используется (см. блок в base-stage).
ENV NODE_ENV=production
ENV GAME_SERVICE_PORT=3002

EXPOSE 3002

WORKDIR /app/apps/game-service
CMD ["node", "dist/main.js"]
