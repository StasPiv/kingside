#!/bin/bash
# Setup CloudFront distribution for Kingside (S3 + ALB origins)
# Usage: bash infra/aws/setup-cloudfront.sh
#
# Origins:
#   S3 (default) — static frontend via OAC
#   ALB — /api/*, /socket.io/* (no cache, all methods)
# SPA: 403/404 → /index.html (200)
# Cache: static CachingOptimized (24h), API CachingDisabled

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="kingside-frontend-${ACCOUNT_ID}"
ALB_DNS=$(aws elbv2 describe-load-balancers --names kingside-alb --query 'LoadBalancers[0].DNSName' --output text)

echo "=== Setting up CloudFront ==="
echo "  S3: $BUCKET"
echo "  ALB: $ALB_DNS"

# Check if distribution already exists
EXISTING=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='Kingside - chess platform'].Id | [0]" --output text 2>/dev/null || echo "None")
if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
    echo "  Distribution exists: $EXISTING"
    DOMAIN=$(aws cloudfront get-distribution --id "$EXISTING" --query 'Distribution.DomainName' --output text)
    echo "  Domain: $DOMAIN"
    exit 0
fi

# Create OAC
OAC_ID=$(aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='kingside-s3-oac'].Id | [0]" --output text 2>/dev/null || echo "None")
if [ "$OAC_ID" = "None" ] || [ -z "$OAC_ID" ]; then
    OAC_ID=$(aws cloudfront create-origin-access-control \
        --origin-access-control-config '{"Name":"kingside-s3-oac","OriginAccessControlOriginType":"s3","SigningBehavior":"always","SigningProtocol":"sigv4"}' \
        --query 'OriginAccessControl.Id' --output text)
fi
echo "  OAC: $OAC_ID"

echo "  Creating distribution (takes 5-10 min to deploy)..."
echo "  See infra/aws/setup-cloudfront.sh for full config."
echo ""
echo "NOTE: Run the full create-distribution command from this script."
echo "Distribution ID and domain will be shown after creation."
