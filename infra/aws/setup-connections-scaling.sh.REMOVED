#!/usr/bin/env bash
# Setup ECS auto-scaling by ALB ActiveConnectionCount per target.
# Adds a target tracking policy: connections/target > 150 → scale out.
# Works alongside existing CPU-based scaling policy.
#
# Usage: bash infra/aws/setup-connections-scaling.sh
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
ALB_SUFFIX="app/kingside-alb/00e95cdb6a2a6576"
TARGET_CONNECTIONS=150
SCALE_OUT_COOLDOWN=60
SCALE_IN_COOLDOWN=300

echo "=== Setup Connections-based Auto-scaling ==="

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/kingside/kingside-api" \
  --scalable-dimension "ecs:service:DesiredCount" \
  --policy-name "kingside-api-connections-scaling" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration "{
    \"TargetValue\": ${TARGET_CONNECTIONS}.0,
    \"CustomizedMetricSpecification\": {
      \"Metrics\": [
        {
          \"Id\": \"conn\",
          \"Label\": \"ActiveConnections\",
          \"MetricStat\": {
            \"Metric\": {
              \"Namespace\": \"AWS/ApplicationELB\",
              \"MetricName\": \"ActiveConnectionCount\",
              \"Dimensions\": [
                {\"Name\": \"LoadBalancer\", \"Value\": \"${ALB_SUFFIX}\"}
              ]
            },
            \"Stat\": \"Sum\"
          },
          \"ReturnData\": false
        },
        {
          \"Id\": \"tasks\",
          \"Label\": \"RunningTasks\",
          \"MetricStat\": {
            \"Metric\": {
              \"Namespace\": \"ECS/ContainerInsights\",
              \"MetricName\": \"RunningTaskCount\",
              \"Dimensions\": [
                {\"Name\": \"ClusterName\", \"Value\": \"kingside\"},
                {\"Name\": \"ServiceName\", \"Value\": \"kingside-api\"}
              ]
            },
            \"Stat\": \"Average\"
          },
          \"ReturnData\": false
        },
        {
          \"Id\": \"per_target\",
          \"Label\": \"ConnectionsPerTarget\",
          \"Expression\": \"conn / tasks\",
          \"ReturnData\": true
        }
      ]
    },
    \"ScaleOutCooldown\": ${SCALE_OUT_COOLDOWN},
    \"ScaleInCooldown\": ${SCALE_IN_COOLDOWN}
  }" \
  --region "$REGION" \
  --output text --query 'PolicyARN'

echo ""
echo "=== Connections scaling policy created ==="
echo "  Target: ${TARGET_CONNECTIONS} connections per target"
echo "  ScaleOut cooldown: ${SCALE_OUT_COOLDOWN}s"
echo "  ScaleIn cooldown: ${SCALE_IN_COOLDOWN}s"
echo "  Metric: ActiveConnectionCount / RunningTaskCount"
