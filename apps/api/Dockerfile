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
# KS-3924: cache-bust для invalidate'а слоя `npm ci` после переноса prisma
# в devDependencies. Docker buildkit на предыдущей выкладке закешировал
# `RUN npm ci`, несмотря на изменения в package-lock.json — приходится
# менять что-то в build-контексте перед COPY package-lock.json, чтобы
# хеш слоёв поехал. Эту строку можно удалить в следующем коммите.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/game-service/package.json apps/game-service/
COPY apps/e2e/package.json apps/e2e/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
# KS-4247 / ADR-131 A1: archive-db нужен для нового модуля archive
# в apps/api (отдельный PrismaClient).
COPY packages/archive-db/package.json packages/archive-db/
# KS-4070: position-comment подключает Maia-3 как forced-line фильтр
# (apps/api/src/position-comment/maia.service.ts через @kingside/maia-core).
# Сам пакет резолвится из packages/maia-core (workspace symlink), его
# package.json нужен до `npm ci`, чтобы зависимость не была NotFound.
COPY packages/maia-core/package.json packages/maia-core/
RUN npm ci --ignore-scripts
# KS-2216: отдельно запускаем postinstall @prisma/engines (он же скачивает schema-engine
# для текущей платформы). Без этого `npx prisma migrate deploy` в production-стадии
# не находит бинарь schema-engine для debian-openssl-3.0.x.
RUN node node_modules/@prisma/engines/scripts/postinstall.js
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/archive-db ./packages/archive-db
COPY packages/board-image-to-fen ./packages/board-image-to-fen
COPY packages/maia-core ./packages/maia-core
COPY apps/api ./apps/api
COPY tsconfig.base.json ./
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN rm -f packages/board-image-to-fen/tsconfig.tsbuildinfo
RUN rm -f packages/maia-core/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
# KS-2363 / ADR-040 §5.1: dist/ нужен в production для `await import(
# '@kingside/board-image-to-fen')` из BoardRecognitionService (lazy).
RUN npx tsc --build packages/board-image-to-fen
# KS-4070: пакет @kingside/maia-core нужен для position-comment Maia-фильтра.
# Собираем в build-стадии до nest build, чтобы apps/api подхватил его типы.
RUN npx tsc --build packages/maia-core
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
# KS-4247 / ADR-131 A1: собираем archive-db (prisma generate + tsc + copy engines).
RUN cd packages/archive-db && ARCHIVE_DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
RUN cd apps/api && DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npm run build
# KS-3058 / KS-3051 (ADR-045 E4): отбросить devDependencies (typescript,
# jest, ts-jest, @nestjs/cli, @types/*, ts-node-dev и т.п.).
#
# KS-3924 (deploy-perf): `prisma` CLI перенесена в `devDependencies`
# пакета `packages/db`, в runtime api больше не нужна — pre-rollout
# `prisma migrate deploy` теперь выполняется отдельным миграционным
# образом (`kingside-api-migrations`). Однако `@prisma/client` объявляет
# `prisma` как `peerDependency` с `optional: true` → npm помечает её
# `devOptional: true` и `--omit=dev` её НЕ убирает. Поэтому добавлен
# `--omit=optional`: это убирает прицельно `devOptional`-стек prisma
# (`@prisma/config`, `@prisma/engines`, `effect`, `fast-check`, `jiti`,
# `c12` и т.п.) + платформ-специфичные нативные модули, не нужные в
# linux/x64 контейнере (`@esbuild/darwin-*`, `@rollup/rollup-win32-*`,
# `fsevents`, `pg-cloudflare`). Сгенерированный `@prisma/client` уже
# лежит в `packages/db/dist/generated/prisma` (создан выше через
# `npm run build` пакета `packages/db` ДО prune), runtime работает без
# CLI.
RUN npm prune --omit=dev --omit=optional --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/db ./packages/db
# KS-4247 / ADR-131 A1: archive-db нужен в runtime для @kingside/archive-db
# resolve (отдельный PrismaClient в новом archive-модуле).
COPY --from=build /app/packages/archive-db ./packages/archive-db
# KS-2363: board-image-to-fen tree включает dist/ (TS-обёртка) +
# src/python/* (board_detect.py / board_recognize.py — spawn'ятся через
# child_process). Без src/python модуль не сможет вызывать Python-стек.
COPY --from=build /app/packages/board-image-to-fen ./packages/board-image-to-fen
# KS-4070: @kingside/maia-core для position-comment forced-line фильтра
# (apps/api/src/position-comment/maia.service.ts).
COPY --from=build /app/packages/maia-core ./packages/maia-core
# KS-4070: ONNX-модель Maia-3 (44 МБ, gitignored). Тот же шаблон, что в
# apps/tactic-worker/Dockerfile. Путь задаётся ENV
# POSITION_COMMENT_MAIA_MODEL_PATH (default /project/tools/maia3/
# maia3_simplified.onnx, переопределяется в production на /app/tools/
# maia3/maia3_simplified.onnx через переменную окружения сервиса).
COPY tools/maia3 ./tools/maia3
# KS-4070: Stockfish-trace бинарь (FactorsRebuilderService) в образ
# временно не включается — он gitignored (tools/stockfish-trace/.gitignore:
# src/stockfish*), и build context из git его не получает. Без бинаря
# `POSITION_COMMENT_FACTORS_REBUILD_ENABLED=false` отключает пересборку
# factors на финальной FEN; Maia-фильтр работает, но модель получит
# исходные factors с initial_fen — поведение откатано к состоянию до
# rebuild'а. Подключение бинаря — отдельная задача под devops (положить
# в S3 / pre-build pull / GitHub Release).
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY apps/api/package.json ./apps/api/
# KS-3717: entrypoint вызывает node /app/apps/api/scripts/download-model.mjs
# для скачивания board-recognition моделей из S3 (замена aws s3 cp).
COPY apps/api/scripts ./apps/api/scripts

# KS-3709: предзапечённые модели копируются из build-context
# (см. scripts/deploy-aws.sh, блок «Pre-baking board-recognition models»).
# Если каталог .bake-cache пуст — entrypoint в рантайме пойдёт по
# медленному пути через download-model.mjs (без регрессии).
RUN mkdir -p /var/cache/board-recog
COPY apps/api/.bake-cache/ /var/cache/board-recog/

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
# KS-4070: символическая ссылка на maia-core, по образцу tactic-worker.
RUN rm -rf node_modules/@kingside/maia-core && ln -s ../../packages/maia-core node_modules/@kingside/maia-core

ENV NODE_ENV=production
# KS-2411: Node автоматически подхватывает этот CA bundle для всех
# TLS-соединений (pg, https, fetch). Безопаснее глобального bypass'а
# через NODE_TLS_REJECT_UNAUTHORIZED=0. Путь можно переопределить
# через ENV в task-def при необходимости (например, под regional bundle).
ENV NODE_EXTRA_CA_CERTS=/app/apps/api/certs/rds-ca.pem
# KS-4070: путь к ONNX-модели Maia-3 для position-comment forced-line
# фильтра. WORKDIR в production = /app/apps/api, поэтому относительный
# путь не сработает — задаём абсолютным.
ENV POSITION_COMMENT_MAIA_MODEL_PATH=/app/tools/maia3/maia3_simplified.onnx
# KS-4070: Stockfish-trace бинарь не включён в образ (см. COPY-блок).
# Отключаем пересборку factors на финальной FEN — Maia-фильтр работает,
# модель получит исходные factors с initial_fen. Включить, как только
# devops положит бинарь в build context.
ENV POSITION_COMMENT_FACTORS_REBUILD_ENABLED=false

EXPOSE 3001

WORKDIR /app/apps/api
COPY apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
