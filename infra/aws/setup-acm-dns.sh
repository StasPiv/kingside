#!/bin/bash
# Setup ACM certificates + DNS migration for chess-analyze.online
# Usage: bash infra/aws/setup-acm-dns.sh
#
# Creates:
#   - ACM cert in us-east-1 (for CloudFront)
#   - ACM cert in eu-central-1 (for ALB)
# Requires: DNS CNAME record for validation (shown in output)
#
# After validation:
#   - Attach cert to CloudFront distribution
#   - Create HTTPS listener on ALB
#   - Update DNS: chess-analyze.online CNAME → CloudFront domain

set -euo pipefail

DOMAIN="chess-analyze.online"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "=== Setting up ACM + DNS for $DOMAIN ==="

# 1. Request certs
echo "[1/5] Requesting ACM cert (us-east-1, CloudFront)..."
CF_CERT=$(aws --region us-east-1 acm list-certificates \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || echo "None")
if [ "$CF_CERT" = "None" ] || [ -z "$CF_CERT" ]; then
    CF_CERT=$(aws --region us-east-1 acm request-certificate \
        --domain-name "$DOMAIN" --subject-alternative-names "*.$DOMAIN" \
        --validation-method DNS --query 'CertificateArn' --output text)
    echo "  Created: $CF_CERT"
else
    echo "  Exists: $CF_CERT"
fi

echo "[2/5] Requesting ACM cert (eu-central-1, ALB)..."
ALB_CERT=$(aws --region eu-central-1 acm list-certificates \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text 2>/dev/null || echo "None")
if [ "$ALB_CERT" = "None" ] || [ -z "$ALB_CERT" ]; then
    ALB_CERT=$(aws --region eu-central-1 acm request-certificate \
        --domain-name "$DOMAIN" --subject-alternative-names "*.$DOMAIN" \
        --validation-method DNS --query 'CertificateArn' --output text)
    echo "  Created: $ALB_CERT"
else
    echo "  Exists: $ALB_CERT"
fi

# 3. Show validation record
echo ""
echo "[3/5] DNS validation record (add to your DNS):"
sleep 3
aws --region us-east-1 acm describe-certificate --certificate-arn "$CF_CERT" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.{Name:Name,Type:Type,Value:Value}' --output table

# 4. Check status
echo ""
echo "[4/5] Certificate status:"
CF_STATUS=$(aws --region us-east-1 acm describe-certificate --certificate-arn "$CF_CERT" --query 'Certificate.Status' --output text)
ALB_STATUS=$(aws --region eu-central-1 acm describe-certificate --certificate-arn "$ALB_CERT" --query 'Certificate.Status' --output text)
echo "  CloudFront cert: $CF_STATUS"
echo "  ALB cert: $ALB_STATUS"

if [ "$CF_STATUS" != "ISSUED" ]; then
    echo ""
    echo "⏳ Certificates pending validation. Add the DNS record above and re-run."
    echo "   Validation typically takes 5-30 minutes after adding the CNAME."
    exit 0
fi

# 5. Attach to CloudFront and ALB (only if ISSUED)
echo "[5/5] Attaching certificates..."

# CloudFront — update with custom domain + cert
CF_DIST="E1ECCUC177NSGI"
echo "  TODO: Update CloudFront $CF_DIST with cert $CF_CERT and alias $DOMAIN"
echo "  TODO: Create ALB HTTPS:443 listener with cert $ALB_CERT"
echo "  TODO: Update DNS: $DOMAIN CNAME → CloudFront domain"

echo ""
echo "=== ACM setup complete ==="
echo "CloudFront cert: $CF_CERT ($CF_STATUS)"
echo "ALB cert: $ALB_CERT ($ALB_STATUS)"
