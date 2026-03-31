#!/bin/bash
# Setup ALB + Target Group for Kingside API (WebSocket support)
# Usage: bash infra/aws/setup-alb.sh

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"

echo "=== Setting up ALB ==="

VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" --query 'Vpcs[0].VpcId' --output text)
PUBLIC_SUBNET_A=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" --query 'Subnets[0].SubnetId' --output text)
PUBLIC_SUBNET_B=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.2.0/24" --query 'Subnets[0].SubnetId' --output text)
ALB_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-alb-sg" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId' --output text)

# 1. ALB (idempotent)
ALB_ARN=$(aws elbv2 describe-load-balancers --names kingside-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || echo "")
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
    ALB_ARN=$(aws elbv2 create-load-balancer --name kingside-alb --type application --scheme internet-facing \
        --subnets "$PUBLIC_SUBNET_A" "$PUBLIC_SUBNET_B" --security-groups "$ALB_SG" \
        --query 'LoadBalancers[0].LoadBalancerArn' --output text)
    aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" \
        --attributes Key=idle_timeout.timeout_seconds,Value=3600 > /dev/null
    echo "  ALB created: $ALB_ARN"
else
    echo "  ALB exists: $ALB_ARN"
fi

# 2. Target Group (idempotent)
TG_ARN=$(aws elbv2 describe-target-groups --names kingside-api-tg --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || echo "")
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
    TG_ARN=$(aws elbv2 create-target-group --name kingside-api-tg --protocol HTTP --port 3001 \
        --target-type ip --vpc-id "$VPC_ID" --health-check-path /api/health \
        --health-check-interval-seconds 30 --health-check-timeout-seconds 5 \
        --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
        --query 'TargetGroups[0].TargetGroupArn' --output text)
    aws elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" \
        --attributes Key=stickiness.enabled,Value=true Key=stickiness.type,Value=lb_cookie Key=stickiness.lb_cookie.duration_seconds,Value=86400 > /dev/null
    echo "  TG created: $TG_ARN"
else
    echo "  TG exists: $TG_ARN"
fi

ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)

echo ""
echo "=== ALB setup complete ==="
echo "ALB DNS: $ALB_DNS"
echo "Idle timeout: 3600s (WebSocket)"
echo "Stickiness: lb_cookie 86400s"
echo "Health check: /api/health"
echo ""
echo "NOTE: HTTPS listener requires ACM certificate."
echo "  aws acm request-certificate --domain-name chess-analyze.online --validation-method DNS"
