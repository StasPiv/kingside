#!/bin/bash
# Setup ElastiCache Redis 7 for Kingside
# Usage: bash infra/aws/setup-elasticache.sh

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
CLUSTER_ID="kingside-redis"

echo "=== Setting up ElastiCache Redis 7 ==="

VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" \
    --query 'Vpcs[0].VpcId' --output text)
PRIVATE_SUBNET_A=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.10.0/24" \
    --query 'Subnets[0].SubnetId' --output text)
PRIVATE_SUBNET_B=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.11.0/24" \
    --query 'Subnets[0].SubnetId' --output text)
REDIS_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-redis-sg" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text)

# 1. Subnet group (idempotent)
echo "[1/2] Cache subnet group..."
if aws elasticache describe-cache-subnet-groups --cache-subnet-group-name kingside-redis-subnet &>/dev/null; then
    echo "  Exists."
else
    aws elasticache create-cache-subnet-group \
        --cache-subnet-group-name kingside-redis-subnet \
        --cache-subnet-group-description "Kingside private subnets for Redis" \
        --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" > /dev/null
    echo "  Created."
fi

# 2. Redis cluster (idempotent)
echo "[2/2] Redis cluster..."
if aws elasticache describe-cache-clusters --cache-cluster-id "$CLUSTER_ID" &>/dev/null; then
    echo "  Exists."
else
    aws elasticache create-cache-cluster \
        --cache-cluster-id "$CLUSTER_ID" \
        --engine redis \
        --engine-version "7.1" \
        --cache-node-type cache.t3.micro \
        --num-cache-nodes 1 \
        --cache-subnet-group-name kingside-redis-subnet \
        --security-group-ids "$REDIS_SG" > /dev/null
    echo "  Creating (3-5 min)..."
    aws elasticache wait cache-cluster-available --cache-cluster-id "$CLUSTER_ID"
    echo "  Ready."
fi

ENDPOINT=$(aws elasticache describe-cache-clusters --cache-cluster-id "$CLUSTER_ID" --show-cache-node-info \
    --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' --output text)

echo ""
echo "=== ElastiCache setup complete ==="
echo "Endpoint: ${ENDPOINT}:6379"
echo "REDIS_URL=redis://${ENDPOINT}:6379"
