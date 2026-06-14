#!/usr/bin/env bash
# Публикация CloudFront Function kingside-spa-rewrite.
# Источник: scripts/cloudfront-spa-rewrite.js
#
# Делает: update-function → publish-function (DEVELOPMENT → LIVE).
# Инвалидация кеша не нужна — функция viewer-request применяется до кеша.
#
# Использование:
#   bash scripts/cloudfront-deploy-spa-rewrite.sh

set -euo pipefail

FN_NAME="kingside-spa-rewrite"
SRC="$(dirname "$0")/cloudfront-spa-rewrite.js"

if [[ ! -f "$SRC" ]]; then
    echo "[cf-spa-rewrite] Source not found: $SRC" >&2
    exit 1
fi

echo "[cf-spa-rewrite] Fetching current ETag…"
ETAG="$(aws cloudfront describe-function --name "$FN_NAME" --query "ETag" --output text)"
echo "[cf-spa-rewrite] Current ETag: $ETAG"

echo "[cf-spa-rewrite] Updating function code…"
NEW_ETAG="$(aws cloudfront update-function \
    --name "$FN_NAME" \
    --function-config Comment="SPA rewrite + prerender routing",Runtime="cloudfront-js-2.0" \
    --function-code "fileb://$SRC" \
    --if-match "$ETAG" \
    --query "ETag" --output text)"
echo "[cf-spa-rewrite] New ETag: $NEW_ETAG"

echo "[cf-spa-rewrite] Publishing to LIVE…"
aws cloudfront publish-function --name "$FN_NAME" --if-match "$NEW_ETAG" >/dev/null
echo "[cf-spa-rewrite] Published."
