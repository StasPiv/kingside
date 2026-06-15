#!/usr/bin/env bash
# Создание/публикация CloudFront Function kingside-prerender-route-rewrite.
# ADR-128 §7.3.4, KS-4191.
#
# Идемпотентно: create → update + publish. Источник: cloudfront-prerender-route-rewrite.js.

set -euo pipefail

FN_NAME="kingside-prerender-route-rewrite"
SRC="$(dirname "$0")/cloudfront-prerender-route-rewrite.js"
# AWS CLI shorthand `key=value,key=value` рассыпается на запятую — поэтому в Comment запятых нет.
COMMENT="Prerender route rewrite (ADR-128 7.3.4 KS-4191)"
RUNTIME="cloudfront-js-2.0"

if [[ ! -f "$SRC" ]]; then
    echo "[cf-fn] Source not found: $SRC" >&2
    exit 1
fi

# Существует ли функция?
ETAG="$(aws cloudfront describe-function --name "$FN_NAME" --query "ETag" --output text 2>/dev/null || true)"

if [[ -z "$ETAG" || "$ETAG" == "None" ]]; then
    echo "[cf-fn] Creating $FN_NAME"
    aws cloudfront create-function \
        --name "$FN_NAME" \
        --function-config "Comment=$COMMENT,Runtime=$RUNTIME" \
        --function-code "fileb://$SRC" >/dev/null
    ETAG="$(aws cloudfront describe-function --name "$FN_NAME" --query "ETag" --output text)"
    echo "[cf-fn] Created. ETag=$ETAG"
else
    echo "[cf-fn] Updating $FN_NAME (current ETag=$ETAG)"
    ETAG="$(aws cloudfront update-function \
        --name "$FN_NAME" \
        --function-config "Comment=$COMMENT,Runtime=$RUNTIME" \
        --function-code "fileb://$SRC" \
        --if-match "$ETAG" \
        --query "ETag" --output text)"
    echo "[cf-fn] Updated. New ETag=$ETAG"
fi

echo "[cf-fn] Publishing to LIVE"
aws cloudfront publish-function --name "$FN_NAME" --if-match "$ETAG" >/dev/null
echo "[cf-fn] Published."

aws cloudfront describe-function \
    --name "$FN_NAME" \
    --stage LIVE \
    --query "FunctionSummary.{Name:Name, Stage:FunctionMetadata.Stage, Status:Status, ARN:FunctionMetadata.FunctionARN}" \
    --output table
