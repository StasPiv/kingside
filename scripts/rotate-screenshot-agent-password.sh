#!/usr/bin/env bash
# Rotate password of test-account __screenshot_agent (ADR-036 §3.5, KS-2258).
#
# Steps:
#   1. Generate new 40-char password (base64, [A-Za-z0-9]).
#   2. Overwrite SSM SecureString /kingside/prod/SCRN_AGENT_PASSWORD.
#   3. Run ECS RunTask `npm run seed:screenshot` to update prod DB hash.
#   4. Print the new password to stdout (operator must update agent host
#      env file or refetch from SSM at next agent restart).
#
# Usage:
#   bash scripts/rotate-screenshot-agent-password.sh
#
# Exit codes:
#   0 — rotation OK (password updated in SSM + DB)
#   1 — pre-flight check failed (AWS creds / dependencies)
#   2 — SSM put-parameter failed (DB not touched, old password still valid)
#   3 — RunTask seed:screenshot failed (SSM ahead of DB — see CloudWatch and
#       roll back SSM to previous version manually if needed)
#
# See scripts/screenshot-agent-rotation.md for full procedure and history.

set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-eu-central-1}"
PARAM_NAME="/kingside/prod/SCRN_AGENT_PASSWORD"
CLUSTER="kingside"
TD_FAMILY="kingside-api"

# --- Pre-flight ---

for cmd in aws openssl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: '$cmd' not found in PATH" >&2
        exit 1
    fi
done

if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
    echo "ERROR: AWS credentials not configured (aws sts get-caller-identity failed)" >&2
    exit 1
fi

# --- 1. Generate password ---

NEW_PASSWORD="$(openssl rand -base64 36 | tr -d '/+=' | head -c 40)"
if [ "${#NEW_PASSWORD}" -ne 40 ]; then
    echo "ERROR: generated password length=${#NEW_PASSWORD}, expected 40" >&2
    exit 1
fi
echo "[rotate] generated new password (40 chars)"

# --- 2. SSM put-parameter (overwrite) ---

if ! aws ssm put-parameter \
        --name "$PARAM_NAME" \
        --value "$NEW_PASSWORD" \
        --type SecureString \
        --overwrite \
        --region "$REGION" >/dev/null; then
    echo "ERROR: ssm put-parameter failed; DB password NOT changed" >&2
    exit 2
fi
SSM_VERSION=$(aws ssm describe-parameters \
    --filters "Key=Name,Values=$PARAM_NAME" \
    --region "$REGION" \
    --query 'Parameters[0].Version' --output text)
echo "[rotate] SSM $PARAM_NAME updated (version=$SSM_VERSION)"

# --- 3. ECS RunTask seed:screenshot to sync DB ---

# Resolve current task-def revision so we run on the latest image.
TD_REV=$(aws ecs describe-task-definition \
    --task-definition "$TD_FAMILY" \
    --query 'taskDefinition.revision' --output text \
    --region "$REGION")
echo "[rotate] using task-def $TD_FAMILY:$TD_REV"

# Resolve VPC/subnet/sg same way as deploy-aws.sh ensure_migrate_network().
VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=cidr-block,Values=10.0.0.0/16" \
    --query 'Vpcs[0].VpcId' --output text --region "$REGION")
SUBNET=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=cidr-block,Values=10.0.1.0/24" \
    --query 'Subnets[0].SubnetId' --output text --region "$REGION")
SG=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=kingside-ecs-sg" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' --output text --region "$REGION")

OVERRIDES=$(jq -n --arg pwd "$NEW_PASSWORD" '
    {
      containerOverrides: [
        {
          name: "kingside-api",
          command: ["npm","run","seed:screenshot"],
          environment: [{ name: "SCRN_AGENT_PASSWORD", value: $pwd }]
        }
      ]
    }
')

TASK_ARN=$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$TD_FAMILY:$TD_REV" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNET],securityGroups=[$SG],assignPublicIp=ENABLED}" \
    --overrides "$OVERRIDES" \
    --region "$REGION" \
    --query 'tasks[0].taskArn' --output text)
TASK_ID="${TASK_ARN##*/}"
echo "[rotate] RunTask started: $TASK_ID"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"
EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
    --query 'tasks[0].containers[0].exitCode' --output text)

if [ "$EXIT_CODE" != "0" ]; then
    echo "ERROR: seed:screenshot exit=$EXIT_CODE; SSM ahead of DB" >&2
    echo "ERROR: inspect /ecs/kingside-api/$TASK_ID in CloudWatch Logs" >&2
    echo "ERROR: rollback SSM via 'aws ssm get-parameter-history --name $PARAM_NAME' if needed" >&2
    exit 3
fi
echo "[rotate] DB password updated (exit=0)"

# --- 4. Tell the operator to refresh agent env ---

cat <<EOF

[rotate] DONE. Next steps for the operator:
  1) Update SCRN_AGENT_PASSWORD on the agent host (file or restart-time SSM
     fetch) so that scripts/screenshot.mjs sees the new value.
     - File-based: edit the .env consumed by webhook-server.py and run
       'just webhook-stop && just webhook' to reload agent containers.
     - SSM-based:  the next agent restart will re-fetch from SSM if the
       host is wired that way.
  2) Smoke-check (after KS-2259):
       node scripts/screenshot.mjs --url=https://kingside.site/lobby \\
         --out=/tmp/scrn-rotation-check.png --auth=test
     Expected: exit 0, /tmp/scrn-rotation-check.png exists.
  3) Append a row to scripts/screenshot-agent-rotation.md history table.

The password value is in SSM ($PARAM_NAME, version=$SSM_VERSION). It is NOT
printed to stdout for security; fetch it on the agent host:
  aws ssm get-parameter --name $PARAM_NAME --with-decryption \\
    --region $REGION --query 'Parameter.Value' --output text
EOF
