#!/bin/bash
# k6/seed-users.sh — Create test users and collect JWT tokens
# Uses dev-bypass endpoint (no bcrypt overhead).
# Outputs tokens to k6/tokens.json for use by k6 tests.
#
# Usage: ./k6/seed-users.sh [BASE_URL] [COUNT] [SECRET]
#
# Example:
#   ./k6/seed-users.sh http://localhost:3001 100 dev-secret
#   DEV_BYPASS_SECRET=mysecret ./k6/seed-users.sh https://staging.kingside.site/api 200

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
COUNT="${2:-100}"
SECRET="${3:-${DEV_BYPASS_SECRET:-dev-secret}}"
PREFIX="${USER_PREFIX:-k6user}"
OUTPUT="$(dirname "$0")/tokens.json"

echo "Seeding $COUNT test users at $BASE_URL via dev-bypass..."
echo "Output: $OUTPUT"

echo "[" > "$OUTPUT"

success=0
failed=0

for i in $(seq 1 "$COUNT"); do
  username="${PREFIX}${i}"

  response=$(curl -s -w "\n%{http_code}" \
    -X POST "$BASE_URL/auth/dev-bypass" \
    -H "Content-Type: application/json" \
    -d "{\"secret\":\"$SECRET\",\"user\":\"$username\"}")

  body=$(echo "$response" | head -n -1)
  status=$(echo "$response" | tail -n 1)

  if [ "$status" = "200" ] || [ "$status" = "201" ]; then
    accessToken=$(echo "$body" | grep -o '"accessToken":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$accessToken" ]; then
      ((success++))
      # Write JSON entry (comma-separated, no trailing comma)
      if [ "$success" -gt 1 ]; then
        echo "," >> "$OUTPUT"
      fi
      printf '  {"vuId":%d,"username":"%s","accessToken":"%s"}' "$i" "$username" "$accessToken" >> "$OUTPUT"
    else
      ((failed++))
      echo "  FAIL: $username — no accessToken in response"
    fi
  else
    ((failed++))
    echo "  FAIL: $username (HTTP $status)"
  fi

  if (( i % 50 == 0 )); then
    echo "  Progress: $i/$COUNT (ok=$success, fail=$failed)"
  fi
done

echo "" >> "$OUTPUT"
echo "]" >> "$OUTPUT"

echo ""
echo "Done: $success tokens saved, $failed failed"
echo "Tokens written to $OUTPUT"
