#!/bin/bash
# Setup IAM roles and policies for Kingside ECS deployment
# Run this with AWS root/admin credentials (NOT kingside-ci)
#
# Usage: AWS_PROFILE=admin bash infra/aws/setup-iam.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=== Setting up IAM for Kingside (Account: $ACCOUNT_ID) ==="

# 1. Create ecsTaskExecutionRole
echo "[1/4] Creating ecsTaskExecutionRole..."
if aws iam get-role --role-name ecsTaskExecutionRole &>/dev/null; then
    echo "  Already exists, skipping."
else
    aws iam create-role \
        --role-name ecsTaskExecutionRole \
        --assume-role-policy-document "file://$SCRIPT_DIR/ecs-task-execution-role-trust.json"
    echo "  Created."
fi

# Attach AWS managed policy for ECS task execution
aws iam attach-role-policy \
    --role-name ecsTaskExecutionRole \
    --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
echo "  AmazonECSTaskExecutionRolePolicy attached."

# 2. Create ecsTaskRole
echo "[2/4] Creating ecsTaskRole..."
if aws iam get-role --role-name ecsTaskRole &>/dev/null; then
    echo "  Already exists, skipping."
else
    aws iam create-role \
        --role-name ecsTaskRole \
        --assume-role-policy-document "file://$SCRIPT_DIR/ecs-task-role-trust.json"
    echo "  Created."
fi

# Attach custom policy for task permissions (S3, CloudWatch)
echo "[3/4] Attaching ecsTaskRole policy..."
TASK_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/kingside-ecs-task-policy"
if aws iam get-policy --policy-arn "$TASK_POLICY_ARN" &>/dev/null; then
    # Update existing policy (create new version)
    aws iam create-policy-version \
        --policy-arn "$TASK_POLICY_ARN" \
        --policy-document "file://$SCRIPT_DIR/ecs-task-role-policy.json" \
        --set-as-default
    echo "  Policy updated."
else
    aws iam create-policy \
        --policy-name kingside-ecs-task-policy \
        --policy-document "file://$SCRIPT_DIR/ecs-task-role-policy.json"
    echo "  Policy created."
fi
aws iam attach-role-policy \
    --role-name ecsTaskRole \
    --policy-arn "$TASK_POLICY_ARN"
echo "  Policy attached to ecsTaskRole."

# 4. Attach CI/CD policy to kingside-ci user
echo "[4/4] Attaching CI/CD policy to kingside-ci..."
CI_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/kingside-ci-policy"
if aws iam get-policy --policy-arn "$CI_POLICY_ARN" &>/dev/null; then
    aws iam create-policy-version \
        --policy-arn "$CI_POLICY_ARN" \
        --policy-document "file://$SCRIPT_DIR/kingside-ci-policy.json" \
        --set-as-default
    echo "  Policy updated."
else
    aws iam create-policy \
        --policy-name kingside-ci-policy \
        --policy-document "file://$SCRIPT_DIR/kingside-ci-policy.json"
    echo "  Policy created."
fi
aws iam attach-user-policy \
    --user-name kingside-ci \
    --policy-arn "$CI_POLICY_ARN"
echo "  Policy attached to kingside-ci."

echo ""
echo "=== IAM setup complete ==="
echo "Roles:"
echo "  - ecsTaskExecutionRole (ECS pulls images, writes logs)"
echo "  - ecsTaskRole (app access to S3, CloudWatch)"
echo "User policies:"
echo "  - kingside-ci: ECR, ECS, S3, PassRole, CloudWatch"
