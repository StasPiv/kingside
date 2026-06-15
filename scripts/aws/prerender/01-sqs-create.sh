#!/usr/bin/env bash
# Создание SQS-очереди kingside-prerender-tasks и DLQ.
# ADR-128 §7.3, KS-4191.
#
# Идемпотентно: если очередь уже существует, обновляет только атрибуты.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

MAIN_NAME="kingside-prerender-tasks"
DLQ_NAME="kingside-prerender-tasks-dlq"

VISIBILITY_TIMEOUT=60
MAIN_RETENTION=604800   # 7 дней
DLQ_RETENTION=1209600   # 14 дней (стандарт для DLQ)
MAX_RECEIVE_COUNT=3

echo "[sqs] Region=$REGION Account=$ACCOUNT"

# --- DLQ ---
DLQ_URL="$(aws sqs get-queue-url --queue-name "$DLQ_NAME" --region "$REGION" --query QueueUrl --output text 2>/dev/null || true)"
if [[ -z "$DLQ_URL" || "$DLQ_URL" == "None" ]]; then
    echo "[sqs] Creating DLQ $DLQ_NAME"
    DLQ_URL="$(aws sqs create-queue \
        --queue-name "$DLQ_NAME" \
        --region "$REGION" \
        --attributes "MessageRetentionPeriod=$DLQ_RETENTION" \
        --tags "Project=Kingside,Component=prerender,Role=dlq" \
        --query QueueUrl --output text)"
else
    echo "[sqs] DLQ $DLQ_NAME exists: $DLQ_URL"
    aws sqs set-queue-attributes \
        --queue-url "$DLQ_URL" \
        --region "$REGION" \
        --attributes "MessageRetentionPeriod=$DLQ_RETENTION"
fi

DLQ_ARN="$(aws sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --region "$REGION" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text)"
echo "[sqs] DLQ ARN: $DLQ_ARN"

# --- Main ---
MAIN_URL="$(aws sqs get-queue-url --queue-name "$MAIN_NAME" --region "$REGION" --query QueueUrl --output text 2>/dev/null || true)"
REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":$MAX_RECEIVE_COUNT}"

if [[ -z "$MAIN_URL" || "$MAIN_URL" == "None" ]]; then
    echo "[sqs] Creating main queue $MAIN_NAME"
    # tmp-файл из-за необходимости передать JSON в --attributes
    TMP_ATTR="$(mktemp)"
    cat > "$TMP_ATTR" <<EOF
{
  "VisibilityTimeout": "$VISIBILITY_TIMEOUT",
  "MessageRetentionPeriod": "$MAIN_RETENTION",
  "RedrivePolicy": "$(printf '%s' "$REDRIVE_POLICY" | sed 's/"/\\"/g')"
}
EOF
    MAIN_URL="$(aws sqs create-queue \
        --queue-name "$MAIN_NAME" \
        --region "$REGION" \
        --attributes "file://$TMP_ATTR" \
        --tags "Project=Kingside,Component=prerender,Role=main" \
        --query QueueUrl --output text)"
    rm -f "$TMP_ATTR"
else
    echo "[sqs] Main queue $MAIN_NAME exists: $MAIN_URL"
    TMP_ATTR="$(mktemp)"
    cat > "$TMP_ATTR" <<EOF
{
  "VisibilityTimeout": "$VISIBILITY_TIMEOUT",
  "MessageRetentionPeriod": "$MAIN_RETENTION",
  "RedrivePolicy": "$(printf '%s' "$REDRIVE_POLICY" | sed 's/"/\\"/g')"
}
EOF
    aws sqs set-queue-attributes \
        --queue-url "$MAIN_URL" \
        --region "$REGION" \
        --attributes "file://$TMP_ATTR"
    rm -f "$TMP_ATTR"
fi

MAIN_ARN="$(aws sqs get-queue-attributes \
    --queue-url "$MAIN_URL" \
    --region "$REGION" \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text)"
echo "[sqs] Main ARN: $MAIN_ARN"

cat <<EOF

[sqs] Done.
  MAIN_URL=$MAIN_URL
  MAIN_ARN=$MAIN_ARN
  DLQ_URL=$DLQ_URL
  DLQ_ARN=$DLQ_ARN
EOF
