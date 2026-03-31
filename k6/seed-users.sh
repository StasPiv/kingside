#!/bin/bash
# k6/seed-users.sh — Pre-register test users for load testing
# Usage: ./k6/seed-users.sh [BASE_URL] [COUNT]
#
# Example:
#   ./k6/seed-users.sh http://localhost:3001 100
#   ./k6/seed-users.sh https://kingside.site/api 200

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
COUNT="${2:-100}"
PREFIX="${USER_PREFIX:-k6user}"
PASSWORD="${USER_PASSWORD:-LoadTest2026!}"

echo "Seeding $COUNT test users at $BASE_URL..."

success=0
skipped=0
failed=0

for i in $(seq 1 "$COUNT"); do
  username="${PREFIX}${i}"
  email="${username}@loadtest.local"

  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$username\",\"email\":\"$email\",\"password\":\"$PASSWORD\"}")

  case $status in
    201) ((success++)) ;;
    409) ((skipped++)) ;;
    *)   ((failed++)); echo "  FAIL: $username (HTTP $status)" ;;
  esac

  # Rate limit: ~20 req/s
  if (( i % 20 == 0 )); then
    sleep 1
    echo "  Progress: $i/$COUNT (ok=$success, skip=$skipped, fail=$failed)"
  fi
done

echo ""
echo "Done: $success created, $skipped already existed, $failed failed"
