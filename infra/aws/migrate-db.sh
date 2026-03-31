#!/bin/bash
# Migrate PostgreSQL data from Kamatera to AWS RDS
# This script was used once for initial migration. Kept for reference.
#
# Flow:
# 1. Create temp bastion EC2 in public subnet
# 2. pg_dump on Kamatera → transfer to bastion
# 3. pg_restore from bastion → RDS
# 4. Verify data
# 5. Cleanup bastion
#
# Executed: 2026-03-31
# Source: kamatera-chess (Docker postgres, 39MB)
# Target: kingside-db.c7gkqueu47cp.eu-central-1.rds.amazonaws.com
# Result: 33 tables, 44 migrations, 7 users, 44 games, 10000 puzzles

set -euo pipefail

echo "This script is for reference only."
echo "Migration was completed on 2026-03-31."
echo ""
echo "To re-run migration, uncomment the commands below and set variables."
exit 0

# --- Variables ---
# RDS_ENDPOINT="kingside-db.c7gkqueu47cp.eu-central-1.rds.amazonaws.com"
# RDS_PASS="<password>"
# VPC_ID="vpc-0d0d9344db8d11e7e"
# PUBLIC_SUBNET="subnet-0374b32497e079707"
# RDS_SG="sg-07c130de0992234e2"

# --- 1. pg_dump on Kamatera ---
# ssh kamatera-chess 'docker exec kingside-postgres-1 pg_dump -U kingside -Fc kingside > /tmp/kingside-dump.sql'

# --- 2. Create bastion, transfer dump ---
# (create bastion SG, EC2, install psql, scp dump)

# --- 3. pg_restore ---
# ssh -i bastion.pem ec2-user@BASTION_IP \
#   "PGPASSWORD='$RDS_PASS' pg_restore -h $RDS_ENDPOINT -U kingside -d kingside --no-owner --no-privileges --clean --if-exists /tmp/kingside-dump.sql"

# --- 4. Cleanup ---
# (terminate bastion, remove temp SG rules, set RDS back to private)
