#!/bin/bash
# Setup ECR repository for Kingside API
# Usage: bash infra/aws/setup-ecr.sh

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
REPO_NAME="kingside-api"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}"

echo "=== Setting up ECR for ${REPO_NAME} ==="

# 1. Create repository (idempotent)
if aws ecr describe-repositories --repository-names "$REPO_NAME" &>/dev/null; then
    echo "[1/2] Repository exists: $ECR_URI"
else
    aws ecr create-repository \
        --repository-name "$REPO_NAME" \
        --image-scanning-configuration scanOnPush=true \
        --query 'repository.repositoryUri' --output text
    echo "[1/2] Created: $ECR_URI"
fi

# 2. Lifecycle policy — keep 10 latest images
echo "[2/2] Setting lifecycle policy (keep 10 images)..."
aws ecr put-lifecycle-policy --repository-name "$REPO_NAME" --lifecycle-policy-text '{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Keep last 10 images",
      "selection": {
        "tagStatus": "any",
        "countType": "imageCountMoreThan",
        "countNumber": 10
      },
      "action": {
        "type": "expire"
      }
    }
  ]
}' > /dev/null
echo "  Done."

echo ""
echo "=== ECR setup complete ==="
echo "URI: $ECR_URI"
echo ""
echo "To push:"
echo "  aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
echo "  docker build -t ${REPO_NAME}:latest -f apps/api/Dockerfile ."
echo "  docker tag ${REPO_NAME}:latest ${ECR_URI}:latest"
echo "  docker push ${ECR_URI}:latest"
