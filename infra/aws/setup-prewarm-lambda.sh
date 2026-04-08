#!/usr/bin/env bash
# Setup ECS pre-warming Lambda for tournament burst protection.
# Runs every 2 minutes, checks upcoming tournaments, scales ECS before start.
#
# Usage: bash infra/aws/setup-prewarm-lambda.sh
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
FUNCTION_NAME="kingside-ecs-prewarm"
ROLE_NAME="kingside-lambda-prewarm"
RULE_NAME="kingside-prewarm-schedule"
LAMBDA_DIR="$(cd "$(dirname "$0")/lambda-prewarm" && pwd)"

echo "=== Setup ECS Pre-warming Lambda ==="

# --- IAM Role ---
echo "[1/4] Creating IAM role..."
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" \
  --output text --query 'Role.Arn' 2>/dev/null || true

# Attach policies: CloudWatch Logs + ECS update
POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:UpdateService"
      ],
      "Resource": "*"
    }
  ]
}'

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${ROLE_NAME}-policy" \
  --policy-document "$POLICY" 2>/dev/null

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
echo "  Role: $ROLE_ARN"

# Wait for role propagation
sleep 10

# --- Lambda Function ---
echo "[2/4] Creating Lambda function..."
cd "$LAMBDA_DIR"
zip -j /tmp/prewarm-lambda.zip index.py

aws lambda create-function \
  --function-name "$FUNCTION_NAME" \
  --runtime python3.12 \
  --handler index.handler \
  --role "$ROLE_ARN" \
  --zip-file fileb:///tmp/prewarm-lambda.zip \
  --timeout 30 \
  --memory-size 128 \
  --environment "Variables={ECS_CLUSTER=kingside,ECS_SERVICE=kingside-api,API_URL=https://kingside.site,PREWARM_MINUTES=5,PLAYERS_PER_TASK=100}" \
  --region "$REGION" \
  --output text --query 'FunctionArn' 2>/dev/null \
|| aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file fileb:///tmp/prewarm-lambda.zip \
  --region "$REGION" \
  --output text --query 'FunctionArn'

echo "  Lambda: $FUNCTION_NAME"

# --- EventBridge Rule (every 2 minutes) ---
echo "[3/4] Creating EventBridge schedule..."
RULE_ARN=$(aws events put-rule \
  --name "$RULE_NAME" \
  --schedule-expression "rate(2 minutes)" \
  --state ENABLED \
  --region "$REGION" \
  --output text --query 'RuleArn')

echo "  Rule: $RULE_ARN"

# --- Connect Rule to Lambda ---
echo "[4/4] Adding Lambda target..."
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id "prewarm-eventbridge" \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "$RULE_ARN" \
  --region "$REGION" 2>/dev/null || true

aws events put-targets \
  --rule "$RULE_NAME" \
  --targets "Id=1,Arn=${LAMBDA_ARN}" \
  --region "$REGION" \
  --output text

echo ""
echo "=== Pre-warming Lambda deployed ==="
echo "  Function: $FUNCTION_NAME"
echo "  Schedule: every 2 minutes"
echo "  Config: prewarm ${PREWARM_MINUTES:-5}min before, ${PLAYERS_PER_TASK:-100} players/task"
