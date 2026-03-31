#!/bin/bash
# Setup S3 bucket for Kingside frontend + deploy script
# Usage: bash infra/aws/setup-s3-frontend.sh [--deploy-only]

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="kingside-frontend-${ACCOUNT_ID}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_ONLY="${1:-}"

if [ "$DEPLOY_ONLY" != "--deploy-only" ]; then
    echo "=== Setting up S3 bucket for frontend ==="

    # 1. Create bucket (idempotent)
    if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
        echo "  Bucket exists: $BUCKET"
    else
        aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
            --create-bucket-configuration LocationConstraint="$REGION" > /dev/null
        echo "  Created: $BUCKET"
    fi

    # 2. Block public access (CloudFront OAI will serve content)
    aws s3api put-public-access-block --bucket "$BUCKET" \
        --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
    echo "  Public access blocked"

    # 3. Enable versioning
    aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
    echo "  Versioning enabled"
fi

# 4. Build and deploy
echo "=== Deploying frontend ==="
VITE_API_URL="${VITE_API_URL:-https://chess-analyze.online}" npm run build --prefix "$REPO_DIR" --workspace=apps/web 2>&1 | tail -5
aws s3 sync "$REPO_DIR/apps/web/dist/" "s3://${BUCKET}/" --delete 2>&1 | grep -c upload || true
echo "  Synced to s3://$BUCKET/"

echo ""
echo "=== S3 frontend ready ==="
echo "Bucket: $BUCKET"
echo "Region: $REGION"
echo "Note: Serve via CloudFront (not directly from S3)"
