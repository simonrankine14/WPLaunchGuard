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

echo "Checking Week 2 files..."
check_file "services/api-worker/src/index.js"
check_file "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_file "docs/week2-integration.md"

check_pattern "x-baseline-site-token" "services/api-worker/src/index.js"
check_pattern "/v1/sites/" "services/api-worker/src/index.js"
check_pattern "admin_post_baseline_run_scan" "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_pattern "baseline_save_branding" "wordpress-plugin/baseline/includes/class-baseline-admin.php"

if command -v php >/dev/null 2>&1; then
  echo "Running PHP lint..."
  php -l "$ROOT_DIR/wordpress-plugin/baseline/baseline.php" >/dev/null
  php -l "$ROOT_DIR/wordpress-plugin/baseline/includes/class-baseline-plugin.php" >/dev/null
  php -l "$ROOT_DIR/wordpress-plugin/baseline/includes/class-baseline-admin.php" >/dev/null
fi

echo "API worker route check complete."

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "Week 2 verification failed."
  exit 1
fi

echo

echo "Week 2 verification passed."
