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

echo "Checking Week 4 files..."
check_file "scripts/ci/collect-scan-summary.js"
check_file ".github/workflows/baseline-scan.yml"
check_file "services/api-worker/src/index.js"
check_file "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_file "docs/week4-artifacts.md"

check_pattern "Collect scan summary" ".github/workflows/baseline-scan.yml"
check_pattern "reports_artifact_url" ".github/workflows/baseline-scan.yml"
check_pattern "deriveIssueTotalsFromSummary" "services/api-worker/src/index.js"
check_pattern "extract_scan_summary" "wordpress-plugin/baseline/includes/class-baseline-admin.php"
check_pattern "collect-scan-summary" "docs/week4-artifacts.md"

if command -v php >/dev/null 2>&1; then
  php -l "$ROOT_DIR/wordpress-plugin/baseline/includes/class-baseline-admin.php" >/dev/null
fi

node "$ROOT_DIR/scripts/ci/collect-scan-summary.js" "$ROOT_DIR/reports/RoadTrafficLaw" "RoadTrafficLaw" >/dev/null

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "Week 4 verification failed."
  exit 1
fi

echo

echo "Week 4 verification passed."
