#!/bin/bash
# Setup ECS Service + Auto-scaling for Kingside API
# Usage: bash infra/aws/setup-ecs-service.sh
#
# Prerequisites: ECS Cluster, Task Definition, ALB + Target Group

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
CLUSTER="kingside"
SERVICE="kingside-api"
TASK_FAMILY="kingside-api"

echo "=== Setting up ECS Service ==="

# Get resources
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" --query 'Vpcs[0].VpcId' --output text)
PUBLIC_SUBNET_A=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" --query 'Subnets[0].SubnetId' --output text)
PUBLIC_SUBNET_B=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.2.0/24" --query 'Subnets[0].SubnetId' --output text)
ECS_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)
TG_ARN=$(aws elbv2 describe-target-groups --names kingside-api-tg --query 'TargetGroups[0].TargetGroupArn' --output text)

# 1. Create service (idempotent)
echo "[1/3] ECS Service..."
if aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[?status==`ACTIVE`].serviceName' --output text 2>/dev/null | grep -q "$SERVICE"; then
    echo "  Exists. Updating..."
    aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
        --task-definition "$TASK_FAMILY" --desired-count 1 > /dev/null
else
    aws ecs create-service \
        --cluster "$CLUSTER" --service-name "$SERVICE" --task-definition "$TASK_FAMILY" \
        --desired-count 1 --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[$PUBLIC_SUBNET_A,$PUBLIC_SUBNET_B],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}" \
        --load-balancers "targetGroupArn=$TG_ARN,containerName=kingside-api,containerPort=3001" \
        --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200" \
        --health-check-grace-period-seconds 120 > /dev/null
    echo "  Created."
fi

# 2. Auto-scaling target
echo "[2/3] Auto-scaling target (min 1, max 4)..."
aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id "service/$CLUSTER/$SERVICE" \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity 1 --max-capacity 4 > /dev/null
echo "  Done."

# 3. CPU target tracking policy
echo "[3/3] CPU scaling policy (target 70%)..."
aws application-autoscaling put-scaling-policy \
    --service-namespace ecs \
    --resource-id "service/$CLUSTER/$SERVICE" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-name kingside-api-cpu-scaling \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration "{
      \"TargetValue\": 70.0,
      \"PredefinedMetricSpecification\": {\"PredefinedMetricType\": \"ECSServiceAverageCPUUtilization\"},
      \"ScaleOutCooldown\": 60,
      \"ScaleInCooldown\": 300
    }" > /dev/null
echo "  Done."

echo ""
echo "=== ECS Service ready ==="
echo "Cluster: $CLUSTER"
echo "Service: $SERVICE"
echo "Desired: 1, Min: 1, Max: 4"
echo "CPU scaling: target 70%"
echo "Deploy: rolling (minHealthy 100%, max 200%)"
