#!/usr/bin/env bash
# IAM-роли для prerender-пайплайна.
# ADR-128 §7.3, KS-4191.
#
# 1) kingside-prerender-worker-role  — для будущего ECS-таска (KS-9).
#    Trust: ecs-tasks.amazonaws.com
#    Permissions: чтение/удаление сообщений из SQS kingside-prerender-tasks,
#                 запись объектов в S3 kingside-prerender-store/*.
# 2) kingside-prerender-publisher-role — для backend (KS-10).
#    Trust: ecs-tasks.amazonaws.com (backend живёт в ECS).
#    Permissions: только sqs:SendMessage на kingside-prerender-tasks.
#
# Идемпотентно.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

QUEUE_NAME="kingside-prerender-tasks"
DLQ_NAME="kingside-prerender-tasks-dlq"
BUCKET="kingside-prerender-store"

QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:${QUEUE_NAME}"
DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:${DLQ_NAME}"
BUCKET_ARN="arn:aws:s3:::${BUCKET}"

WORKER_ROLE="kingside-prerender-worker-role"
PUBLISHER_ROLE="kingside-prerender-publisher-role"

TRUST_DOC='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }
  ]
}'

create_or_update_role() {
    local role_name="$1"
    local description="$2"
    if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
        echo "[iam] Role $role_name exists — updating trust policy"
        aws iam update-assume-role-policy \
            --role-name "$role_name" \
            --policy-document "$TRUST_DOC"
    else
        echo "[iam] Creating role $role_name"
        aws iam create-role \
            --role-name "$role_name" \
            --assume-role-policy-document "$TRUST_DOC" \
            --description "$description" \
            --tags 'Key=Project,Value=Kingside' 'Key=Component,Value=prerender'
    fi
}

put_inline_policy() {
    local role_name="$1"
    local policy_name="$2"
    local policy_doc="$3"
    echo "[iam] Putting inline policy $policy_name on $role_name"
    aws iam put-role-policy \
        --role-name "$role_name" \
        --policy-name "$policy_name" \
        --policy-document "$policy_doc"
}

# ---------- WORKER ROLE ----------
create_or_update_role "$WORKER_ROLE" "Kingside prerender ECS worker (KS-4191, ADR-128)"

WORKER_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadFromQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": "${QUEUE_ARN}"
    },
    {
      "Sid": "WriteToPrerenderStore",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "${BUCKET_ARN}/*"
    },
    {
      "Sid": "ListPrerenderStore",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "${BUCKET_ARN}"
    }
  ]
}
EOF
)
put_inline_policy "$WORKER_ROLE" "kingside-prerender-worker-policy" "$WORKER_POLICY"

# ---------- PUBLISHER ROLE ----------
create_or_update_role "$PUBLISHER_ROLE" "Kingside prerender SQS publisher for backend (KS-4191, ADR-128)"

PUBLISHER_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendToPrerenderQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueUrl"
      ],
      "Resource": "${QUEUE_ARN}"
    }
  ]
}
EOF
)
put_inline_policy "$PUBLISHER_ROLE" "kingside-prerender-publisher-policy" "$PUBLISHER_POLICY"

echo
echo "[iam] Done."
echo "  Worker role ARN:    arn:aws:iam::${ACCOUNT}:role/${WORKER_ROLE}"
echo "  Publisher role ARN: arn:aws:iam::${ACCOUNT}:role/${PUBLISHER_ROLE}"
