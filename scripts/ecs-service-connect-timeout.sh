#!/usr/bin/env bash
# KS-4924: Service Connect (Envoy sidecar) у kingside-api по умолчанию рвал
# запросы на 15 с (504 "upstream request timeout" от envoy). Синхронные
# LLM-endpoints (/analyses/position/comment, /analyses/review/move-comment,
# review-comment) легитимно работают 5-40+ с (LLM-webhook, таймаут 180 с,
# ADR-108 §92) — шлюз должен ждать дольше.
#
# Фикс: perRequestTimeoutSeconds/idleTimeoutSeconds = 300 в
# serviceConnectConfiguration сервиса. Обычный деплой (deploy-aws.sh →
# update-service --task-definition) SC-конфигурацию НЕ трогает, поэтому
# настройка переживает деплои. Скрипт нужен ТОЛЬКО при пересоздании сервиса
# kingside-api с нуля — запустить один раз после create-service.
#
# Идемпотентен: повторный запуск просто переустанавливает те же значения.
set -euo pipefail

CLUSTER="${ECS_CLUSTER:-kingside}"
SERVICE="${ECS_SERVICE:-kingside-api}"
TIMEOUT_S="${SC_TIMEOUT_SECONDS:-300}"

echo "[sc-timeout] ${CLUSTER}/${SERVICE}: perRequest/idle = ${TIMEOUT_S}s"

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --service-connect-configuration "{
      \"enabled\": true,
      \"namespace\": \"kingside.local\",
      \"services\": [{
        \"portName\": \"api\",
        \"discoveryName\": \"api\",
        \"clientAliases\": [{\"port\": 3001, \"dnsName\": \"api\"}],
        \"timeout\": {
          \"idleTimeoutSeconds\": ${TIMEOUT_S},
          \"perRequestTimeoutSeconds\": ${TIMEOUT_S}
        }
      }]
    }" \
    --query 'service.deployments[0].rolloutState' --output text

echo "[sc-timeout] Waiting for services-stable..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].deployments[0].serviceConnectConfiguration.services[0].timeout' \
    --output json
echo "[sc-timeout] Done."
