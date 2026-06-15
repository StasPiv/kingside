#!/usr/bin/env bash
# Создание S3-бакета kingside-prerender-store.
# ADR-128 §7.3, KS-4191.
#
# Правила:
#   - Регион: eu-central-1 (там же, где SPA-бакет и API).
#   - Versioning: enabled.
#   - Lifecycle: текущая версия — без TTL; старые версии удаляются через 30 дней.
#   - Public access: блокируется полностью; чтение только через CloudFront OAC.
#   - Encryption: SSE-S3 (AES256).
#
# Идемпотентно.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
BUCKET="kingside-prerender-store"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

echo "[s3] Region=$REGION Bucket=$BUCKET"

# --- Create bucket ---
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    echo "[s3] Bucket already exists"
else
    echo "[s3] Creating bucket"
    aws s3api create-bucket \
        --bucket "$BUCKET" \
        --region "$REGION" \
        --create-bucket-configuration "LocationConstraint=$REGION"
fi

# --- Block public access ---
echo "[s3] Block public access"
aws s3api put-public-access-block \
    --bucket "$BUCKET" \
    --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# --- Versioning ---
echo "[s3] Enable versioning"
aws s3api put-bucket-versioning \
    --bucket "$BUCKET" \
    --versioning-configuration "Status=Enabled"

# --- Encryption (SSE-S3) ---
echo "[s3] Enable SSE-S3 encryption"
aws s3api put-bucket-encryption \
    --bucket "$BUCKET" \
    --server-side-encryption-configuration '{
        "Rules": [
            {
                "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"},
                "BucketKeyEnabled": true
            }
        ]
    }'

# --- Lifecycle: noncurrent versions through 30 days ---
echo "[s3] Apply lifecycle (noncurrent versions expire after 30 days)"
TMP_LC="$(mktemp)"
cat > "$TMP_LC" <<'EOF'
{
  "Rules": [
    {
      "ID": "expire-noncurrent-versions-30d",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
    }
  ]
}
EOF
aws s3api put-bucket-lifecycle-configuration \
    --bucket "$BUCKET" \
    --lifecycle-configuration "file://$TMP_LC"
rm -f "$TMP_LC"

# --- Tags ---
aws s3api put-bucket-tagging \
    --bucket "$BUCKET" \
    --tagging 'TagSet=[
        {Key=Project,Value=Kingside},
        {Key=Component,Value=prerender},
        {Key=ManagedBy,Value=devops-script}
    ]'

echo
echo "[s3] Done. Bucket: s3://$BUCKET"
