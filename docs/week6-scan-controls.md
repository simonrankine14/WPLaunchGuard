# Week 6: Scan Controls + Per-Page Metabox

## What shipped

1. Dashboard `Scan Setup` now includes global defaults:
- Evidence toggle.
- Lighthouse toggle.
- Quick scan toggle.
- Responsive scan toggle.
- Viewport preset (`desktop`, `mobile`, `both`) when responsive is enabled.

2. Post/Page/CPT editor now includes a `Baseline Page Scan` metabox:
- Read-only target URL (published permalink).
- Same scan option controls as dashboard.
- `Scan This Page` (per-page run).
- `Use Site Defaults` (forces global defaults for that run).
- Last page scan status + report link panel.

3. API + queue + workflow now accept and propagate:
- `target_url`.
- `scan_options`.
- `source_context`.

4. Latest scan UX keeps `View Report` as the primary completion path.

## Option reference

| Option | Effect on runner |
| --- | --- |
| `evidence_enabled=false` | `SCREENSHOTS_MODE=off` |
| `evidence_enabled=true` | `SCREENSHOTS_MODE=issues` |
| `lighthouse_enabled=false` | `SKIP_LIGHTHOUSE=true` |
| `lighthouse_enabled=true` | Lighthouse runs normally |
| `quick_scan_enabled=true` | Uses representative projects only |
| `quick_scan_enabled=false` | Uses full project set for selected viewport classes |
| `responsive_enabled=false` | Desktop class only |
| `responsive_enabled=true` + `viewport_preset=desktop` | Desktop class |
| `responsive_enabled=true` + `viewport_preset=mobile` | Mobile/tablet class |
| `responsive_enabled=true` + `viewport_preset=both` | Desktop + mobile/tablet classes |

## Data persistence

1. Global defaults: WordPress option `baseline_scan_defaults`.
2. Per-post override: post meta `_baseline_scan_options`.
3. Per-post default mode flag: post meta `_baseline_scan_use_site_defaults`.

## Troubleshooting

### Screenshots are zero

1. Check if `Evidence` was turned off for that scan.
2. If Evidence is on, screenshots are captured for issue rows only (`issues` mode), not every URL.
3. If there are no issue rows for the scanned URLs/project set, screenshot count can still be zero.

### Lighthouse files are missing

1. Verify `Lighthouse` was enabled for that run.
2. `Quick scan` can reduce coverage and sample set, so fewer Lighthouse outputs are expected.

### Scan feels too slow

1. Enable `Quick scan`.
2. Set `Responsive scan` off for desktop-only checks.
3. If responsive is needed, start with `Mobile` viewport preset to limit project fan-out.

