#!/bin/bash
# Setup RDS PostgreSQL 16 for Kingside
# Usage: bash infra/aws/setup-rds.sh
#
# Requires: VPC with private subnets and rds-sg (from setup-vpc.sh)

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
DB_IDENTIFIER="kingside-db"
DB_NAME="kingside"
DB_USER="kingside"

echo "=== Setting up RDS PostgreSQL 16 ==="

# Get VPC resources
VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" \
    --query 'Vpcs[0].VpcId' --output text)
PRIVATE_SUBNET_A=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.10.0/24" \
    --query 'Subnets[0].SubnetId' --output text)
PRIVATE_SUBNET_B=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.11.0/24" \
    --query 'Subnets[0].SubnetId' --output text)
RDS_SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=kingside-rds-sg" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text)

echo "  VPC: $VPC_ID"
echo "  Subnets: $PRIVATE_SUBNET_A, $PRIVATE_SUBNET_B"
echo "  SG: $RDS_SG"

# 1. DB subnet group (idempotent)
echo "[1/2] DB subnet group..."
if aws rds describe-db-subnet-groups --db-subnet-group-name kingside-db-subnet &>/dev/null; then
    echo "  Exists."
else
    aws rds create-db-subnet-group \
        --db-subnet-group-name kingside-db-subnet \
        --db-subnet-group-description "Kingside private subnets for RDS" \
        --subnet-ids "$PRIVATE_SUBNET_A" "$PRIVATE_SUBNET_B" > /dev/null
    echo "  Created."
fi

# 2. RDS instance (idempotent)
echo "[2/2] RDS instance..."
if aws rds describe-db-instances --db-instance-identifier "$DB_IDENTIFIER" &>/dev/null; then
    echo "  Exists."
    ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DB_IDENTIFIER" \
        --query 'DBInstances[0].Endpoint.Address' --output text)
else
    RDS_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)
    echo "  Password: $RDS_PASSWORD (SAVE THIS — shown only once)"

    aws rds create-db-instance \
        --db-instance-identifier "$DB_IDENTIFIER" \
        --db-instance-class db.t3.micro \
        --engine postgres \
        --engine-version "16" \
        --master-username "$DB_USER" \
        --master-user-password "$RDS_PASSWORD" \
        --allocated-storage 20 \
        --storage-type gp3 \
        --no-multi-az \
        --db-subnet-group-name kingside-db-subnet \
        --vpc-security-group-ids "$RDS_SG" \
        --db-name "$DB_NAME" \
        --backup-retention-period 7 \
        --no-publicly-accessible \
        --storage-encrypted > /dev/null

    echo "  Creating (5-10 min)..."
    aws rds wait db-instance-available --db-instance-identifier "$DB_IDENTIFIER"
    ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DB_IDENTIFIER" \
        --query 'DBInstances[0].Endpoint.Address' --output text)
    echo "  Ready."
fi

echo ""
echo "=== RDS setup complete ==="
echo "Endpoint: $ENDPOINT"
echo "Port: 5432"
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo "DATABASE_URL=postgresql://${DB_USER}:<password>@${ENDPOINT}:5432/${DB_NAME}"
