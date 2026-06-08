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

# KS-3709: вернуть значение запечённой версии из манифеста, который
# создаётся `RUN ... bake ... > baked-versions` в Dockerfile. Если
# манифеста нет (старый образ или bake не сработал в сборке) — вернёт
# пустую строку, и entrypoint пойдёт по медленному пути.
BAKED_MANIFEST="/var/cache/board-recog/baked-versions"
baked_version() {
  if [ -r "$BAKED_MANIFEST" ]; then
    grep "^${1}=" "$BAKED_MANIFEST" 2>/dev/null | head -1 | cut -d= -f2-
  fi
}

# KS-2363 / KS-2364 (ADR-040 §5.1): подкачка ONNX-модели board-recog из S3.
#
#   * BOARD_RECOG_MODEL_VERSION не задан → ничего не делаем; модуль
#     поднимется в disabled-режиме (см. ModelLoaderService) и будет
#     возвращать mock-ответ с warning «model not loaded». Это базовый
#     режим прода до выкатки модели.
#   * BOARD_RECOG_MODEL_VERSION задан и совпадает с запечённой версией
#     (KS-3709) → используем файл из образа, S3 не дёргаем.
#   * BOARD_RECOG_MODEL_VERSION задан и НЕ совпадает с запечённой → качаем
#     в /var/cache/board-recog/model.onnx. На любую ошибку (нет креды,
#     нет файла в S3, нет сети) — логируем и продолжаем без модели;
#     ModelLoaderService перейдёт в `error` и health-check это покажет,
#     но api-контейнер не упадёт (graceful disable).
#   * BOARD_RECOG_MODEL_DIR / BOARD_RECOG_MODEL_PATH — escape-hatches
#     для тестов: переопределяют каталог / точный путь.
download_board_recog_model() {
  version="${BOARD_RECOG_MODEL_VERSION:-}"
  if [ -z "$version" ]; then
    echo "[entrypoint] BOARD_RECOG_MODEL_VERSION not set — board-recognition disabled."
    return 0
  fi
  dir="${BOARD_RECOG_MODEL_DIR:-/var/cache/board-recog}"
  target="${BOARD_RECOG_MODEL_PATH:-$dir/model.onnx}"
  bucket="${BOARD_RECOG_MODEL_BUCKET:-kingside-ml}"
  region="${BOARD_RECOG_MODEL_REGION:-eu-central-1}"
  key="models/board-recog/v${version}/model.onnx"
  s3_uri="s3://${bucket}/${key}"

  # KS-3709: быстрый путь — версия в env совпадает с запечённой в образе.
  if [ -s "$target" ] && [ "$(baked_version BOARD_RECOG_MODEL_VERSION)" = "$version" ]; then
    echo "[entrypoint] board-recog model: using baked v$version → $target"
    return 0
  fi

  if [ -s "$target" ]; then
    echo "[entrypoint] board-recog model already cached at $target — skip download."
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  echo "[entrypoint] downloading board-recog model: $s3_uri -> $target"
  # KS-3717: awscli удалён из образа; используем node-скрипт с @aws-sdk/client-s3.
  if node /app/apps/api/scripts/download-model.mjs \
      --bucket "$bucket" --key "$key" --out "$target" --region "$region"; then
    echo "[entrypoint] board-recog model ready: $target ($(stat -c %s "$target") bytes)"
  else
    echo "[entrypoint] WARN: failed to download $s3_uri — board-recognition will start in error state." >&2
    rm -f "$target"
  fi
}

# KS-3091 v3 (corner-detector): рядом с classifier модели может лежать
# второй ONNX-файл `corner_detector.onnx`. Если задана версия и файл есть
# в S3 — качаем его в /var/cache/board-recog/corner_detector.onnx. Сам
# export `BOARD_DETECT_NN_MODEL` делается в основном shell после wait
# (KS-3709): фоновые subshell'ы не могут пробросить env наверх.
download_corner_detector() {
  version="${BOARD_RECOG_MODEL_VERSION:-}"
  if [ -z "$version" ]; then
    return 0
  fi
  dir="${BOARD_RECOG_MODEL_DIR:-/var/cache/board-recog}"
  target="$dir/corner_detector.onnx"
  bucket="${BOARD_RECOG_MODEL_BUCKET:-kingside-ml}"
  region="${BOARD_RECOG_MODEL_REGION:-eu-central-1}"
  key="models/board-recog/v${version}/corner_detector.onnx"
  s3_uri="s3://${bucket}/${key}"

  # KS-3709: запечённая версия совпала — отдельный файл уже либо есть
  # (запечён в сборке), либо его не было и в S3 (тогда bake его удалил).
  # В любом случае ходить в S3 не надо.
  if [ "$(baked_version BOARD_RECOG_MODEL_VERSION)" = "$version" ]; then
    if [ -s "$target" ]; then
      echo "[entrypoint] corner_detector: using baked v$version → $target"
    else
      echo "[entrypoint] corner_detector: not baked for v$version — falling back to opencv heuristic."
    fi
    return 0
  fi

  if [ -s "$target" ]; then
    echo "[entrypoint] corner_detector already cached at $target — skip download."
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  echo "[entrypoint] checking for corner_detector: $s3_uri"
  # KS-3717: awscli удалён; --quiet подавляет stderr для опционального файла
  # (раньше использовалось `2>/dev/null` рядом с `aws s3 cp`).
  if node /app/apps/api/scripts/download-model.mjs \
      --bucket "$bucket" --key "$key" --out "$target" --region "$region" --quiet; then
    echo "[entrypoint] corner_detector ready: $target ($(stat -c %s "$target") bytes)"
  else
    # Не критично: версия может быть без corner_detector (старые модели).
    # board_recognize.py упадёт обратно на opencv-эвристику.
    echo "[entrypoint] no corner_detector for v${version} — falling back to opencv heuristic."
    rm -f "$target"
  fi
}

# KS-3110 (find-boards Stage 0): отдельная YOLO-модель ищет все доски
# на исходном скриншоте. Префикс в S3 другой: `findboards_v<X>/model.onnx`.
# Опциональна — если не задан BOARD_FINDBOARDS_MODEL_VERSION, pipeline
# работает по-старому через corner-detector (один результат на запрос).
download_find_boards_model() {
  version="${BOARD_FINDBOARDS_MODEL_VERSION:-}"
  if [ -z "$version" ]; then
    echo "[entrypoint] BOARD_FINDBOARDS_MODEL_VERSION not set — find-boards disabled."
    return 0
  fi
  dir="${BOARD_RECOG_MODEL_DIR:-/var/cache/board-recog}"
  target="${BOARD_FINDBOARDS_MODEL_PATH:-$dir/findboards.onnx}"
  bucket="${BOARD_RECOG_MODEL_BUCKET:-kingside-ml}"
  region="${BOARD_RECOG_MODEL_REGION:-eu-central-1}"
  key="models/board-recog/findboards_v${version}/model.onnx"
  s3_uri="s3://${bucket}/${key}"

  # KS-3709: быстрый путь — версия в env совпадает с запечённой в образе.
  if [ -s "$target" ] && [ "$(baked_version BOARD_FINDBOARDS_MODEL_VERSION)" = "$version" ]; then
    echo "[entrypoint] find-boards model: using baked v$version → $target"
    return 0
  fi

  if [ -s "$target" ]; then
    echo "[entrypoint] find-boards model already cached at $target — skip download."
    return 0
  fi
  mkdir -p "$(dirname "$target")"
  echo "[entrypoint] downloading find-boards model: $s3_uri -> $target"
  # KS-3717: awscli удалён из образа; используем node-скрипт с @aws-sdk/client-s3.
  if node /app/apps/api/scripts/download-model.mjs \
      --bucket "$bucket" --key "$key" --out "$target" --region "$region"; then
    echo "[entrypoint] find-boards model ready: $target ($(stat -c %s "$target") bytes)"
  else
    echo "[entrypoint] WARN: failed to download $s3_uri — find-boards disabled, two-stage pipeline degraded to single-board." >&2
    rm -f "$target"
  fi
}

# KS-3709: запускаем три загрузки параллельно через `&` + `wait`. Если все
# модели уже запечены — функции вернут 0 сразу (~10 мс), параллелизм не
# вредит. Если нужен реальный S3 — три запроса идут одновременно и общее
# время равно времени самого медленного, а не сумме (раньше было ~7 с,
# теперь ~3 с). `wait` без аргумента дождётся всех бэкграундных задач.
download_board_recog_model &
PID_RECOG=$!
download_corner_detector &
PID_CORNER=$!
download_find_boards_model &
PID_FIND=$!
wait $PID_RECOG || true
wait $PID_CORNER || true
wait $PID_FIND || true

# KS-3091 / KS-3110: export'ы env для дочерних процессов (board_recognize.py)
# делаем в основном shell после wait — фоновые subshell'ы не могут
# пробросить env обратно.
MODEL_DIR="${BOARD_RECOG_MODEL_DIR:-/var/cache/board-recog}"
if [ -s "$MODEL_DIR/corner_detector.onnx" ]; then
  export BOARD_DETECT_NN_MODEL="$MODEL_DIR/corner_detector.onnx"
fi
if [ -s "${BOARD_FINDBOARDS_MODEL_PATH:-$MODEL_DIR/findboards.onnx}" ]; then
  export BOARD_FINDBOARDS_MODEL_PATH="${BOARD_FINDBOARDS_MODEL_PATH:-$MODEL_DIR/findboards.onnx}"
fi

echo "[entrypoint] Starting API..."
exec node dist/main.js
