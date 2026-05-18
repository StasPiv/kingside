#!/bin/sh
set -e

# KS-3050 (ADR-045 E3): миграции применяет pre-rollout `aws ecs run-task`
# из scripts/deploy-aws.sh ДО того, как новая ECS task стартует. Повтор
# `prisma migrate deploy` здесь — race-condition при параллельном
# rolling-update (две task'и пытаются мигрировать одновременно) плюс
# лишние 1–3 секунды на cold-start каждого контейнера.
#
# Оставлен escape-hatch: `RUN_MIGRATE_ON_START=true` вернёт прежнее
# поведение (локальный dev / экстренный deploy без run-task). По
# умолчанию выключено — прод полагается на pre-rollout.
#
# Историческая заметка (KS-2216): миграции на старте появились, когда
# pre-rollout ещё не было; сейчас оба источника избыточны.
if [ "${RUN_MIGRATE_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] RUN_MIGRATE_ON_START=true — applying Prisma migrations..."
  npx prisma migrate deploy
fi

# KS-2363 / KS-2364 (ADR-040 §5.1): подкачка ONNX-модели board-recog из S3.
#
#   * BOARD_RECOG_MODEL_VERSION не задан → ничего не делаем; модуль
#     поднимется в disabled-режиме (см. ModelLoaderService) и будет
#     возвращать mock-ответ с warning «model not loaded». Это базовый
#     режим прода до выкатки модели.
#   * BOARD_RECOG_MODEL_VERSION задан → пытаемся скачать в
#     /var/cache/board-recog/model.onnx. На любую ошибку (нет креды,
#     нет файла в S3, нет сети) — логируем и продолжаем без модели;
#     ModelLoaderService перейдёт в `error` и health-check это покажет,
#     но api-контейнер не упадёт (graceful disable).
#   * BOARD_RECOG_MODEL_DIR / BOARD_RECOG_MODEL_PATH — escape-hatches
#     для тестов: переопределяют каталог / точный путь.
download_board_recog_model() {
  local version="${BOARD_RECOG_MODEL_VERSION:-}"
  if [ -z "$version" ]; then
    echo "[entrypoint] BOARD_RECOG_MODEL_VERSION not set — board-recognition disabled."
    return 0
  fi
  local dir="${BOARD_RECOG_MODEL_DIR:-/var/cache/board-recog}"
  local target="${BOARD_RECOG_MODEL_PATH:-$dir/model.onnx}"
  local bucket="${BOARD_RECOG_MODEL_BUCKET:-kingside-ml}"
  local region="${BOARD_RECOG_MODEL_REGION:-eu-central-1}"
  local key="models/board-recog/v${version}/model.onnx"
  local s3_uri="s3://${bucket}/${key}"

  if [ -s "$target" ]; then
    echo "[entrypoint] board-recog model already cached at $target — skip download."
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  echo "[entrypoint] downloading board-recog model: $s3_uri -> $target"
  if aws s3 cp "$s3_uri" "$target" --region "$region"; then
    echo "[entrypoint] board-recog model ready: $target ($(stat -c %s "$target") bytes)"
  else
    echo "[entrypoint] WARN: failed to download $s3_uri — board-recognition will start in error state." >&2
    rm -f "$target"
  fi
}

# KS-3091 v3 (corner-detector): рядом с classifier модели может лежать
# второй ONNX-файл `corner_detector.onnx`. Если задана версия и файл есть
# в S3 — качаем его в /var/cache/board-recog/corner_detector.onnx и
# выставляем `BOARD_DETECT_NN_MODEL` для дочерних процессов (python
# board_recognize.py подхватит).
download_corner_detector() {
  local version="${BOARD_RECOG_MODEL_VERSION:-}"
  if [ -z "$version" ]; then
    return 0
  fi
  local dir="${BOARD_RECOG_MODEL_DIR:-/var/cache/board-recog}"
  local target="$dir/corner_detector.onnx"
  local bucket="${BOARD_RECOG_MODEL_BUCKET:-kingside-ml}"
  local region="${BOARD_RECOG_MODEL_REGION:-eu-central-1}"
  local key="models/board-recog/v${version}/corner_detector.onnx"
  local s3_uri="s3://${bucket}/${key}"

  if [ -s "$target" ]; then
    echo "[entrypoint] corner_detector already cached at $target — skip download."
    export BOARD_DETECT_NN_MODEL="$target"
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  echo "[entrypoint] checking for corner_detector: $s3_uri"
  if aws s3 cp "$s3_uri" "$target" --region "$region" 2>/dev/null; then
    echo "[entrypoint] corner_detector ready: $target ($(stat -c %s "$target") bytes)"
    export BOARD_DETECT_NN_MODEL="$target"
  else
    # Не критично: версия может быть без corner_detector (старые модели).
    # board_recognize.py упадёт обратно на opencv-эвристику.
    echo "[entrypoint] no corner_detector for v${version} — falling back to opencv heuristic."
    rm -f "$target"
  fi
}

download_board_recog_model
download_corner_detector

echo "[entrypoint] Starting API..."
exec node dist/main.js
