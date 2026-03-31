#!/bin/bash
# Setup ECS Task Definition + Secrets Manager for Kingside API
# Usage: bash infra/aws/setup-task-definition.sh
#
# Prerequisites: ECR image pushed, RDS, ElastiCache, ECS Cluster created

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/kingside-api"

echo "=== Setting up Task Definition ==="

# 1. Check secret exists
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id kingside/api --query 'ARN' --output text 2>/dev/null || echo "")
if [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" = "None" ]; then
    echo "ERROR: Secret kingside/api not found. Create it first:"
    echo "  aws secretsmanager create-secret --name kingside/api --secret-string '{...}'"
    exit 1
fi
echo "  Secret: $SECRET_ARN"

# 2. Create log group (idempotent)
aws logs create-log-group --log-group-name /ecs/kingside-api 2>/dev/null || true
echo "  Log group: /ecs/kingside-api"

# 3. Grant ecsTaskExecutionRole access to secrets
aws iam put-role-policy \
    --role-name ecsTaskExecutionRole \
    --policy-name kingside-secrets-access \
    --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Action\": [\"secretsmanager:GetSecretValue\"],
    \"Resource\": \"arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/*\"
  }]
}" 2>/dev/null
echo "  Secrets policy attached to ecsTaskExecutionRole"

# 4. Register task definition
echo "  Registering task definition..."
aws ecs register-task-definition \
    --family kingside-api \
    --network-mode awsvpc \
    --requires-compatibilities FARGATE \
    --cpu 256 \
    --memory 512 \
    --execution-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole" \
    --task-role-arn "arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole" \
    --container-definitions "[{
      \"name\": \"kingside-api\",
      \"image\": \"${ECR_URI}:latest\",
      \"essential\": true,
      \"portMappings\": [{\"containerPort\": 3001, \"protocol\": \"tcp\"}],
      \"healthCheck\": {
        \"command\": [\"CMD-SHELL\", \"curl -f http://localhost:3001/api/health || exit 1\"],
        \"interval\": 30, \"timeout\": 5, \"retries\": 3, \"startPeriod\": 60
      },
      \"environment\": [
        {\"name\": \"PORT\", \"value\": \"3001\"},
        {\"name\": \"NODE_ENV\", \"value\": \"production\"},
        {\"name\": \"STOCKFISH_PATH\", \"value\": \"/usr/games/stockfish\"},
        {\"name\": \"STOCKFISH_MAX_INSTANCES\", \"value\": \"1\"}
      ],
      \"secrets\": [
        {\"name\": \"DATABASE_URL\", \"valueFrom\": \"${SECRET_ARN}:DATABASE_URL::\"},
        {\"name\": \"REDIS_URL\", \"valueFrom\": \"${SECRET_ARN}:REDIS_URL::\"},
        {\"name\": \"REDIS_HOST\", \"valueFrom\": \"${SECRET_ARN}:REDIS_HOST::\"},
        {\"name\": \"REDIS_PORT\", \"valueFrom\": \"${SECRET_ARN}:REDIS_PORT::\"},
        {\"name\": \"JWT_SECRET\", \"valueFrom\": \"${SECRET_ARN}:JWT_SECRET::\"},
        {\"name\": \"CORS_ORIGIN\", \"valueFrom\": \"${SECRET_ARN}:CORS_ORIGIN::\"},
        {\"name\": \"GOOGLE_CLIENT_ID\", \"valueFrom\": \"${SECRET_ARN}:GOOGLE_CLIENT_ID::\"},
        {\"name\": \"GOOGLE_CLIENT_SECRET\", \"valueFrom\": \"${SECRET_ARN}:GOOGLE_CLIENT_SECRET::\"},
        {\"name\": \"GOOGLE_CALLBACK_URL\", \"valueFrom\": \"${SECRET_ARN}:GOOGLE_CALLBACK_URL::\"},
        {\"name\": \"FACEBOOK_APP_ID\", \"valueFrom\": \"${SECRET_ARN}:FACEBOOK_APP_ID::\"},
        {\"name\": \"FACEBOOK_APP_SECRET\", \"valueFrom\": \"${SECRET_ARN}:FACEBOOK_APP_SECRET::\"},
        {\"name\": \"FACEBOOK_CALLBACK_URL\", \"valueFrom\": \"${SECRET_ARN}:FACEBOOK_CALLBACK_URL::\"}
      ],
      \"logConfiguration\": {
        \"logDriver\": \"awslogs\",
        \"options\": {
          \"awslogs-group\": \"/ecs/kingside-api\",
          \"awslogs-region\": \"${REGION}\",
          \"awslogs-stream-prefix\": \"ecs\"
        }
      }
    }]" --query 'taskDefinition.{Family:family,Revision:revision}' --output json

echo ""
echo "=== Task Definition registered ==="
echo "Family: kingside-api"
echo "CPU: 0.5 vCPU, Memory: 1GB"
echo "Image: ${ECR_URI}:latest"
echo "Secrets: from kingside/api (Secrets Manager)"
echo "Logs: /ecs/kingside-api (CloudWatch)"
