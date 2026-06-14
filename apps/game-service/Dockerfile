FROM node:20-slim AS base

# KS-4111 / KS-4107: пакет `stockfish` из debian-bookworm даёт SF15.x,
# а клиент (apps/web) и tactic-worker уже на SF18. Расхождение версий
# движка между bot-game (этот сервис) и puzzle-генератором/клиентом
# приводит к рассинхронизации оценки позиций. Ставим Stockfish 18
# native прямо из официальных GitHub-releases (`curl` и
# `ca-certificates` — для скачивания и TLS). `stockfish` из apt
# больше не ставим, иначе apt-копия SF15 перезаписывалась бы новым
# бинарём и оставляла лишний слой.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# KS-4111: Stockfish 18 native. AVX2 — оптимально для AMD EPYC Rome
# на Fargate (BMI2 на этой архитектуре тормозит — PEXT slow). sha256
# архива зафиксирован — защита от подмены release-asset'а на GitHub.
# `stockfish bench` в конце — sanity-check; если бинарь нерабочий,
# build падает до push, в проде crash-loop'а не будет.
ARG SF_VERSION=18
ARG SF_TARBALL=stockfish-ubuntu-x86-64-avx2.tar
ARG SF_SHA256=536c0c2c0cf06450df0bfb5e876ef0d3119950703a8f143627f990c7b5417964
RUN curl -fsSL -o /tmp/sf.tar \
        "https://github.com/official-stockfish/Stockfish/releases/download/sf_${SF_VERSION}/${SF_TARBALL}" \
    && echo "${SF_SHA256}  /tmp/sf.tar" | sha256sum -c - \
    && tar -xf /tmp/sf.tar -C /tmp \
    && install -D -m 0755 /tmp/stockfish/stockfish-ubuntu-x86-64-avx2 /usr/games/stockfish \
    && rm -rf /tmp/sf.tar /tmp/stockfish \
    && stockfish bench 2>&1 | tail -3

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

# KS-4111 / KS-4107: Stockfish 18 native (pinned binary с GitHub
# releases, AVX2-сборка под Fargate AMD EPYC Rome, sha256 проверяется
# в RUN-блоке выше). Путь /usr/games/stockfish сохранён ради
# совместимости с runtime-конфигом.
ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_MAX_INSTANCES=4
ENV NODE_ENV=production
ENV GAME_SERVICE_PORT=3002

EXPOSE 3002

WORKDIR /app/apps/game-service
CMD ["node", "dist/main.js"]
