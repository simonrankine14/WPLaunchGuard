# Baseline (Website QA Platform)

Baseline is a website QA platform for confident sign-off.

## Quick start

```bash
npm install
npx playwright install
npm run qa -- clientname
npm run qa:report -- clientname
```

## Install as an npm CLI (Baseline)

Recommended (no global permissions required):

```bash
mkdir my-baseline-runner && cd my-baseline-runner
npm init -y
npm i -D baseline
npx baseline install-browsers
```

In any folder (this is where `reports/` will be created):

```bash
npx baseline init clientname --url=https://example.com/
npx baseline run clientname --sitemap=https://example.com/sitemap_index.xml --quick
npx baseline html clientname
npx baseline pdf clientname
npx baseline report clientname
```

Optional global install:

```bash
npm i -g baseline
baseline install-browsers
```

## Inputs

- Per-client URLs live in `data/clients/<clientname>.json` under the `urls` array.
  - Legacy `data/Clients/<clientname>.json` is also supported.
- By default, runs fail if no client file exists (prevents cross-client URL contamination).
  - Optional legacy fallback: set `QA_ALLOW_GLOBAL_URL_FALLBACK=true` to allow `data/urls.json`.
- You can also pass a sitemap URL at run time:
  - `--sitemap=https://example.com/sitemap_index.xml`
  - URLs are saved to `reports/<clientname>/urls.json` for traceability.
  - Template sampling is applied to common post-type paths (blog/news/insights/etc.) so only one URL per template is tested.

## Outputs

- Output folder defaults to `reports/<clientname>/`.
- By default, each run cleans previous `reports/<clientname>/` so only the latest run remains.
  - Use `--keep-reports` to preserve prior outputs.
  - Visual regression assets under `reports/<clientname>/visual` are preserved across QA runs.
- `reports/<clientname>/results.csv` - per-URL metrics and fail reasons.
- `reports/<clientname>/issues.tsv` - detailed issues list (Category/Severity/Title/etc.).
- `reports/<clientname>/issues.json` - JSON version of issues + summary for integrations.
- `reports/<clientname>/site_summary.csv` - de-duplicated issue summary across the site.
- `reports/<clientname>/url_summary.csv` - canonical per-URL merged status summary across projects/workers.
- `reports/<clientname>/run_meta.json` - canonical run state/merge diagnostics (`complete`, `partial`, `interrupted`, `merge_failed`).
- `reports/<clientname>/lighthouse/*.lighthouse.html` and `reports/<clientname>/lighthouse/*.lighthouse.json`.
- `reports/<clientname>/QA_Report.xlsx` - Excel dashboard.
- `reports/<clientname>/QA_Report.pdf` - client-safe PDF summary with sitewide Lighthouse averages.
- `reports/<clientname>/screenshots/*.png` - failure evidence screenshots.
- `reports/<clientname>/qa_html/index.html` - primary human-readable report (always generated, even on partial/interrupted runs).
  - Screenshot names include the issue slug: `<url-slug>-<browser>-<issue>.png`.

## Visual regression production checklist

- Install browsers once: `npx playwright install` (or set `PLAYWRIGHT_BROWSERS_PATH`).
- Use per-side auth if only the target requires credentials: `--target-auth-user/--target-auth-pass`.
- Leave default masks on unless they hide content; disable with `--no-default-masks` if needed.
- Automatic consent clicks run by default; disable with `--no-cookie-accept` if they interfere.
- Blank screenshots auto-retry without masks; persistent blanks are marked `BLANK` and treated as failures.
- Adjust lazy-load stability with `--wait-for` selectors and `--scroll-wait-ms`.
- Generate dashboard: `npm run visual:dashboard -- <client>` (auto-opens) to review baseline/current/diff and notes.

## Environment variables

- `QA_PROFILE` = `client-safe` (default) or `engineering-deep`.
  - `client-safe`: journey-based fail policy, screenshots default off, report optimized for shareable summaries.
  - `engineering-deep`: stricter noise tolerance and richer evidence defaults.
- `REPORT_AUDIENCE_DEFAULT` = `client` (default) or `developer` for initial HTML report audience.
- `FORM_SUBMIT_MODE` = `live` (default) or `dry-run`.
- `LINK_CHECK_CONCURRENCY` = number of parallel link checks (default `10`).
- `LINK_SCOPE` = `internal` (default) or `all`.
- `LINK_CHECK_TIMEOUT_MS` = per-link timeout in milliseconds (default `7000`).
- `MAX_SAMPLES` = sample size in reports (default `5`).
- `SKIP_LIGHTHOUSE` = `true` to disable Lighthouse.
- `SKIP_AXE` = `true` to disable axe.
- `STRICT` = `true` to enforce strict assertions.
- `CONSOLE_ALLOWLIST` = `pattern1|pattern2` to ignore known console errors.
- `PAGE_ERROR_ALLOWLIST` = `pattern1|pattern2` to ignore known page errors.
- `SCREENSHOTS_MODE` = `off` (default for `client-safe`) or `issues` (default for `engineering-deep`) to capture highlighted issue screenshots.
- `SCREENSHOTS_LIMIT` = max screenshots per page when in `issues` mode (default `2`).

Override precedence:
- Explicit env vars (for example `SCREENSHOTS_MODE`, fail thresholds) override profile defaults.
- Profile defaults apply when explicit env vars are not provided.

Fail rules (set thresholds/behavior):

- `FAIL_ON_CONSOLE_SEVERITY` = `medium` (default).
- `FAIL_ON_PAGE_ERROR_SEVERITY` = `critical` (default).
- `FAIL_ON_AXE_SEVERITY` = `serious` (default).
- `FAIL_ON_MISSING_ALT` = `true` (default).
- `FAIL_ON_H1` = `true` (default).
- `FAIL_ON_BROKEN_LINKS` = `true` (default).
- `FAIL_ON_LINK_CHECK_ERRORS` = `false` (default).
- `FAIL_ON_FORMS` = `true` (default).
- `FAIL_ON_LIGHTHOUSE_PERF` = `60` (default).
- `FAIL_ON_LIGHTHOUSE_SEO` = `70` (default).
- `FAIL_ON_LIGHTHOUSE_BEST_PRACTICES` = `70` (default).
- `FAIL_ON_LIGHTHOUSE_ACCESSIBILITY` = `80` (default).

## CLI flags

- `--projects=chrome-desktop-1920,windows-laptop-1272` to run a subset.
- `--quick` runs `chrome-desktop-1920` + `windows-laptop-1272`, forces `--workers=1` (unless explicitly set), and skips Lighthouse.
  - In quick mode, if not explicitly set, defaults are `FORM_SUBMIT_MODE=dry-run` and `SCREENSHOTS_MODE=off` for stability.
- `--skip-seo` skips SEO checks (H1 count, title/meta presence, JSON-LD, and Lighthouse SEO thresholding).
- `--profile=client-safe|engineering-deep` sets QA profile defaults (env override equivalent to `QA_PROFILE`).
- `--report-audience=client|developer` sets default audience in HTML report.
- `--full` runs all projects with Lighthouse template sampling (default).
- `--sitemap=https://example.com/sitemap_index.xml` to pull URLs from a sitemap (supports sitemap index).
- `--sitemap-limit=200` to cap sitemap-derived URLs (default 200).
- `--archive-screenshots` to zip prior screenshots before cleanup.
- `--keep-reports` to skip cleanup and keep previous reports.
- `--auth-user=<user>` and `--auth-pass=<pass>` for basic auth (staging/dev protection).

Examples:

```bash
npm run qa -- clientname --quick
npm run qa -- clientname --projects=chrome-desktop-1920,windows-laptop-1272
npm run qa -- clientname --sitemap=https://www.example.com/sitemap_index.xml
npm run qa -- clientname --sitemap=https://www.example.com/sitemap_index.xml --sitemap-limit=200
```

## Notes

- The test suite is designed to surface issues rather than block execution.
- Use `STRICT=true` if you want the run to fail on any issues detected.
- Client names are validated strictly (2-64 chars, letters/numbers/`_`/`-`, must start with letter/number).

## Visual Regression (baseline vs current)

Create a per-client config at `visual/config/<clientname>.json` (see `visual/config/example.json`) to hide or mask dynamic elements.

Baseline capture:

```bash
npm run visual:baseline -- <clientname> --base=https://oldsite.example.com
```

Compare against new site:

```bash
npm run visual:compare -- <clientname> --base=https://oldsite.example.com --target=https://newsite.example.com
```

Generate migration summary:

```bash
npm run visual:summary -- <clientname>
```

Optional flags:

- `--projects=chrome-desktop-1920,windows-laptop-1272,iphone-14,ipad`
- `--sitemap=https://example.com/sitemap_index.xml`
- `--sitemap-limit=200`
- `--single=https://example.com/page/`
- `--diff-threshold=0.1` (percent difference to fail)

Outputs:

- `reports/<clientname>/visual/baseline/<project>/*.png`
- `reports/<clientname>/visual/current/<project>/*.png`
- `reports/<clientname>/visual/diff/<project>/*.png`
- `reports/<clientname>/visual/visual_results.csv`
- `reports/<clientname>/visual/visual_summary.md`
