#!/usr/bin/env bash
# KS-1658: Archive extraction [D2]
# Фиксация инфраструктурной конфигурации для archive.kingside.site.
#
# Идемпотентный скрипт: создаёт Route53 A-alias, ACM-проверку, ALB listener rule
# и target group `kingside-archive-api` (c нулём target'ов — до выкатки KS-1659).
#
# Предпосылки (уже существуют в проде):
#   - ALB:       arn:aws:elasticloadbalancing:eu-central-1:342946498289:loadbalancer/app/kingside-alb/00e95cdb6a2a6576
#   - Listener:  arn:aws:elasticloadbalancing:eu-central-1:342946498289:listener/app/kingside-alb/00e95cdb6a2a6576/ad2373d1775d842d (HTTPS:443)
#   - ACM cert:  arn:aws:acm:eu-central-1:342946498289:certificate/141893d6-6abf-488b-867e-01189eb418d2
#                SAN: kingside.site, *.kingside.site  (wildcard уже покрывает archive.kingside.site)
#   - Zone:      /hostedzone/Z077890528QIIZLL7MESF (kingside.site.)
#   - VPC:       vpc-0d0d9344db8d11e7e
#
# Порядок ALB-правил на HTTPS:443 после применения:
#   1   archive.kingside.site → kingside-archive-api (empty TG → 503)
#   5   game.kingside.site    → kingside-game-tg
#   10  api.kingside.site     → kingside-api-tg
#   *   default               → kingside-api-tg
#
# Target'ы в `kingside-archive-api` регистрирует KS-1659 (ECS service).
# До выкатки сервиса ALB отвечает 503 с валидным TLS.

set -euo pipefail

REGION="eu-central-1"
VPC_ID="vpc-0d0d9344db8d11e7e"
ZONE_ID="Z077890528QIIZLL7MESF"
ALB_ARN="arn:aws:elasticloadbalancing:${REGION}:342946498289:loadbalancer/app/kingside-alb/00e95cdb6a2a6576"
ALB_DNS="kingside-alb-382263905.${REGION}.elb.amazonaws.com"
ALB_HOSTED_ZONE="Z215JYRZR1TBD5"
HTTPS_LISTENER_ARN="arn:aws:elasticloadbalancing:${REGION}:342946498289:listener/app/kingside-alb/00e95cdb6a2a6576/ad2373d1775d842d"

TG_NAME="kingside-archive-api"
RECORD_NAME="archive.kingside.site."
RULE_PRIORITY=1

aws_cli() { aws --region "${REGION}" "$@"; }

log() { printf '[archive-infra] %s\n' "$*"; }

# --- 1. Target group (idempotent) ---
TG_ARN="$(aws_cli elbv2 describe-target-groups --names "${TG_NAME}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"

if [[ -z "${TG_ARN}" || "${TG_ARN}" == "None" ]]; then
  log "creating target group ${TG_NAME}"
  TG_ARN="$(aws_cli elbv2 create-target-group \
    --name "${TG_NAME}" \
    --protocol HTTP --port 3003 \
    --vpc-id "${VPC_ID}" --target-type ip \
    --health-check-enabled \
    --health-check-protocol HTTP \
    --health-check-path /health \
    --health-check-port traffic-port \
    --health-check-interval-seconds 15 \
    --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 \
    --unhealthy-threshold-count 3 \
    --matcher HttpCode=200 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
else
  log "target group ${TG_NAME} exists: ${TG_ARN}"
fi

aws_cli elbv2 modify-target-group-attributes \
  --target-group-arn "${TG_ARN}" \
  --attributes Key=stickiness.enabled,Value=false \
               Key=deregistration_delay.timeout_seconds,Value=30 \
  >/dev/null
log "target group attributes applied (stickiness=false)"

# --- 2. Listener rule (idempotent) ---
EXISTING_RULE_ARN="$(aws_cli elbv2 describe-rules \
  --listener-arn "${HTTPS_LISTENER_ARN}" \
  --query "Rules[?Conditions[0].HostHeaderConfig.Values[0]=='archive.kingside.site'].RuleArn | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${EXISTING_RULE_ARN}" || "${EXISTING_RULE_ARN}" == "None" ]]; then
  log "creating listener rule (priority ${RULE_PRIORITY})"
  aws_cli elbv2 create-rule \
    --listener-arn "${HTTPS_LISTENER_ARN}" \
    --priority "${RULE_PRIORITY}" \
    --conditions "[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"archive.kingside.site\"]}}]" \
    --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TG_ARN}\"}]" \
    --query 'Rules[0].RuleArn' --output text >/dev/null
else
  log "listener rule already exists: ${EXISTING_RULE_ARN}"
fi

# --- 3. Route53 alias (idempotent via UPSERT) ---
log "upserting Route53 alias ${RECORD_NAME} → ${ALB_DNS}"
CHANGE_BATCH="$(cat <<EOF
{
  "Comment": "KS-1658: archive.kingside.site alias to kingside-alb",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${RECORD_NAME}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "${ALB_HOSTED_ZONE}",
          "DNSName": "${ALB_DNS}.",
          "EvaluateTargetHealth": true
        }
      }
    }
  ]
}
EOF
)"

CHANGE_ID="$(aws route53 change-resource-record-sets \
  --hosted-zone-id "${ZONE_ID}" \
  --change-batch "${CHANGE_BATCH}" \
  --query 'ChangeInfo.Id' --output text)"
log "Route53 change ${CHANGE_ID} submitted, waiting INSYNC"
aws route53 wait resource-record-sets-changed --id "${CHANGE_ID}"
log "Route53 INSYNC"

# --- 4. Sanity check ---
log "sanity: curl https://archive.kingside.site"
curl -sI --max-time 15 https://archive.kingside.site | head -5 || true

log "done"
