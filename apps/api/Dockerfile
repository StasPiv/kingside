FROM node:20-slim AS base

# KS-2433: Stockfish удалён из api-образа. Движок остаётся только в
# tactic-worker (когда выделим). Game-report и tactic-drill sf-validator
# больше не используют SF.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/game-service/package.json apps/game-service/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN npm ci --ignore-scripts
# KS-2216: отдельно запускаем postinstall @prisma/engines (он же скачивает schema-engine
# для текущей платформы). Без этого `npx prisma migrate deploy` в production-стадии
# не находит бинарь schema-engine для debian-openssl-3.0.x.
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
# KS-3051 (ADR-045 E4): отбросить devDependencies (typescript, jest,
# ts-jest, @nestjs/cli, @types/*, ts-node-dev и т.п.). `prisma` CLI и
# `@prisma/client` остаются — они переехали в `dependencies` пакета
# packages/db и нужны в runtime для pre-rollout миграций через
# `aws ecs run-task` на этом же образе.
# `@prisma/engines` (schema-engine) уже скачан postinstall'ом выше —
# prune его не трогает (transitive runtime dep пакета prisma).
RUN npm prune --omit=dev --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/data ./apps/api/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/package.json ./apps/api/
# KS-2967 / ADR-063 Phase 2 — rollback. KnowledgeModule отключён от
# bootstrap'а в apps/api/src/app.module.ts. ripgrep, COPY apps/web/src,
# COPY docs убраны, чтобы не раздувать build context и не плодить
# layer'ы под отключённую фичу. Когда Phase 2 вернётся (после
# пересмотра политики экспонирования путей/фрагментов кода через
# ассистент и расширения build-context на deploy-runner'е) — вернуть
# `apt-get install -y --no-install-recommends ripgrep` и нужные COPY
# из подмножества allowlist'а.
# KS-2411: AWS RDS global CA bundle для verify-full подключения к
# archive-RDS из индексера (`scripts/index-tactic-drills`,
# `tactic-drill-incremental.scheduler`). Заменяет NODE_TLS_REJECT_UNAUTHORIZED=0
# в RunTask'ах. Bundle тот же, что в apps/archive-service/certs/.
COPY apps/api/certs ./apps/api/certs
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared
RUN rm -rf node_modules/@kingside/db && ln -s ../../packages/db node_modules/@kingside/db

ENV NODE_ENV=production
# KS-2411: Node автоматически подхватывает этот CA bundle для всех
# TLS-соединений (pg, https, fetch). Безопаснее глобального bypass'а
# через NODE_TLS_REJECT_UNAUTHORIZED=0. Путь можно переопределить
# через ENV в task-def при необходимости (например, под regional bundle).
ENV NODE_EXTRA_CA_CERTS=/app/apps/api/certs/rds-ca.pem

EXPOSE 3001

WORKDIR /app/apps/api
COPY apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
