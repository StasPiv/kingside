#!/bin/bash
# Setup ECS task definitions for worker services (broadcast-worker, matchmaker)
# Workers: 0.25 vCPU, 512MB RAM, singleton (desiredCount=1, no auto-scaling)
# Run once to create ECR repos, log groups, task defs, and ECS services.
# After that, deploy-aws.sh handles updates.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
ECR_BASE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
EXECUTION_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole"
TASK_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskRole"
SECRET_ARN="arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:kingside/api-nfkTKX"
CLUSTER="kingside"

# Get networking from existing API service
SUBNETS=$(aws ecs describe-services --cluster "$CLUSTER" --services kingside-api \
    --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')
SG=$(aws ecs describe-services --cluster "$CLUSTER" --services kingside-api \
    --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups[0]' --output text)

setup_worker() {
    local WORKER_NAME="$1"
    local EXTRA_SECRETS="${2:-}"
    local ECR_URI="${ECR_BASE}/kingside-${WORKER_NAME}"
    local LOG_GROUP="/ecs/kingside-${WORKER_NAME}"

    echo "=== Setting up ${WORKER_NAME} ==="

    # Create ECR repo
    aws ecr describe-repositories --repository-names "kingside-${WORKER_NAME}" 2>/dev/null || \
        aws ecr create-repository --repository-name "kingside-${WORKER_NAME}" --image-scanning-configuration scanOnPush=false
    echo "  ECR repo ready."

    # Create log group
    aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true
    echo "  Log group ready."

    # Build secrets JSON
    local SECRETS="[
        {\"name\": \"DATABASE_URL\", \"valueFrom\": \"${SECRET_ARN}:DATABASE_URL::\"},
        {\"name\": \"REDIS_URL\", \"valueFrom\": \"${SECRET_ARN}:REDIS_URL::\"},
        {\"name\": \"REDIS_HOST\", \"valueFrom\": \"${SECRET_ARN}:REDIS_HOST::\"},
        {\"name\": \"REDIS_PORT\", \"valueFrom\": \"${SECRET_ARN}:REDIS_PORT::\"}${EXTRA_SECRETS}
    ]"

    # Register task definition
    aws ecs register-task-definition \
        --family "kingside-${WORKER_NAME}" \
        --requires-compatibilities FARGATE \
        --network-mode awsvpc \
        --cpu "256" \
        --memory "512" \
        --execution-role-arn "$EXECUTION_ROLE" \
        --task-role-arn "$TASK_ROLE" \
        --container-definitions "[
            {
                \"name\": \"kingside-${WORKER_NAME}\",
                \"image\": \"${ECR_URI}:latest\",
                \"essential\": true,
                \"environment\": [
                    {\"name\": \"NODE_ENV\", \"value\": \"production\"}
                ],
                \"secrets\": ${SECRETS},
                \"logConfiguration\": {
                    \"logDriver\": \"awslogs\",
                    \"options\": {
                        \"awslogs-group\": \"${LOG_GROUP}\",
                        \"awslogs-region\": \"${REGION}\",
                        \"awslogs-stream-prefix\": \"ecs\"
                    }
                }
            }
        ]" \
        --query 'taskDefinition.taskDefinitionArn' --output text
    echo "  Task definition registered."

    # Create ECS service (singleton, no auto-scaling)
    if aws ecs describe-services --cluster "$CLUSTER" --services "kingside-${WORKER_NAME}" \
        --query 'services[?status==`ACTIVE`].serviceName' --output text | grep -q "kingside-${WORKER_NAME}"; then
        echo "  Service already exists, updating..."
        aws ecs update-service --cluster "$CLUSTER" --service "kingside-${WORKER_NAME}" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
    else
        echo "  Creating service..."
        aws ecs create-service \
            --cluster "$CLUSTER" \
            --service-name "kingside-${WORKER_NAME}" \
            --task-definition "kingside-${WORKER_NAME}" \
            --desired-count 0 \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
            --deployment-configuration "minimumHealthyPercent=0,maximumPercent=100" \
            --query 'service.serviceName' --output text
    fi

    echo "  Service kingside-${WORKER_NAME} ready."
    echo ""
}

# broadcast-worker needs LICHESS_BROADCAST_IDS
BROADCAST_EXTRA=",{\"name\": \"LICHESS_BROADCAST_IDS\", \"valueFrom\": \"${SECRET_ARN}:LICHESS_BROADCAST_IDS::\"}"
setup_worker "broadcast-worker" "$BROADCAST_EXTRA"

# matchmaker needs only base secrets
setup_worker "matchmaker"

echo "=== All workers configured ==="
