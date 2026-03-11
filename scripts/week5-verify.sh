#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
missing=0

check_file() {
  local file="$1"
  if [[ ! -f "$ROOT_DIR/$file" ]]; then
    echo "Missing file: $file"
    missing=1
  fi
}

check_pattern() {
  local pattern="$1"
  local file="$2"
  if ! rg -n "$pattern" "$ROOT_DIR/$file" >/dev/null 2>&1; then
    echo "Missing pattern '$pattern' in $file"
    missing=1
  fi
}

echo "Checking Week 5 files..."
check_file "services/api-worker/migrations/0002_billing.sql"
check_file "services/api-worker/src/index.js"
check_file "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_file "docs/week5-billing.md"
check_file "scripts/week5-verify.sh"

check_pattern "handleStripeWebhook" "services/api-worker/src/index.js"
check_pattern "/v1/stripe/webhook" "services/api-worker/src/index.js"
check_pattern "/billing/checkout-session" "services/api-worker/src/index.js"
check_pattern "scan_limit_reached" "services/api-worker/src/index.js"
check_pattern "render_billing" "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_pattern "handle_start_checkout" "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_pattern "Week 5 Billing" "docs/week5-billing.md"

if command -v php >/dev/null 2>&1; then
  php -l "$ROOT_DIR/wordpress-plugin/baseline/includes/class-baseline-admin.php" >/dev/null
fi

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "Week 5 verification failed."
  exit 1
fi

echo

echo "Week 5 verification passed."
