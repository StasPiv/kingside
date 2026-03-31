#!/bin/bash
# Setup ECS Cluster (Fargate) for Kingside
# Usage: bash infra/aws/setup-ecs-cluster.sh

set -euo pipefail

CLUSTER_NAME="kingside"

echo "=== Setting up ECS Cluster ==="

# Ensure ECS service-linked role exists
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com 2>/dev/null || true

# Create cluster (idempotent — returns existing if already created)
if aws ecs describe-clusters --clusters "$CLUSTER_NAME" --query 'clusters[?status==`ACTIVE`].clusterName' --output text 2>/dev/null | grep -q "$CLUSTER_NAME"; then
    echo "  Cluster exists: $CLUSTER_NAME"
else
    aws ecs create-cluster \
        --cluster-name "$CLUSTER_NAME" \
        --capacity-providers FARGATE \
        --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
        --settings name=containerInsights,value=enabled > /dev/null
    echo "  Created: $CLUSTER_NAME"
fi

ARN=$(aws ecs describe-clusters --clusters "$CLUSTER_NAME" --query 'clusters[0].clusterArn' --output text)

echo ""
echo "=== ECS Cluster ready ==="
echo "Name: $CLUSTER_NAME"
echo "ARN: $ARN"
echo "Provider: FARGATE"
echo "Container Insights: enabled"
