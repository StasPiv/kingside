#!/usr/bin/env bash
# Создание/обновление Lambda@Edge kingside-prerender-fallback в us-east-1.
# ADR-128 §7.3.4, KS-4191.
#
# Требования Lambda@Edge:
#   - Регион функции: us-east-1.
#   - Trust policy: lambda.amazonaws.com И edgelambda.amazonaws.com.
#   - Нельзя env vars и > 1 МБ (для viewer events; origin events до 5 МБ).
#   - В CloudFront ссылаемся на фиксированную версию (не $LATEST).
#
# IAM-роль `kingside-prerender-edge-role` со inline-policy на чтение
# kingside-frontend/index.html.
#
# Идемпотентно: create-or-update + publish-version.

set -euo pipefail

EDGE_REGION="us-east-1"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

ROLE_NAME="kingside-prerender-edge-role"
FN_NAME="kingside-prerender-fallback"
RUNTIME="nodejs20.x"
HANDLER="index.handler"
SRC_DIR="$(cd "$(dirname "$0")/lambda-edge" && pwd)"
FRONTEND_BUCKET="kingside-frontend-342946498289"

echo "[edge] Region=$EDGE_REGION Function=$FN_NAME"

# --- 1) IAM role ---
TRUST_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
      },
      "Action": "sts:AssumeRole"
    }
  ]
}'

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "[edge] IAM role $ROLE_NAME exists — обновляю trust policy"
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_DOC"
else
    echo "[edge] Создаю IAM role $ROLE_NAME"
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_DOC" \
        --description "Lambda@Edge prerender fallback (KS-4191, ADR-128)" \
        --tags 'Key=Project,Value=Kingside' 'Key=Component,Value=prerender' >/dev/null
fi

# Базовая Lambda execution policy + S3 read доступ
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" || true

INLINE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadFrontendIndexHtml",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${FRONTEND_BUCKET}/index.html"
    }
  ]
}
EOF
)
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "kingside-prerender-edge-s3" \
    --policy-document "$INLINE_POLICY"

ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"
echo "[edge] Role ARN: $ROLE_ARN"

# IAM eventual consistency — даём роли время разъехаться по регионам.
# Без этого create-function иногда падает с InvalidParameterValueException.
echo "[edge] Жду 10 с для propagation IAM-роли"
sleep 10

# --- 2) Package ---
TMP_DIR="$(mktemp -d)"
ZIP_PATH="$TMP_DIR/lambda-edge.zip"
echo "[edge] Пакую $SRC_DIR → $ZIP_PATH"
python3 - <<PYEOF
import os, zipfile
src = "$SRC_DIR"
dst = "$ZIP_PATH"
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for fn in files:
            full = os.path.join(root, fn)
            arc = os.path.relpath(full, src)
            z.write(full, arc)
print("Wrote", dst)
PYEOF
ls -la "$ZIP_PATH"

# --- 3) Create or update function ---
FN_EXISTS="$(aws lambda get-function \
    --region "$EDGE_REGION" \
    --function-name "$FN_NAME" \
    --query "Configuration.FunctionName" \
    --output text 2>/dev/null || true)"

if [[ -z "$FN_EXISTS" || "$FN_EXISTS" == "None" ]]; then
    echo "[edge] Создаю Lambda $FN_NAME"
    aws lambda create-function \
        --region "$EDGE_REGION" \
        --function-name "$FN_NAME" \
        --runtime "$RUNTIME" \
        --role "$ROLE_ARN" \
        --handler "$HANDLER" \
        --zip-file "fileb://$ZIP_PATH" \
        --timeout 5 \
        --memory-size 128 \
        --description "Prerender 404 fallback (ADR-128, KS-4191)" \
        --tags "Project=Kingside,Component=prerender" >/dev/null
    # Ждём State=Active — без этого publish-version упадёт ResourceConflictException.
    for i in $(seq 1 30); do
        STATE="$(aws lambda get-function \
            --region "$EDGE_REGION" \
            --function-name "$FN_NAME" \
            --query "Configuration.State" \
            --output text)"
        if [[ "$STATE" == "Active" ]]; then break; fi
        echo "[edge]   …State=$STATE, жду 2 с"
        sleep 2
    done
else
    echo "[edge] Обновляю код Lambda $FN_NAME"
    aws lambda update-function-code \
        --region "$EDGE_REGION" \
        --function-name "$FN_NAME" \
        --zip-file "fileb://$ZIP_PATH" >/dev/null
fi

# Ждём LastUpdateStatus=Successful — publish-version упадёт если ещё InProgress.
for i in $(seq 1 30); do
    STATUS="$(aws lambda get-function \
        --region "$EDGE_REGION" \
        --function-name "$FN_NAME" \
        --query "Configuration.LastUpdateStatus" \
        --output text)"
    if [[ "$STATUS" == "Successful" ]]; then break; fi
    echo "[edge]   …LastUpdateStatus=$STATUS, жду 2 с"
    sleep 2
done

# --- 4) Publish version ---
echo "[edge] Публикую версию"
VERSION="$(aws lambda publish-version \
    --region "$EDGE_REGION" \
    --function-name "$FN_NAME" \
    --description "$(date -u +%Y-%m-%dT%H:%M:%SZ) KS-4191" \
    --query "Version" --output text)"
LAMBDA_ARN="arn:aws:lambda:${EDGE_REGION}:${ACCOUNT}:function:${FN_NAME}:${VERSION}"

echo
echo "[edge] Готово."
echo "  Function: $FN_NAME"
echo "  Version : $VERSION"
echo "  ARN     : $LAMBDA_ARN"
echo
echo "  Передай ARN в 06-distribution-wire-up.sh:"
echo "    LAMBDA_EDGE_ARN=\"$LAMBDA_ARN\" bash 06-distribution-wire-up.sh"

rm -rf "$TMP_DIR"
