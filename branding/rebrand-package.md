# Baseline Rebrand Package

## Recommended Final Direction
### Chosen Name
`Baseline`

### Why It Wins
- It is immediately understandable and strongly tied to testing, standards, confirmation, and release readiness.
- It feels technical and product-led without drifting into cyber-security language.
- It works well for agencies and internal teams because it implies a clear reference point, not just a tool.
- It supports future product language naturally: checks, compare, reports, sign-off, status.

### Working Descriptor
Website QA with a clear standard.

### Elevator Pitch
Baseline helps teams test website changes properly, confirm what works, and share clear reports before release.

## Brand Proposition
Baseline gives web teams a dependable standard for website quality, so launches, migrations, and ongoing updates can be checked with confidence before they go live.

## Brand Promise
Set the standard before release.

## Tagline Directions
- Website QA with a clear standard.
- Set the standard before release.
- Measure changes. Confirm quality.
- Website QA for confident sign-off.
- A clearer standard for website releases.

## Verbal Identity
### Primary Homepage Headlines
- Set a clear standard for website quality.
- Confirm every website change before release.
- Website QA built for confident sign-off.

### Supporting Copy
- Baseline helps teams check changes, confirm what works, and produce clear reports before launch, relaunch, or handover.
- Run structured website QA across pages, devices, and user journeys, then turn the results into readable evidence your team and clients can trust.

### Messaging Dos
- Lead with standard, confirmation, trust, sign-off, and quality
- Use plain, direct language
- Emphasize dependable evidence over technical theatre

### Messaging Don'ts
- Do not use cyber-security aesthetics or language
- Do not overuse developer slang or startup hype
- Do not make WordPress the headline public identity

## Visual Identity
### Core Principle
Baseline should feel like an engineering-grade measurement brand, not a security brand.

### Typography
- Primary brand/UI typeface: `Untitled Sans`
- Fallback stack in concept assets: `'Untitled Sans', 'Helvetica Neue', Arial, sans-serif`
- Data accent only: a restrained mono such as `Geist Mono`

Why `Untitled Sans` fits:
- neutral
- plain-spoken
- technical without feeling cold
- high-trust and editorial rather than trendy

### Colour System
- Baseline Ink `#16181D`
- Slate `#566273`
- Steel Mist `#A7B1BA`
- Chalk `#F3F1EC`
- Stone `#D8D2C8`
- Signal Rust `#C8674A`

Usage:
- `Ink` for wordmark, headings, and primary interface text
- `Slate` as the main brand colour
- `Chalk` and `Stone` for surfaces and report backgrounds
- `Signal Rust` only for emphasis, warnings, and status accents

### Logo Direction
Wordmark-first, lowercase preferred: `baseline`

The icon system should be built from datum lines, ticks, measured offsets, and reference marks. It should suggest calibration and sign-off, not scanning or defence.
The chosen shape is a framed plotting field with a restrained rising line. It should suggest measured progress, confirmation, and dependable performance without becoming a literal dashboard graphic.

Avoid:
- shields
- checkmarks
- bug/insect motifs
- radar sweeps
- neon gradients
- hexagonal cyber tropes

## Asset Pack
Created assets:
- `baseline-wordmark.svg`
- `baseline-lockup.svg`
- `baseline-icon-datum.svg`
- `baseline-icon-offset.svg`
- `baseline-brand-board.svg`

Note:
- The SVGs reference `Untitled Sans` in their font stack for layout direction.
- Final production exports should be outlined or exported on a machine with the font installed.

## Icon Concepts
### Chosen Direction: Rising Metric Frame
A framed plotting field with a restrained rising line inside it. This is the primary Baseline mark for app icon, favicon, report logo, and brand lockup use.

## Naming System
Keep the architecture straightforward:
- Baseline Reports
- Baseline Compare
- Baseline Checks
- Baseline Exports

## Rollout Notes For Repo Touchpoints
### Public-facing rename first
- [README.md](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/README.md)
- [COMMANDS.md](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/COMMANDS.md)
- [reporting/generate-html-report.js](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/reporting/generate-html-report.js)
- [reporting/assets/README.md](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/reporting/assets/README.md)

### Compatibility-sensitive identifiers
- [package.json](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/package.json)
- [bin/baseline.js](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/bin/baseline.js)
- [.github/workflows/baseline-scan.yml](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/.github/workflows/baseline-scan.yml)
- [services/api-worker/src/index.js](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/services/api-worker/src/index.js)
- [services/api-worker/wrangler.toml](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/services/api-worker/wrangler.toml)

### Highest-risk legacy surfaces
- [wordpress-plugin/baseline/baseline.php](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/wordpress-plugin/baseline/baseline.php)
- [wordpress-plugin/baseline/includes/class-baseline-admin.php](/Users/simon/Documents/Chat GPT Codex QA Tool/NEW QA TOOL/wordpress-plugin/baseline/includes/class-baseline-admin.php)

Recommendation:
- update visible labels first
- keep plugin slug and low-level identifiers stable until migration is planned

## Acceptance Check
- Feels technical, calm, and dependable
- Reads as QA and sign-off, not security software
- Makes sense for agencies, reports, and release checks
- Works as a clean wordmark before any icon is introduced
