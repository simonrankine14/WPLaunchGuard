# WordPress QA Commands Cheat Sheet

## Core workflow

1) Run the QA suite (all browsers/devices, default)

```bash
npm run qa -- <clientname>
```

Or via the global CLI:

```bash
wplaunchguard run <clientname>
```

Or without a global install:

```bash
npx wplaunchguard run <clientname>
```

2) Generate the Excel dashboard

```bash
npm run qa:report -- <clientname>
```

3) Generate the interactive HTML report (Base44-style)

```bash
npm run qa:html -- <clientname>
```

Branding:

- Tool name is hard-coded to `WP LaunchGuard`.
- Logo is loaded from `reporting/assets/logo.png` (or `.jpg` / `.svg`) and embedded into the HTML so the report stays self-contained.

## Client URL files

- Create `data/clients/<clientname>.json` with a `urls` array.
- Legacy `data/Clients/<clientname>.json` is also supported.
- If it doesn't exist, the run fails by default (prevents wrong-client URL scans).
- Optional legacy fallback: set `QA_ALLOW_GLOBAL_URL_FALLBACK=true` to allow `data/urls.json`.

## Speed / scope controls

4) Quick run (faster, skips Lighthouse; optimized for stability)

```bash
npm run qa -- <clientname> --quick
```

Quick mode behavior:

- Defaults to `--workers=1` (unless `--workers` is explicitly set).
- Sets `SKIP_LIGHTHOUSE=true`.
- If not explicitly set, defaults `FORM_SUBMIT_MODE=dry-run` and `SCREENSHOTS_MODE=off`.

Quick run with SEO checks disabled:

```bash
npm run qa -- <clientname> --quick --skip-seo
```

5) Custom project list

```bash
npm run qa -- <clientname> --projects=chrome-desktop-1920,windows-laptop-1272
```

6) Override worker count (useful when staging is fragile)

```bash
npm run qa -- <clientname> --projects=chrome-desktop-1920 --workers=1
```

7) Pull URLs from a sitemap (sitemap index supported)

```bash
npm run qa -- <clientname> --sitemap=https://www.example.com/sitemap_index.xml
```

Skip template sampling (keep every sitemap URL):

```bash
npm run qa -- <clientname> --sitemap=https://www.example.com/sitemap_index.xml --sitemap-no-sample
```

Note: sitemap runs sample one URL per common template group (blog/news/insights/case-studies/etc.).

8) Cap sitemap URLs (default 200)

```bash
npm run qa -- <clientname> --sitemap=https://www.example.com/sitemap_index.xml --sitemap-limit=200
```

Disable sitemap sampling (keep every URL):

```bash
npm run qa -- <clientname> --sitemap=https://www.example.com/sitemap_index.xml --sitemap-no-sample
```

9) Archive screenshots before cleanup

```bash
npm run qa -- <clientname> --archive-screenshots
```

10) Keep previous reports (no cleanup)

```bash
npm run qa -- <clientname> --keep-reports
```

11) Run with basic auth (staging/dev)

```bash
npm run qa -- <clientname> --auth-user=demo1 --auth-pass=demo1

12) Set profile / audience defaults from CLI

```bash
npm run qa -- <clientname> --profile=client-safe --report-audience=client
```
```

## Setup

12) Install dependencies

```bash
npm install
```

13) Install Playwright browsers

```bash
npx playwright install
```

## Visual regression

14) Capture baseline screenshots

```bash
npm run visual:baseline -- <clientname> --base=https://oldsite.example.com
```

15) Compare against new site

```bash
npm run visual:compare -- <clientname> --base=https://oldsite.example.com --target=https://newsite.example.com
```

16) Generate visual summary

```bash
npm run visual:summary -- <clientname>
```

17) Generate visual dashboard (HTML)

```bash
npm run visual:dashboard -- <clientname> [--logo=/abs/path/to/logo.png]
```

Creates `reports/<clientname>/visual/visual_dashboard.html` with filters, counts, and inline diff/baseline/current thumbnails.

Optional visual flags:

- `--projects=chrome-desktop-1920,windows-laptop-1272,iphone-14,ipad`
- `--sitemap=https://example.com/sitemap_index.xml`
- `--sitemap-limit=200`
- `--single=https://example.com/page/`
- `--diff-threshold=0.1`
- `--auth-user=demo1 --auth-pass=demo1`
- `--base-auth-user=... --base-auth-pass=...` (baseline only)
- `--target-auth-user=... --target-auth-pass=...` (target only)
- `--mask=.selector1,.selector2` — mask inline; combines with defaults (cookie/chat/video) unless `--no-default-masks`
- `--hide=.selector` — hide inline
- `--wait-for=.hero` — extra wait-for selectors
- `--no-default-masks` — disable automatic cookie/chat/video masks
- `--no-cookie-accept` — skip automatic consent clicks
- `--scroll-wait-ms=150` — delay between lazy-load scroll steps
- `--headless=false` — open browser windows for debugging

Single-page shortcut (no client files needed):

```bash
npm run visual:page -- --baseline=https://oldsite.example.com/page --target=https://newsite.example.com/page
```

Optional extras: `--label=about-page` (sets report folder name), `--projects=chrome-desktop-1920,iphone-14`, `--diff-threshold=0.05`.

Blank capture handling:
- If a screenshot is >95% white/transparent, we retry once with masks disabled.
- If still blank, status becomes `BLANK`, noted in CSV/Dashboard and counted as a failure.

## Common environment flags

Set flags before the command, e.g.:

```bash
SKIP_LIGHTHOUSE=true npm run qa -- <clientname>
```

- `SKIP_LIGHTHOUSE=true` — skip Lighthouse.
- `SKIP_AXE=true` — skip axe accessibility checks.
- `QA_PROFILE=client-safe|engineering-deep` — selects default fail/evidence behavior (`client-safe` default).
- `REPORT_AUDIENCE_DEFAULT=client|developer` — default audience in HTML report (`client` default).
- `FORM_SUBMIT_MODE=live` — actually submit forms and wait for a success/error message (default).
- `FORM_SUBMIT_MODE=dry-run` — do not submit (avoids sending emails/leads); still checks validation and error states.
- `LINK_SCOPE=internal|all` — internal-only link checks by default (`internal`).
- `LINK_CHECK_TIMEOUT_MS=7000` — timeout for each link check request.
- `CONSOLE_ALLOWLIST="pattern1|pattern2"` — ignore console errors (regex or substring).
- `PAGE_ERROR_ALLOWLIST="pattern1|pattern2"` — ignore page errors (regex or substring).
- `SCREENSHOTS_MODE=off|issues` — control screenshot capture (default `off` for `client-safe`, `issues` for `engineering-deep`).
- `SCREENSHOTS_LIMIT=2` — limit screenshots per page when issues mode is on.
- `QA_MEDIA=1` — re-enable Playwright's built-in screenshot/video-on-failure (default off).
- `NAV_RETRIES=2` — navigation retries for transient network errors.
- `RUN_MOBILE_CHECKS=true` — force mobile checks on desktop projects (default false).
- `FAIL_ON_AXE=true` — fail pages on serious/critical axe violations (default false; still reported).
- `FAIL_ON_LIGHTHOUSE=true` — fail pages on Lighthouse thresholds (default false; still reported).

## Fail rule thresholds

- `FAIL_ON_CONSOLE_SEVERITY=medium`
- `FAIL_ON_PAGE_ERROR_SEVERITY=critical`
- `FAIL_ON_AXE_SEVERITY=serious`
- `FAIL_ON_MISSING_ALT=true`
- `FAIL_ON_H1=true`
- `FAIL_ON_BROKEN_LINKS=true`
- `FAIL_ON_LINK_CHECK_ERRORS=false`
- `FAIL_ON_FORMS=true`
- `FAIL_ON_LIGHTHOUSE_PERF=60`
- `FAIL_ON_LIGHTHOUSE_SEO=70`
- `FAIL_ON_LIGHTHOUSE_BEST_PRACTICES=70`
- `FAIL_ON_LIGHTHOUSE_ACCESSIBILITY=80`

Precedence:
- Explicit env vars override profile defaults.
- Profile defaults apply only when an env var is not set.

## Canonical run artifacts

- `reports/<clientname>/run_meta.json` - run status and merge diagnostics (`complete`, `partial`, `interrupted`, `merge_failed`).
- `reports/<clientname>/url_summary.csv` - merged URL-level status summary across workers/projects.
- `reports/<clientname>/qa_html/index.html` - primary human-readable report (generated even for partial/interrupted runs).
