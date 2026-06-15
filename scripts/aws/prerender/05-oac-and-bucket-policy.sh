#!/usr/bin/env bash
# Origin Access Control для CloudFront → S3 kingside-prerender-store + bucket policy.
# ADR-128 §7.3, KS-4191.
#
# OAC — современный способ дать CloudFront читать из приватного S3 (вместо OAI).
# Bucket policy грантит cloudfront.amazonaws.com доступ только при SourceArn = наш distribution.
#
# В bucket policy НЕ включаем s3:ListBucket для OAC-принципала. Это намеренно:
# при отсутствии объекта S3 возвращает 403 (а не 404), что позволяет CloudFront
# CustomErrorResponse(403→/index.html,200) сработать только на этот случай,
# не затрагивая 404 от ALB API.
#
# Идемпотентно.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="kingside-prerender-store"
DIST_ID="${DIST_ID:-E1ECCUC177NSGI}"

OAC_NAME="kingside-prerender-store-oac"

echo "[oac] Distribution=$DIST_ID Bucket=$BUCKET"

# --- OAC ---
OAC_ID="$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" \
    --output text 2>/dev/null || true)"

if [[ -z "$OAC_ID" || "$OAC_ID" == "None" ]]; then
    echo "[oac] Creating OAC $OAC_NAME"
    OAC_ID="$(aws cloudfront create-origin-access-control \
        --origin-access-control-config "Name=$OAC_NAME,Description=OAC for prerender store,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
        --query "OriginAccessControl.Id" --output text)"
    echo "[oac] Created OAC $OAC_ID"
else
    echo "[oac] OAC $OAC_NAME exists: $OAC_ID"
fi

# --- Bucket policy ---
DIST_ARN="arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}"
BUCKET_ARN="arn:aws:s3:::${BUCKET}"

# Worker role также пишет в бакет — добавим ему доступ через ту же политику.
WORKER_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/kingside-prerender-worker-role"

POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowCloudFrontReadViaOAC",
            "Effect": "Allow",
            "Principal": {"Service": "cloudfront.amazonaws.com"},
            "Action": "s3:GetObject",
            "Resource": "${BUCKET_ARN}/*",
            "Condition": {
                "StringEquals": {"AWS:SourceArn": "${DIST_ARN}"}
            }
        }
    ]
}
EOF
)

echo "[oac] Applying bucket policy"
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$POLICY"

echo
echo "[oac] Done."
echo "  OAC_ID=$OAC_ID"
echo "  DIST_ARN=$DIST_ARN"
echo
echo "  Use OAC_ID=$OAC_ID in 06-distribution-wire-up.sh"
