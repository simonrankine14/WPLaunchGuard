# Week 1 Bootstrap Guide

This guide covers the new Week 1 scaffold in this repo.

## What was created

1. Cloudflare Worker API skeleton in `services/api-worker/`.
2. Initial D1 schema migration at `services/api-worker/migrations/0001_init.sql`.
3. WordPress plugin skeleton in `wordpress-plugin/baseline/`.
4. GitHub Actions starter workflows in `.github/workflows/`.

## Local checks

Run:

```bash
npm run week1:verify
```

## Cloudflare bootstrap (manual commands)

From repo root:

```bash
source .env.week0.local
```

Create D1 database (once):

```bash
npx wrangler d1 create baseline-db-dev
```

Create queue:

```bash
npx wrangler queues create baseline-scan-jobs-dev
```

Create R2 bucket:

```bash
npx wrangler r2 bucket create baseline-reports-dev
```

Update `services/api-worker/wrangler.toml` with your real `account_id` and `database_id`.

Apply migration:

```bash
npx wrangler d1 execute baseline-db-dev --file=services/api-worker/migrations/0001_init.sql
```

## Worker dev run

1. Copy `services/api-worker/.dev.vars.example` to `.dev.vars`.
2. Set `API_ADMIN_TOKEN`.
3. Run:

```bash
npm run api:dev
```

Health check endpoint:

```bash
curl http://127.0.0.1:8787/health
```

## WordPress plugin installation

1. Zip the `wordpress-plugin/baseline` folder.
2. In WordPress admin: `Plugins -> Add New -> Upload Plugin`.
3. Activate `Baseline`.
4. Open `Baseline -> Settings`.

Week 2 will wire plugin settings screens to live cloud endpoints.
