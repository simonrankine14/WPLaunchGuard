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

echo "Checking Week 3 files..."
check_file "services/api-worker/src/index.js"
check_file "services/api-worker/wrangler.toml"
check_file ".github/workflows/baseline-scan.yml"
check_file "docs/week3-dispatch.md"

check_pattern "dispatchScanToGitHub" "services/api-worker/src/index.js"
check_pattern "/v1/internal/scan-callback" "services/api-worker/src/index.js"
check_pattern "Callback Baseline API" ".github/workflows/baseline-scan.yml"
check_pattern "GITHUB_WORKFLOW_FILE" "services/api-worker/wrangler.toml"

if command -v php >/dev/null 2>&1; then
  php -l "$ROOT_DIR/wordpress-plugin/baseline/includes/class-baseline-admin.php" >/dev/null
fi

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "Week 3 verification failed."
  exit 1
fi

echo

echo "Week 3 verification passed."
