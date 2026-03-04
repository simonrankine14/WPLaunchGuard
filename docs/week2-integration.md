# Week 2 Integration Guide

Week 2 wires the WordPress plugin to live API endpoints.

## What changed

1. API adds site-token auth (`x-launchguard-site-token`) for site-specific routes.
2. API adds `GET /v1/sites/{site_id}/scans` and `GET /v1/sites/{site_id}/branding`.
3. WordPress dashboard can register site, run scans, and view status/limits.
4. Branding page now saves to cloud endpoint.

## Deploy API changes

```bash
npm run api:deploy
```

## Verify locally

```bash
npm run week2:verify
```

## WordPress setup steps

1. Zip `wordpress-plugin/wplaunchguard` and upload plugin in wp-admin.
2. Go to `LaunchGuard -> Settings` and set API Base URL:
   - `https://launchguard-api.simonrankine4.workers.dev`
3. Open `LaunchGuard -> Dashboard` and click `Register Site`.
4. Run first scan using dry-run mode.
5. Open `LaunchGuard -> Branding` and save brand settings.

## Smoke tests (manual)

1. Dashboard shows `Site ID` and tenant details after registration.
2. Running a scan adds an item in recent scans table.
3. Latest scan card updates status to `completed` after queue consumer runs.
4. Branding save returns success notice and persists values on refresh.
