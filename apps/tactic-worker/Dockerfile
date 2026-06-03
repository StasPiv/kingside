# KS-2438 / ADR-042 §3. Dockerfile для apps/tactic-worker.
#
# Multi-stage по образцу apps/archive-service/Dockerfile + Stockfish (apt) +
# AWS RDS CA bundle для verify-full к archive-RDS (как в apps/api,
# наследует подход KS-2411).
#
# Build context — корень монорепо (`docker build -f apps/tactic-worker/Dockerfile .`),
# чтобы packages/{shared,db} были доступны.
FROM node:22-slim AS base

# Stockfish нужен для будущих subcommand'ов (sf-validate-drills,
# generate-puzzles). В index-tactic-drills он не используется, но
# держим бинарь в образе с самого начала — упрощает rollout этапов
# §9.3 / §9.6 ADR-042.
RUN apt-get update && apt-get install -y --no-install-recommends \
    stockfish openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/tactic-worker/package.json apps/tactic-worker/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
# KS-3633 / ADR-104 §5: maia-core нужен для T2 (continuous Maia
# annotation новых Precision-пазлов в CLI-генераторах).
COPY packages/maia-core/package.json packages/maia-core/
RUN npm ci --ignore-scripts
# Postinstall @prisma/engines: качаем schema-engine для текущей платформы
# (нужен `prisma generate` внутри packages/db build).
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/maia-core ./packages/maia-core
COPY apps/tactic-worker ./apps/tactic-worker
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN rm -f packages/maia-core/tsconfig.tsbuildinfo
RUN npx tsc --build packages/maia-core
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/tactic-worker && npx nest build
# KS-3051 (ADR-045 E4): отбросить devDependencies из node_modules.
# tactic-worker запускается через ECS RunTask с подкомандами CLI
# (`index-tactic-drills` и т.п.) — миграции **не** идут отсюда (схему
# держит api/@kingside/db), поэтому prisma CLI в runtime не нужен.
# Query-engine (`@prisma/client/.prisma`) копируется через
# `packages/db copy:engine` → `dist/generated/prisma/*.so.node` и не
# зависит от пакета `prisma` (CLI).
RUN npm prune --omit=dev --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/tactic-worker/dist ./apps/tactic-worker/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/packages/maia-core ./packages/maia-core
# KS-3632 / ADR-104 §4: admin-CLI бэкфилла Maia-разметки запускается
# через ECS RunTask на этом же образе (containerOverrides.command).
# tsx уже в корневом node_modules (devDep, остаётся после `npm prune
# --omit=dev --ignore-scripts` — он dependency, не devDependency).
COPY tools/maia-puzzle-annotation ./tools/maia-puzzle-annotation
# Maia-3 ONNX-модель (44 МБ, gitignored). Нужна и для T1 (один прогон
# через RunTask), и для T2 (continuous-annotation в воркере).
COPY tools/maia3 ./tools/maia3
COPY apps/tactic-worker/package.json ./apps/tactic-worker/
# KS-2411: AWS RDS global CA bundle для verify-full подключения к
# archive-RDS из CLI. Заменяет NODE_TLS_REJECT_UNAUTHORIZED=0.
COPY apps/tactic-worker/certs ./apps/tactic-worker/certs
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/db && ln -s ../../packages/db node_modules/@kingside/db
# KS-3633 / ADR-104 §5: symlink на maia-core для @kingside/maia-core
# import в tactic-worker CLI-генераторах.
RUN rm -rf node_modules/@kingside/maia-core && ln -s ../../packages/maia-core node_modules/@kingside/maia-core

ENV NODE_ENV=production
# Stockfish-бинарь от apt (Debian Bookworm: SF 15.x). Версионирование
# обсуждается в ADR-042 §8.6 — пока apt, при необходимости перейдём на
# pinned NNUE-binary с GitHub releases.
ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_POOL_SIZE=1
# KS-2411: Node автоматически подхватывает этот CA bundle для всех
# TLS-соединений (pg, https, fetch). Безопаснее глобального bypass'а
# через NODE_TLS_REJECT_UNAUTHORIZED=0.
ENV NODE_EXTRA_CA_CERTS=/app/apps/tactic-worker/certs/rds-ca.pem

WORKDIR /app/apps/tactic-worker
# Default CMD печатает help и exit=1 (см. main.ts) — чтобы случайный
# RunTask без containerOverrides.command падал видимо. ECS RunTask
# передаёт реальную команду через override:
#   ["node","dist/main.js","index-tactic-drills","--max-games=1"]
CMD ["node", "dist/main.js"]
