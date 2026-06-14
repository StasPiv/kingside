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
#
# KS-4111 / KS-4107: пакет `stockfish` из debian-bookworm даёт SF15.x,
# а на клиенте (apps/web) используется SF18 WASM. Расхождение WDL у
# границы loss_E=0.02 приводило к флипу классификации хода
# (см. KS-4107, паритет-тест KS-4100). После выравнивания версий
# движков ставим Stockfish 18 native прямо из официальных GitHub-
# releases. `curl` и `ca-certificates` нужны для скачивания и
# проверки TLS-цепочки; `stockfish` из apt больше не ставим — он
# был бы перезаписан и оставлял лишний слой.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# KS-4111: Stockfish 18 native (вместо apt-get install stockfish с
# SF15 из debian-репо). AVX2 — оптимально для AMD EPYC Rome на
# Fargate (BMI2 на этой архитектуре тормозит — PEXT slow). sha256
# архива зафиксирован — защита от подмены release-asset'а на GitHub.
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
# KS-4111 / KS-4107: Stockfish 18 native (pinned binary с GitHub
# releases, AVX2-сборка под Fargate AMD EPYC Rome, sha256 проверяется
# в RUN-блоке выше). Путь /usr/games/stockfish сохранён ради
# совместимости с runtime-конфигом приложений.
ENV STOCKFISH_PATH=/usr/games/stockfish
ENV STOCKFISH_POOL_SIZE=1
# KS-4107: путь к ONNX-модели Maia-3 для T2 (continuous-annotation
# через MaiaAnnotationService) и для parity-check CLI. WORKDIR в
# production = /app/apps/tactic-worker (см. ниже), поэтому
# относительный дефолт `tools/maia3/maia3_simplified.onnx` из
# `MaiaAnnotationService.fromEnv` резолвится в
# /app/apps/tactic-worker/tools/maia3/... — там модели нет. Реально
# она лежит в /app/tools/maia3/ (см. COPY tools/maia3 выше). По
# образцу apps/api/Dockerfile (`POSITION_COMMENT_MAIA_MODEL_PATH`)
# задаём абсолютный путь явно через ENV.
ENV PRECISION_MAIA_MODEL_PATH=/app/tools/maia3/maia3_simplified.onnx
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
