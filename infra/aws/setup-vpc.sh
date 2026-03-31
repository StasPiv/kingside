#!/bin/bash
# Setup VPC, subnets, IGW, NAT, security groups for Kingside ECS deployment
# Usage: bash infra/aws/setup-vpc.sh
#
# Idempotent: checks for existing resources by Name tag before creating.
# Saves resource IDs to infra/aws/vpc-outputs.env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
PROJECT="kingside"
OUTPUT_FILE="$SCRIPT_DIR/vpc-outputs.env"

# Helper: find resource by Name tag, fallback to other filters
find_resource() {
    local resource_type="$1" name="$2" extra="${3:-}"
    local result=""
    # Try by Name tag first
    case "$resource_type" in
        vpc)
            result=$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=$name" \
                --query 'Vpcs[0].VpcId' --output text 2>/dev/null | grep -v None || true) ;;
        subnet)
            result=$(aws ec2 describe-subnets --filters "Name=tag:Name,Values=$name" \
                --query 'Subnets[0].SubnetId' --output text 2>/dev/null | grep -v None || true) ;;
        igw)
            result=$(aws ec2 describe-internet-gateways --filters "Name=tag:Name,Values=$name" \
                --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null | grep -v None || true) ;;
        nat)
            result=$(aws ec2 describe-nat-gateways --filter "Name=tag:Name,Values=$name" "Name=state,Values=available,pending" \
                --query 'NatGateways[0].NatGatewayId' --output text 2>/dev/null | grep -v None || true) ;;
        rtb)
            result=$(aws ec2 describe-route-tables --filters "Name=tag:Name,Values=$name" \
                --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null | grep -v None || true) ;;
        sg)
            result=$(aws ec2 describe-security-groups --filters "Name=tag:Name,Values=$name" \
                --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v None || true)
            # Fallback: search by group-name
            if [ -z "$result" ] && [ -n "$extra" ]; then
                result=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$extra" "Name=vpc-id,Values=$VPC_ID" \
                    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v None || true)
            fi ;;
    esac
    echo "$result"
}

# Find subnet by CIDR in VPC
find_subnet_by_cidr() {
    local cidr="$1"
    aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=$cidr" \
        --query 'Subnets[0].SubnetId' --output text 2>/dev/null | grep -v None || true
}

# Helper: tag resource (non-fatal if CreateTags denied)
tag() {
    aws ec2 create-tags --resources "$1" --tags Key=Name,Value="$2" 2>/dev/null || \
        echo "  WARN: could not tag $1 as $2 (CreateTags denied)"
}

echo "=== Setting up VPC for $PROJECT (Region: $REGION) ==="

# --- 1. VPC ---
echo "[1/9] VPC..."
VPC_ID=$(find_resource vpc "${PROJECT}-vpc")
if [ -z "$VPC_ID" ]; then
    # Check for untagged VPC with our CIDR
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=cidr-block,Values=10.0.0.0/16" \
        --query 'Vpcs[?Tags==null || length(Tags[?Key==`Name`])==`0`].VpcId | [0]' --output text 2>/dev/null | grep -v None || true)
    if [ -z "$VPC_ID" ]; then
        VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 \
            --query 'Vpc.VpcId' --output text)
        echo "  Created: $VPC_ID"
    else
        echo "  Found untagged: $VPC_ID"
    fi
    tag "$VPC_ID" "${PROJECT}-vpc"
    aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-support
    aws ec2 modify-vpc-attribute --vpc-id "$VPC_ID" --enable-dns-hostnames
else
    echo "  Exists: $VPC_ID"
fi

AZ_A="${REGION}a"
AZ_B="${REGION}b"

# --- 2. Public subnets ---
echo "[2/9] Public subnets..."
PUBLIC_SUBNET_A=$(find_resource subnet "${PROJECT}-public-a")
[ -z "$PUBLIC_SUBNET_A" ] && PUBLIC_SUBNET_A=$(find_subnet_by_cidr "10.0.1.0/24")
if [ -z "$PUBLIC_SUBNET_A" ]; then
    PUBLIC_SUBNET_A=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.0.1.0/24 \
        --availability-zone "$AZ_A" --query 'Subnet.SubnetId' --output text)
    tag "$PUBLIC_SUBNET_A" "${PROJECT}-public-a"
    echo "  Created A: $PUBLIC_SUBNET_A"
else
    echo "  Exists A: $PUBLIC_SUBNET_A"
fi

PUBLIC_SUBNET_B=$(find_resource subnet "${PROJECT}-public-b")
[ -z "$PUBLIC_SUBNET_B" ] && PUBLIC_SUBNET_B=$(find_subnet_by_cidr "10.0.2.0/24")
if [ -z "$PUBLIC_SUBNET_B" ]; then
    PUBLIC_SUBNET_B=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.0.2.0/24 \
        --availability-zone "$AZ_B" --query 'Subnet.SubnetId' --output text)
    tag "$PUBLIC_SUBNET_B" "${PROJECT}-public-b"
    echo "  Created B: $PUBLIC_SUBNET_B"
else
    echo "  Exists B: $PUBLIC_SUBNET_B"
fi

# --- 3. Private subnets ---
echo "[3/9] Private subnets..."
PRIVATE_SUBNET_A=$(find_resource subnet "${PROJECT}-private-a")
[ -z "$PRIVATE_SUBNET_A" ] && PRIVATE_SUBNET_A=$(find_subnet_by_cidr "10.0.10.0/24")
if [ -z "$PRIVATE_SUBNET_A" ]; then
    PRIVATE_SUBNET_A=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.0.10.0/24 \
        --availability-zone "$AZ_A" --query 'Subnet.SubnetId' --output text)
    tag "$PRIVATE_SUBNET_A" "${PROJECT}-private-a"
    echo "  Created A: $PRIVATE_SUBNET_A"
else
    echo "  Exists A: $PRIVATE_SUBNET_A"
fi

PRIVATE_SUBNET_B=$(find_resource subnet "${PROJECT}-private-b")
[ -z "$PRIVATE_SUBNET_B" ] && PRIVATE_SUBNET_B=$(find_subnet_by_cidr "10.0.11.0/24")
if [ -z "$PRIVATE_SUBNET_B" ]; then
    PRIVATE_SUBNET_B=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 10.0.11.0/24 \
        --availability-zone "$AZ_B" --query 'Subnet.SubnetId' --output text)
    tag "$PRIVATE_SUBNET_B" "${PROJECT}-private-b"
    echo "  Created B: $PRIVATE_SUBNET_B"
else
    echo "  Exists B: $PRIVATE_SUBNET_B"
fi

# --- 4. Internet Gateway ---
echo "[4/9] Internet Gateway..."
IGW_ID=$(find_resource igw "${PROJECT}-igw")
if [ -z "$IGW_ID" ]; then
    IGW_ID=$(aws ec2 create-internet-gateway --query 'InternetGateway.InternetGatewayId' --output text)
    tag "$IGW_ID" "${PROJECT}-igw"
    aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" 2>/dev/null || true
    echo "  Created: $IGW_ID"
else
    echo "  Exists: $IGW_ID"
fi

# --- 5. NAT Gateway ---
echo "[5/9] NAT Gateway (may take 1-2 min if creating)..."
NAT_GW_ID=$(find_resource nat "${PROJECT}-nat")
if [ -z "$NAT_GW_ID" ]; then
    EIP_ALLOC=$(aws ec2 allocate-address --domain vpc --query 'AllocationId' --output text)
    NAT_GW_ID=$(aws ec2 create-nat-gateway --subnet-id "$PUBLIC_SUBNET_A" \
        --allocation-id "$EIP_ALLOC" --query 'NatGateway.NatGatewayId' --output text)
    tag "$NAT_GW_ID" "${PROJECT}-nat"
    echo "  Created: $NAT_GW_ID (waiting...)"
    aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT_GW_ID"
    echo "  Ready."
else
    EIP_ALLOC=$(aws ec2 describe-nat-gateways --nat-gateway-ids "$NAT_GW_ID" \
        --query 'NatGateways[0].NatGatewayAddresses[0].AllocationId' --output text 2>/dev/null || echo "")
    echo "  Exists: $NAT_GW_ID"
fi

# --- 6. Route tables ---
echo "[6/9] Route tables..."

PUBLIC_RT=$(find_resource rtb "${PROJECT}-public-rt")
if [ -z "$PUBLIC_RT" ]; then
    PUBLIC_RT=$(aws ec2 create-route-table --vpc-id "$VPC_ID" --query 'RouteTable.RouteTableId' --output text)
    tag "$PUBLIC_RT" "${PROJECT}-public-rt"
    aws ec2 create-route --route-table-id "$PUBLIC_RT" --destination-cidr-block 0.0.0.0/0 --gateway-id "$IGW_ID" > /dev/null
    aws ec2 associate-route-table --route-table-id "$PUBLIC_RT" --subnet-id "$PUBLIC_SUBNET_A" > /dev/null
    aws ec2 associate-route-table --route-table-id "$PUBLIC_RT" --subnet-id "$PUBLIC_SUBNET_B" > /dev/null
    echo "  Created public RT: $PUBLIC_RT → IGW"
else
    echo "  Exists public RT: $PUBLIC_RT"
fi

PRIVATE_RT=$(find_resource rtb "${PROJECT}-private-rt")
if [ -z "$PRIVATE_RT" ]; then
    PRIVATE_RT=$(aws ec2 create-route-table --vpc-id "$VPC_ID" --query 'RouteTable.RouteTableId' --output text)
    tag "$PRIVATE_RT" "${PROJECT}-private-rt"
    aws ec2 create-route --route-table-id "$PRIVATE_RT" --destination-cidr-block 0.0.0.0/0 --nat-gateway-id "$NAT_GW_ID" > /dev/null
    aws ec2 associate-route-table --route-table-id "$PRIVATE_RT" --subnet-id "$PRIVATE_SUBNET_A" > /dev/null
    aws ec2 associate-route-table --route-table-id "$PRIVATE_RT" --subnet-id "$PRIVATE_SUBNET_B" > /dev/null
    echo "  Created private RT: $PRIVATE_RT → NAT"
else
    echo "  Exists private RT: $PRIVATE_RT"
fi

# --- 7. Security groups ---
echo "[7/9] Security groups..."

ALB_SG=$(find_resource sg "${PROJECT}-alb-sg" "${PROJECT}-alb-sg")
if [ -z "$ALB_SG" ]; then
    ALB_SG=$(aws ec2 create-security-group --group-name "${PROJECT}-alb-sg" \
        --description "ALB - HTTP/HTTPS" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
    tag "$ALB_SG" "${PROJECT}-alb-sg"
    aws ec2 authorize-security-group-ingress --group-id "$ALB_SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 > /dev/null
    aws ec2 authorize-security-group-ingress --group-id "$ALB_SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 > /dev/null
    echo "  Created ALB SG: $ALB_SG"
else
    echo "  Exists ALB SG: $ALB_SG"
fi

ECS_SG=$(find_resource sg "${PROJECT}-ecs-sg" "${PROJECT}-ecs-sg")
if [ -z "$ECS_SG" ]; then
    ECS_SG=$(aws ec2 create-security-group --group-name "${PROJECT}-ecs-sg" \
        --description "ECS tasks - API" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
    tag "$ECS_SG" "${PROJECT}-ecs-sg"
    aws ec2 authorize-security-group-ingress --group-id "$ECS_SG" --protocol tcp --port 3001 --source-group "$ALB_SG" > /dev/null
    echo "  Created ECS SG: $ECS_SG"
else
    echo "  Exists ECS SG: $ECS_SG"
fi

RDS_SG=$(find_resource sg "${PROJECT}-rds-sg" "${PROJECT}-rds-sg")
if [ -z "$RDS_SG" ]; then
    RDS_SG=$(aws ec2 create-security-group --group-name "${PROJECT}-rds-sg" \
        --description "RDS - PostgreSQL" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
    tag "$RDS_SG" "${PROJECT}-rds-sg"
    aws ec2 authorize-security-group-ingress --group-id "$RDS_SG" --protocol tcp --port 5432 --source-group "$ECS_SG" > /dev/null
    echo "  Created RDS SG: $RDS_SG"
else
    echo "  Exists RDS SG: $RDS_SG"
fi

REDIS_SG=$(find_resource sg "${PROJECT}-redis-sg" "${PROJECT}-redis-sg")
if [ -z "$REDIS_SG" ]; then
    REDIS_SG=$(aws ec2 create-security-group --group-name "${PROJECT}-redis-sg" \
        --description "ElastiCache - Redis" --vpc-id "$VPC_ID" --query 'GroupId' --output text)
    tag "$REDIS_SG" "${PROJECT}-redis-sg"
    aws ec2 authorize-security-group-ingress --group-id "$REDIS_SG" --protocol tcp --port 6379 --source-group "$ECS_SG" > /dev/null
    echo "  Created Redis SG: $REDIS_SG"
else
    echo "  Exists Redis SG: $REDIS_SG"
fi

# --- 8. Auto-assign public IP ---
echo "[8/9] Auto-assign public IP on public subnets..."
aws ec2 modify-subnet-attribute --subnet-id "$PUBLIC_SUBNET_A" --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id "$PUBLIC_SUBNET_B" --map-public-ip-on-launch
echo "  Done."

# --- 9. Save outputs ---
echo "[9/9] Saving outputs..."
cat > "$OUTPUT_FILE" <<EOF
# VPC outputs (generated by setup-vpc.sh)
# Region: $REGION
# Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)

VPC_ID=$VPC_ID
PUBLIC_SUBNET_A=$PUBLIC_SUBNET_A
PUBLIC_SUBNET_B=$PUBLIC_SUBNET_B
PRIVATE_SUBNET_A=$PRIVATE_SUBNET_A
PRIVATE_SUBNET_B=$PRIVATE_SUBNET_B
IGW_ID=$IGW_ID
NAT_GW_ID=$NAT_GW_ID
PUBLIC_RT=$PUBLIC_RT
PRIVATE_RT=$PRIVATE_RT
ALB_SG=$ALB_SG
ECS_SG=$ECS_SG
RDS_SG=$RDS_SG
REDIS_SG=$REDIS_SG
EIP_ALLOC=${EIP_ALLOC:-}
EOF
echo "  Saved to $OUTPUT_FILE"

echo ""
echo "=== VPC setup complete ==="
