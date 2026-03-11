# Week 3 Dispatch Guide

Week 3 enables asynchronous scan execution dispatch from Cloudflare Queue to GitHub Actions, with callback updates to API scan status.

## New flow

1. Plugin calls `POST /v1/scans`.
2. API enqueues scan job.
3. Queue consumer dispatches `.github/workflows/baseline-scan.yml`.
4. Workflow runs QA and posts callback to `/v1/internal/scan-callback`.
5. API updates scan status to `completed` or `failed` with workflow metadata.

## Required configuration

### Worker vars (`services/api-worker/wrangler.toml`)

- `PUBLIC_API_BASE`
- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_WORKFLOW_FILE`
- `GITHUB_REF`

### Worker secrets

Set these via Wrangler:

```bash
npx wrangler secret put GITHUB_DISPATCH_TOKEN --config services/api-worker/wrangler.toml
npx wrangler secret put SCAN_CALLBACK_TOKEN --config services/api-worker/wrangler.toml
```

### GitHub repository secrets

In repo `Settings -> Secrets and variables -> Actions` add:

- `LAUNCHGUARD_CALLBACK_URL` = `https://baseline-api.simonrankine4.workers.dev/v1/internal/scan-callback`
- `LAUNCHGUARD_CALLBACK_TOKEN` = same value as `SCAN_CALLBACK_TOKEN`

## Deploy

```bash
npm run api:deploy
```

## Verify

```bash
npm run week3:verify
```

Then run one scan from WordPress dashboard and confirm status transitions:

`queued -> running/dispatched -> completed|failed`
