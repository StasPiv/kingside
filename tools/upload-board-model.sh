#!/usr/bin/env bash
# KS-2364 (ADR-040 §5.3). Публикует ONNX-модель board-recog и evaluation
# report в S3 `kingside-ml/models/board-recog/v<MAJOR>.<MINOR>/`.
#
# Использование:
#   tools/upload-board-model.sh <version> <model.onnx> <evaluation_report.json>
# Пример:
#   tools/upload-board-model.sh 1.0.0 ./model_v1.0.0.onnx ./evaluation_report.json
#
# После заливки выводит готовое значение для ENV BOARD_RECOG_MODEL_VERSION,
# которое нужно прописать в ECS task definition kingside-api.
set -euo pipefail

BUCKET="kingside-ml"
REGION="eu-central-1"

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <version> <model.onnx> <evaluation_report.json>" >&2
  echo "version format: <MAJOR>.<MINOR> or <MAJOR>.<MINOR>.<PATCH> (e.g. 1.0.0)" >&2
  exit 2
fi

VERSION="$1"
MODEL_PATH="$2"
REPORT_PATH="$3"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "error: version must match <MAJOR>.<MINOR>[.<PATCH>], got: $VERSION" >&2
  exit 2
fi

for f in "$MODEL_PATH" "$REPORT_PATH"; do
  if [[ ! -f "$f" ]]; then
    echo "error: file not found: $f" >&2
    exit 2
  fi
done

# Минимальная проверка ONNX — magic-байты "ONNX" в первых байтах файла.
# Сильная валидация (opset/shape) — на стороне backend при загрузке.
if ! head -c 16 "$MODEL_PATH" | grep -q "ONNX"; then
  echo "warning: $MODEL_PATH не похож на ONNX (magic не найден)" >&2
fi

# Минимальная проверка report — валидный JSON.
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$REPORT_PATH" >/dev/null 2>&1; then
  echo "error: $REPORT_PATH не валидный JSON" >&2
  exit 2
fi

PREFIX="models/board-recog/v${VERSION}"
S3_MODEL="s3://${BUCKET}/${PREFIX}/model.onnx"
S3_REPORT="s3://${BUCKET}/${PREFIX}/evaluation_report.json"

# Проверка: не перезаписываем уже опубликованную версию (immutable releases).
if aws s3api head-object --bucket "$BUCKET" --key "${PREFIX}/model.onnx" --region "$REGION" >/dev/null 2>&1; then
  echo "error: версия v${VERSION} уже опубликована (${S3_MODEL}). Бамп MINOR/PATCH." >&2
  exit 1
fi

MODEL_SHA=$(sha256sum "$MODEL_PATH" | awk '{print $1}')
REPORT_SHA=$(sha256sum "$REPORT_PATH" | awk '{print $1}')

echo "==> upload model:  $MODEL_PATH -> $S3_MODEL"
aws s3 cp "$MODEL_PATH" "$S3_MODEL" \
  --region "$REGION" \
  --content-type "application/octet-stream" \
  --metadata "sha256=${MODEL_SHA},version=${VERSION}"

echo "==> upload report: $REPORT_PATH -> $S3_REPORT"
aws s3 cp "$REPORT_PATH" "$S3_REPORT" \
  --region "$REGION" \
  --content-type "application/json" \
  --metadata "sha256=${REPORT_SHA},version=${VERSION}"

cat <<EOF

=== board-recog model v${VERSION} published ===
model:  ${S3_MODEL}  sha256=${MODEL_SHA}
report: ${S3_REPORT}  sha256=${REPORT_SHA}

Next step (devops): обновить ECS task definition kingside-api,
выставить ENV BOARD_RECOG_MODEL_VERSION=${VERSION} и задеплоить.
EOF
