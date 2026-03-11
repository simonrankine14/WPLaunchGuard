# Week 4 Report Artifact Ingestion

Week 4 adds report-summary ingestion from GitHub scan runs back into API and WordPress dashboard.

## What is new

1. Workflow reads `reports/<client>/issues.json` and `run_meta.json`.
2. Workflow computes summary using `scripts/ci/collect-scan-summary.js`.
3. Workflow callback sends:
   - issue totals
   - severity/category breakdown
   - run state/counts
   - report artifact URL (`reports_artifact_url`)
4. API stores this data inside each scan `summary_json`.
5. Plugin dashboard renders summary metrics and report links.

## Data flow

1. `POST /v1/scans` -> queue job.
2. Queue consumer dispatches `baseline-scan.yml`.
3. Workflow runs QA and uploads artifact.
4. Workflow callback posts enriched summary to `/v1/internal/scan-callback`.
5. Plugin fetches `GET /v1/scans/{id}` and `GET /v1/sites/{id}/scans` to display metrics.

## Local checks

```bash
npm run week4:verify
```

## Important files

- `scripts/ci/collect-scan-summary.js`
- `.github/workflows/baseline-scan.yml`
- `services/api-worker/src/index.js`
- `wordpress-plugin/baseline/includes/class-baseline-admin.php`
