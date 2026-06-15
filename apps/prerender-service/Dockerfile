# KS-4194 / ADR-128 §7.3. Dockerfile для apps/prerender-service.
#
# База — официальный Playwright image: тянет Chromium и все системные
# зависимости (libnss, fonts, …). Multi-stage: build на debian-based
# playwright (там есть node), runtime — тот же image (с браузером),
# куда копируем уже скомпилированный dist + production node_modules.
#
# Build context — корень монорепо (`docker build -f apps/prerender-service/Dockerfile .`),
# чтобы packages/shared был доступен.
#
# Зафиксирована версия playwright — должна совпадать с зависимостью
# в package.json. При апгрейде менять оба места и пересобирать.

ARG PLAYWRIGHT_VERSION=v1.60.0-jammy
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS base
WORKDIR /app

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/prerender-service/package.json apps/prerender-service/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/prerender-service ./apps/prerender-service
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN npx tsc --build packages/shared
RUN cd apps/prerender-service && npx tsc -p tsconfig.json
RUN npm prune --omit=dev --ignore-scripts

FROM base AS production
WORKDIR /app
COPY --from=build /app/apps/prerender-service/dist ./apps/prerender-service/dist
COPY --from=build /app/apps/prerender-service/package.json ./apps/prerender-service/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
# Symlink на shared для @kingside/shared import.
RUN rm -rf node_modules/@kingside/shared && ln -s ../../packages/shared node_modules/@kingside/shared

ENV NODE_ENV=production
ENV AWS_REGION=eu-central-1
ENV PRERENDER_BASE_URL=https://kingside.site
# SQS_QUEUE_URL и S3_PRERENDER_BUCKET передаются ECS task definition'ом.

WORKDIR /app/apps/prerender-service
CMD ["node", "dist/index.js"]
