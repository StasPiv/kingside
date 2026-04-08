#!/bin/bash
# Setup ECS task definitions for worker services (broadcast-worker, matchmaker)
# Workers: 0.25 vCPU, 512MB RAM, singleton (desiredCount=1, no auto-scaling)
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID="342946498289"
ECR_BASE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
EXECUTION_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/ecsTaskExecutionRole"
TASK_ROLE="arn:aws:iam::${ACCOUNT_ID}:role/kingside-ecs-task-role"
CLUSTER="kingside"

# Get VPC/subnet/SG (same as API)
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" --query 'Subnets[0].SubnetId' --output text)
SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)

# Load .env for secrets
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [ -f "$REPO_DIR/.env" ]; then
    set -a; source "$REPO_DIR/.env"; set +a
fi

setup_worker() {
    local WORKER_NAME="$1"
    local ECR_URI="${ECR_BASE}/kingside-${WORKER_NAME}"
    local LOG_GROUP="/ecs/kingside-${WORKER_NAME}"

    echo "=== Setting up ${WORKER_NAME} ==="

    # Create ECR repo
    aws ecr describe-repositories --repository-names "kingside-${WORKER_NAME}" 2>/dev/null || \
        aws ecr create-repository --repository-name "kingside-${WORKER_NAME}" --image-scanning-configuration scanOnPush=false

    # Create log group
    aws logs create-log-group --log-group-name "$LOG_GROUP" 2>/dev/null || true

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
                    {\"name\": \"NODE_ENV\", \"value\": \"production\"},
                    {\"name\": \"DATABASE_URL\", \"value\": \"${DATABASE_URL}\"},
                    {\"name\": \"REDIS_URL\", \"value\": \"${REDIS_URL}\"}
                ],
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
    if aws ecs describe-services --cluster "$CLUSTER" --services "kingside-${WORKER_NAME}" --query 'services[?status==`ACTIVE`].serviceName' --output text | grep -q "kingside-${WORKER_NAME}"; then
        echo "  Service already exists, updating..."
        aws ecs update-service --cluster "$CLUSTER" --service "kingside-${WORKER_NAME}" \
            --force-new-deployment --query 'service.deployments[0].status' --output text
    else
        echo "  Creating service..."
        aws ecs create-service \
            --cluster "$CLUSTER" \
            --service-name "kingside-${WORKER_NAME}" \
            --task-definition "kingside-${WORKER_NAME}" \
            --desired-count 1 \
            --launch-type FARGATE \
            --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
            --deployment-configuration "minimumHealthyPercent=0,maximumPercent=100" \
            --query 'service.serviceName' --output text
    fi

    echo "  Service kingside-${WORKER_NAME} ready."
    echo ""
}

setup_worker "broadcast-worker"
setup_worker "matchmaker"

echo "=== All workers configured ==="
