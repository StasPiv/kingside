FROM node:20-slim AS base

# KS-2433: Stockfish удалён из api-образа. Движок остаётся только в
# tactic-worker (когда выделим). Game-report и tactic-drill sf-validator
# больше не используют SF.
#
# KS-2363 / ADR-040: для board-recognition нужен Python 3 + OpenCV + ONNX
# runtime. Системные либы (libgl1/libglib2.0-0/libsm6/libxext6) — для
# `import cv2` под opencv-python-headless и Pillow.
# Python pip-пакеты (onnxruntime/numpy/opencv-python-headless/Pillow)
# ставим в финальной production-стадии — см. ниже.
#
# KS-3717: awscli (apt) убран — он тянул ~80 МБ python+boto. Скачивание
# моделей в entrypoint переведено на node-скрипт apps/api/scripts/
# download-model.mjs через @aws-sdk/client-s3 (он уже в dependencies).
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    python3 \
    python3-pip \
    python3-venv \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    ffmpeg \
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
COPY packages/board-image-to-fen ./packages/board-image-to-fen
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN rm -f packages/board-image-to-fen/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
# KS-2363 / ADR-040 §5.1: dist/ нужен в production для `await import(
# '@kingside/board-image-to-fen')` из BoardRecognitionService (lazy).
RUN npx tsc --build packages/board-image-to-fen
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
# KS-3058 / KS-3051 (ADR-045 E4): отбросить devDependencies (typescript,
# jest, ts-jest, @nestjs/cli, @types/*, ts-node-dev и т.п.). `prisma` CLI
# и `@prisma/client` остаются — `prisma` теперь в `dependencies` пакета
# packages/db (нужен в runtime для pre-rollout миграций через
# `aws ecs run-task` на этом же образе). `@prisma/engines` (schema-engine)
# уже скачан postinstall'ом выше — prune его не трогает (transitive
# runtime dep пакета prisma).
RUN npm prune --omit=dev --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/data ./apps/api/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
# KS-2363: board-image-to-fen tree включает dist/ (TS-обёртка) +
# src/python/* (board_detect.py / board_recognize.py — spawn'ятся через
# child_process). Без src/python модуль не сможет вызывать Python-стек.
COPY --from=build /app/packages/board-image-to-fen ./packages/board-image-to-fen
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/package.json ./apps/api/
# KS-3717: entrypoint вызывает node /app/apps/api/scripts/download-model.mjs
# для скачивания board-recognition моделей из S3 (замена aws s3 cp).
COPY apps/api/scripts ./apps/api/scripts

# KS-2363 / KS-2364: inference-зависимости для board-recognition.
# Используются board_recognize.py / board_detect.py когда
# BOARD_RECOG_MODEL_VERSION выставлен; в disabled-режиме Python вообще не
# запускается (BoardRecognitionService возвращает мок). Albumentations
# намеренно не ставим — это тренировочная аугментация, в inference не
# нужна.
RUN pip3 install --no-cache-dir --break-system-packages \
    numpy==1.26.4 \
    Pillow==10.4.0 \
    opencv-python-headless==4.10.0.84 \
    onnxruntime==1.19.2
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
RUN rm -rf node_modules/@kingside/board-image-to-fen && ln -s ../../packages/board-image-to-fen node_modules/@kingside/board-image-to-fen

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
