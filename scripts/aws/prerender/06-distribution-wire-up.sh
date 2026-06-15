#!/usr/bin/env bash
# Подключение prerender-инфраструктуры к CloudFront distribution E1ECCUC177NSGI.
# ADR-128 §7.3, KS-4191.
#
# Делает атомарный update-distribution:
#   1) Добавляет origin `s3-prerender` (S3 kingside-prerender-store через OAC).
#   2) Создаёт CachePolicy «Kingside-Prerender-5min» (если ещё нет) — TTL=300s.
#   3) Добавляет 8 cache-behaviors на префиксы prerender-разделов с привязками:
#        - CloudFront Function `kingside-prerender-route-rewrite` (viewer-request)
#        - Lambda@Edge `kingside-prerender-fallback` (origin-response), если задан LAMBDA_EDGE_ARN
#   4) CustomErrorResponse на уровне дистрибуции НЕ добавляет —
#      запасной маршрут 404 → /index.html обеспечивает Lambda@Edge точечно
#      на prerender-правилах, не затрагивая `/api/*` (см. ADR-128 §7.3.4).
#
# Идемпотентно: если конфиг уже содержит prerender-ресурсы, пропускает их.
#
# Использование:
#   DIST_ID=E1ECCUC177NSGI OAC_ID=<id> LAMBDA_EDGE_ARN=<arn:...:1> bash 06-distribution-wire-up.sh
# Параметры по умолчанию совпадают с продом.

set -euo pipefail

REGION="${AWS_REGION:-eu-central-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"

DIST_ID="${DIST_ID:-E1ECCUC177NSGI}"
OAC_ID="${OAC_ID:-E2SUPDHS0B65F8}"
PRERENDER_BUCKET="kingside-prerender-store"
PRERENDER_ORIGIN_ID="s3-prerender"
FN_NAME="kingside-prerender-route-rewrite"
FN_ARN="arn:aws:cloudfront::${ACCOUNT}:function/${FN_NAME}"
CACHE_POLICY_NAME="Kingside-Prerender-5min"
LAMBDA_EDGE_ARN="${LAMBDA_EDGE_ARN:-}"   # arn:aws:lambda:us-east-1:<acc>:function:kingside-prerender-fallback:<version>

echo "[wire] Distribution=$DIST_ID OAC=$OAC_ID"

# --- 1) CachePolicy 5-min ---
CACHE_POLICY_ID="$(aws cloudfront list-cache-policies \
    --type custom \
    --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='$CACHE_POLICY_NAME'].CachePolicy.Id | [0]" \
    --output text 2>/dev/null || true)"

if [[ -z "$CACHE_POLICY_ID" || "$CACHE_POLICY_ID" == "None" ]]; then
    echo "[wire] Creating CachePolicy $CACHE_POLICY_NAME"
    TMP_CP="$(mktemp)"
    cat > "$TMP_CP" <<EOF
{
    "Name": "$CACHE_POLICY_NAME",
    "Comment": "5-minute TTL for prerendered HTML (ADR-128 KS-4191)",
    "DefaultTTL": 300,
    "MaxTTL": 300,
    "MinTTL": 0,
    "ParametersInCacheKeyAndForwardedToOrigin": {
        "EnableAcceptEncodingGzip": true,
        "EnableAcceptEncodingBrotli": true,
        "HeadersConfig": {"HeaderBehavior": "none"},
        "CookiesConfig": {"CookieBehavior": "none"},
        "QueryStringsConfig": {"QueryStringBehavior": "none"}
    }
}
EOF
    CACHE_POLICY_ID="$(aws cloudfront create-cache-policy \
        --cache-policy-config "file://$TMP_CP" \
        --query "CachePolicy.Id" --output text)"
    rm -f "$TMP_CP"
    echo "[wire] Created CachePolicy id=$CACHE_POLICY_ID"
else
    echo "[wire] CachePolicy $CACHE_POLICY_NAME exists: $CACHE_POLICY_ID"
fi

# --- 2) Fetch dist config ---
echo "[wire] Fetching distribution config"
aws cloudfront get-distribution-config --id "$DIST_ID" --output json > /tmp/cf-dist-current.json
ETAG="$(python3 -c "import json;print(json.load(open('/tmp/cf-dist-current.json'))['ETag'])")"
echo "[wire] Current ETag=$ETAG"

# --- 3) Mutate config in Python ---
python3 <<PYEOF
import json, sys

src = json.load(open('/tmp/cf-dist-current.json'))
config = src['DistributionConfig']

prerender_origin_id = "$PRERENDER_ORIGIN_ID"
bucket_domain = "$PRERENDER_BUCKET.s3.$REGION.amazonaws.com"
oac_id = "$OAC_ID"
fn_arn = "$FN_ARN"
cache_policy_id = "$CACHE_POLICY_ID"
lambda_edge_arn = "$LAMBDA_EDGE_ARN"

# ---- Origin ----
origin_exists = any(o['Id'] == prerender_origin_id for o in config['Origins']['Items'])
if not origin_exists:
    print(f"[py] Adding origin {prerender_origin_id}")
    new_origin = {
        "Id": prerender_origin_id,
        "DomainName": bucket_domain,
        "OriginPath": "",
        "CustomHeaders": {"Quantity": 0},
        "S3OriginConfig": {
            "OriginAccessIdentity": "",
            "OriginReadTimeout": 30
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10,
        "OriginShield": {"Enabled": False},
        "OriginAccessControlId": oac_id
    }
    config['Origins']['Items'].append(new_origin)
    config['Origins']['Quantity'] = len(config['Origins']['Items'])
else:
    print(f"[py] Origin {prerender_origin_id} already present")

# ---- Cache behaviors ----
prerender_paths = [
    "/broadcasts/*",
    "/tournaments/*",
    "/arena/*",
    "/lectures/*",
    "/coach/*",
    "/player/*",
    "/archive/games/*",
    "/archive/players/*",
]

existing_patterns = {b['PathPattern'] for b in config['CacheBehaviors']['Items']}

def make_behavior(pattern):
    lambda_assoc = {"Quantity": 0}
    if lambda_edge_arn:
        lambda_assoc = {
            "Quantity": 1,
            "Items": [
                {
                    "LambdaFunctionARN": lambda_edge_arn,
                    "EventType": "origin-response",
                    "IncludeBody": False
                }
            ]
        }
    return {
        "PathPattern": pattern,
        "TargetOriginId": prerender_origin_id,
        "TrustedSigners": {"Enabled": False, "Quantity": 0},
        "TrustedKeyGroups": {"Enabled": False, "Quantity": 0},
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
            "Quantity": 2,
            "Items": ["HEAD", "GET"],
            "CachedMethods": {"Quantity": 2, "Items": ["HEAD", "GET"]}
        },
        "SmoothStreaming": False,
        "Compress": True,
        "LambdaFunctionAssociations": lambda_assoc,
        "FunctionAssociations": {
            "Quantity": 1,
            "Items": [
                {"FunctionARN": fn_arn, "EventType": "viewer-request"}
            ]
        },
        "FieldLevelEncryptionId": "",
        "CachePolicyId": cache_policy_id,
        "GrpcConfig": {"Enabled": False}
    }

added = 0
updated = 0
prerender_set = set(prerender_paths)
new_items = []
for b in config['CacheBehaviors']['Items']:
    if b['PathPattern'] in prerender_set:
        # Перестраиваем правило для актуализации Lambda@Edge ARN.
        new_items.append(make_behavior(b['PathPattern']))
        updated += 1
        print(f"[py] Refreshed behavior {b['PathPattern']}")
    else:
        new_items.append(b)
config['CacheBehaviors']['Items'] = new_items

for p in prerender_paths:
    if p in existing_patterns:
        continue
    config['CacheBehaviors']['Items'].append(make_behavior(p))
    added += 1
    print(f"[py] Added behavior {p}")
config['CacheBehaviors']['Quantity'] = len(config['CacheBehaviors']['Items'])
print(f"[py] Added {added} new, refreshed {updated}, total now {config['CacheBehaviors']['Quantity']}")

# ---- CustomErrorResponse не трогаем ----
# Запасной маршрут 404 → /index.html обеспечивает Lambda@Edge точечно
# на prerender-правилах, distribution-wide ответ ломал бы ALB API (см. ADR-128 §7.3.4).
print("[py] CustomErrorResponses untouched (handled by Lambda@Edge on prerender behaviors)")

# Persist
out = {"DistributionConfig": config, "ETag": src['ETag']}
json.dump(out, open('/tmp/cf-dist-new.json', 'w'), indent=2)

# Прокинуть DistributionConfig в файл для update-distribution
json.dump(config, open('/tmp/cf-dist-config-update.json', 'w'), indent=2)
print("[py] Wrote /tmp/cf-dist-config-update.json")
PYEOF

# --- 4) Apply ---
echo "[wire] Applying update-distribution"
aws cloudfront update-distribution \
    --id "$DIST_ID" \
    --distribution-config "file:///tmp/cf-dist-config-update.json" \
    --if-match "$ETAG" \
    --query "{Id:Distribution.Id, Status:Distribution.Status, DomainName:Distribution.DomainName}" \
    --output table

echo
echo "[wire] Done. Distribution update is propagating (15-20 min)."
echo "       Watch:"
echo "         aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.Status' --output text"
