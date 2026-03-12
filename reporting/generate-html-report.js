const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveClientReportsDir, resolveRunRoot, validateClientId } = require('../scripts/lib/safe-paths');
const { safeHtml } = require('../scripts/lib/html-utils');
const { parseCSV, csvEscape } = require('../scripts/lib/csv-utils');

const TOOL_NAME = 'Baseline';
const BRAND_LOGO_CANDIDATES = [
  path.join(__dirname, 'assets', 'logo.svg'),
  path.join(__dirname, 'assets', 'logo.png'),
  path.join(__dirname, 'assets', 'logo.jpg'),
  path.join(__dirname, 'assets', 'logo.jpeg')
];

const VALID_RUN_STATES = new Set(['complete', 'partial', 'interrupted', 'merge_failed']);

// parseCSV is imported from scripts/lib/csv-utils.js

function asSeverity(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'major' || s === 'serious' || s === 'medium') return 'major';
  if (s === 'minor' || s === 'moderate') return 'minor';
  if (s === 'ignore' || s === 'none') return 'info';
  return s || 'info';
}

function categoryGroup(issue) {
  const cat = String(issue.Category || '').toLowerCase();
  const source = String(issue._source || '').toLowerCase();
  if (source === 'console' || source === 'page' || source === 'pageerror') return 'Console';
  if (cat === 'accessibility') return 'Accessibility';
  if (cat === 'seo') return 'SEO';
  if (cat === 'performance') return 'Performance';
  if (source === 'forms' || cat === 'forms') return 'Forms';
  // ux/quality/mobile/layout/etc collapse to "Structure" for human-first triage.
  return 'Structure';
}

// safeHtml is imported from scripts/lib/html-utils.js

function sanitizeHexColor(value, fallback) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) return raw;
  return fallback;
}

function toBool(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function truncateText(value, maxLength = 400) {
  const text = String(value ?? '');
  if (!Number.isFinite(maxLength) || maxLength < 4 || text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3).trimEnd() + '...';
}

function relLink(fromDir, repoRoot, maybeRelativePath) {
  if (!maybeRelativePath) return '';
  // Most evidence paths are stored relative to repo root (process.cwd()).
  const absolute = path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(repoRoot, maybeRelativePath);
  return path.relative(fromDir, absolute).split(path.sep).join('/');
}

function normalizeElementForDiff(element) {
  let output = String(element || '');
  output = output.replace(/\s+/g, ' ').trim();
  output = output.replace(/https?:\/\/[^)\s"]+/g, (match) => {
    try {
      const parsed = new URL(match);
      return parsed.origin + parsed.pathname;
    } catch {
      return match;
    }
  });
  return output;
}

function issueIdentity(issue) {
  return [
    issue.Category || '',
    issue.Severity || '',
    issue.Title || '',
    normalizeElementForDiff(issue.Element || '')
  ]
    .map((part) => String(part || '').toLowerCase())
    .join('|');
}

function computeIssueDelta(currentIssues, previousIssues) {
  const currentMap = new Map();
  currentIssues.forEach((issue) => {
    const key = issueIdentity(issue);
    const entry = currentMap.get(key) || { issue, count: 0 };
    entry.count += 1;
    currentMap.set(key, entry);
  });

  const previousMap = new Map();
  previousIssues.forEach((issue) => {
    const key = issueIdentity(issue);
    const entry = previousMap.get(key) || { issue, count: 0 };
    entry.count += 1;
    previousMap.set(key, entry);
  });

  const newIssues = [];
  currentMap.forEach((entry, key) => {
    if (!previousMap.has(key)) newIssues.push(entry);
  });

  const resolvedIssues = [];
  previousMap.forEach((entry, key) => {
    if (!currentMap.has(key)) resolvedIssues.push(entry);
  });

  const sortByCount = (a, b) => b.count - a.count;
  return {
    newCount: newIssues.length,
    resolvedCount: resolvedIssues.length,
    newTop: newIssues.sort(sortByCount).slice(0, 5),
    resolvedTop: resolvedIssues.sort(sortByCount).slice(0, 5)
  };
}

function computeFixPriority(issues, results) {
  const totalUrls = new Set(results.map((r) => r.url)).size || 1;
  const failedUrls = new Set(results.filter((r) => r.status === 'FAIL').map((r) => r.url));
  const weights = { critical: 4, major: 3, minor: 2, info: 1 };

  const groups = new Map();
  issues.forEach((issue) => {
    if (issue.isEnvironment) return;
    if (String(issue._source || '').toLowerCase() === 'blocked') return;
    const key = [
      categoryGroup(issue),
      asSeverity(issue.Severity || ''),
      issue.Title || '',
      issue.WCAG || ''
    ]
      .map((part) => String(part || '').toLowerCase())
      .join('::');
    const entry = groups.get(key) || { issue, urls: new Set() };
    if (issue.URL) entry.urls.add(issue.URL);
    groups.set(key, entry);
  });

  const candidates = Array.from(groups.values())
    .map((g) => {
      const severity = asSeverity(g.issue.Severity || '');
      const impacted = g.urls.size;
      const ratio = impacted / totalUrls;
      return {
        issue: g.issue,
        severity,
        impacted,
        ratio,
        urls: g.urls,
        score: impacted * (weights[severity] || 1)
      };
    })
    .filter((g) => g.ratio >= 0.7);

  const topIssues = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const impactedFailed = new Set();
  topIssues.forEach((g) => {
    g.urls.forEach((url) => {
      if (failedUrls.has(url)) impactedFailed.add(url);
    });
  });

  const failedCount = failedUrls.size || 1;
  const resolvedPercent = Math.round((impactedFailed.size / failedCount) * 100);

  return {
    issueCount: topIssues.length,
    resolvedPercent,
    issues: topIssues
  };
}

function loadBrandLogoDataUri() {
  const picked = BRAND_LOGO_CANDIDATES.find((p) => fs.existsSync(p));
  if (!picked) return { dataUri: '', pickedPath: '' };

  const ext = path.extname(picked).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.svg'
      ? 'image/svg+xml'
      : '';

  if (!mime) return { dataUri: '', pickedPath: picked };

  const buf = fs.readFileSync(picked);
  const base64 = buf.toString('base64');
  return { dataUri: `data:${mime};base64,${base64}`, pickedPath: picked };
}

function buildRootCausePanel({ issues, results }) {
  const uniqueUrls = new Set(results.map((r) => r.url)).size || 1;

  // 1) Global console resource failures (missing/unauthorized assets)
  const consoleGroups = new Map();
  for (const issue of issues) {
    if (issue.isEnvironment) continue;
    if (String(issue._source || '') !== 'console') continue;
    const resourceUrl = String(issue.resourceUrl || '').trim();
    if (!resourceUrl) continue;
    const key = `${resourceUrl}::${issue.httpStatus || ''}`;
    const entry = consoleGroups.get(key) || { resourceUrl, httpStatus: issue.httpStatus || '', urls: new Set() };
    entry.urls.add(issue.URL);
    consoleGroups.set(key, entry);
  }
  const topConsole = Array.from(consoleGroups.values())
    .map((g) => ({ ...g, count: g.urls.size, ratio: g.urls.size / uniqueUrls }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // 2) Repeated axe rules (by Title)
  const axeGroups = new Map();
  for (const issue of issues) {
    if (issue.isEnvironment) continue;
    if (String(issue._source || '') !== 'axe') continue;
    const key = String(issue.Title || 'Axe violation');
    const entry = axeGroups.get(key) || { title: key, urls: new Set() };
    entry.urls.add(issue.URL);
    axeGroups.set(key, entry);
  }
  const topAxe = Array.from(axeGroups.values())
    .map((g) => ({ ...g, count: g.urls.size, ratio: g.urls.size / uniqueUrls }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // 3) Global non-axe issues (by Title/Element)
  const otherGroups = new Map();
  for (const issue of issues) {
    if (issue.isEnvironment) continue;
    if (String(issue._source || '') === 'axe') continue;
    if (String(issue._source || '') === 'console') continue;
    const key = `${issue.Title}::${String(issue.Element || '').slice(0, 160)}`;
    const entry = otherGroups.get(key) || { title: issue.Title, element: issue.Element, urls: new Set(), severity: asSeverity(issue.Severity), category: categoryGroup(issue) };
    entry.urls.add(issue.URL);
    otherGroups.set(key, entry);
  }
  const topOther = Array.from(otherGroups.values())
    .map((g) => ({ ...g, count: g.urls.size, ratio: g.urls.size / uniqueUrls }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return { topConsole, topAxe, topOther, uniqueUrls };
}

function loadJsonIfPresent(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function loadCsvIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return parseCSV(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
}

function normalizeRunState(value, fallback = 'partial') {
  const state = String(value || '').toLowerCase().trim();
  if (VALID_RUN_STATES.has(state)) return state;
  return fallback;
}

function normalizeResultRow(row) {
  const source = row && typeof row === 'object' ? row : {};
  const status = String(source.status || 'PASS').toUpperCase();
  const safeStatus = ['PASS', 'FAIL', 'BLOCKED', 'ERROR'].includes(status) ? status : 'PASS';
  return {
    url: String(source.url || ''),
    status: safeStatus,
    browser: String(source.browser || ''),
    device: String(source.device || ''),
    viewport: String(source.viewport || ''),
    failReasons: truncateText(source.failReasons || '', 800),
    blockedReason: truncateText(source.blockedReason || '', 600),
    error: truncateText(source.error || '', 800),
    consoleErrors: String(source.consoleErrors || ''),
    pageErrors: String(source.pageErrors || ''),
    brokenLinks: String(source.brokenLinks || ''),
    h1Count: String(source.h1Count || ''),
    missingAlt: String(source.missingAlt || ''),
    brokenImages: String(source.brokenImages || ''),
    imagesMissingLazy: String(source.imagesMissingLazy || ''),
    metaTitle: truncateText(source.metaTitle || '', 300),
    metaDescriptionPresent: String(source.metaDescriptionPresent || ''),
    jsonLdPresent: String(source.jsonLdPresent || ''),
    formsTotal: String(source.formsTotal || ''),
    formsFailed: String(source.formsFailed || ''),
    axeViolations: String(source.axeViolations || ''),
    desktopOverflowCause: truncateText(source.desktopOverflowCause || '', 240),
    desktopOverflowSample: truncateText(source.desktopOverflowSample || '', 240),
    templateName: truncateText(source.templateName || '', 180),
    pluginHints: truncateText(source.pluginHints || '', 240),
    themeHints: truncateText(source.themeHints || '', 240),
    schemaTypes: truncateText(source.schemaTypes || '', 300),
    screenshotPath: String(source.screenshotPath || ''),
    lighthouseReportHtml: String(source.lighthouseReportHtml || ''),
    lighthouseReportJson: String(source.lighthouseReportJson || ''),
    lighthousePerformance: String(source.lighthousePerformance || ''),
    lighthouseAccessibility: String(source.lighthouseAccessibility || ''),
    lighthouseBestPractices: String(source.lighthouseBestPractices || ''),
    lighthouseSEO: String(source.lighthouseSEO || ''),
    templateKey: String(source.templateKey || '')
  };
}

function normalizeIssueRow(issue) {
  const source = issue && typeof issue === 'object' ? issue : {};
  return {
    Category: String(source.Category || ''),
    Severity: asSeverity(source.Severity),
    Title: truncateText(source.Title || 'Issue', 240),
    Description: truncateText(source.Description || '', 1000),
    Element: truncateText(source.Element || '', 1400),
    WCAG: String(source.WCAG || ''),
    Recommendation: truncateText(source.Recommendation || '', 1000),
    URL: String(source.URL || ''),
    _source: String(source._source || ''),
    resourceUrl: truncateText(source.resourceUrl || '', 400),
    httpStatus: String(source.httpStatus || ''),
    assetType: String(source.assetType || ''),
    isEnvironment: Boolean(source.isEnvironment),
    screenshotPath: String(source.screenshotPath || ''),
    canonicalKey: truncateText(source.canonicalKey || '', 320),
    actionability: String(source.actionability || ''),
    ownership: String(source.ownership || ''),
    journeyScope: String(source.journeyScope || ''),
    normalizedCause: truncateText(source.normalizedCause || '', 320),
    templateKey: String(source.templateKey || '')
  };
}

function normalizeSummaryRow(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    Issue: String(source.Issue || ''),
    Count: String(source.Count || ''),
    Example: String(source.Example || ''),
    Category: String(source.Category || ''),
    Severity: asSeverity(source.Severity || ''),
    ExampleURL: String(source.ExampleURL || ''),
    Recommendation: String(source.Recommendation || ''),
    Global: String(source.Global || ''),
    CanonicalKey: String(source.CanonicalKey || ''),
    Actionability: String(source.Actionability || ''),
    Ownership: String(source.Ownership || ''),
    JourneyScope: String(source.JourneyScope || '')
  };
}

function normalizeRunMeta(rawMeta, fallbackState, stats) {
  const source = rawMeta && typeof rawMeta === 'object' ? rawMeta : {};
  const stateFromMeta = normalizeRunState(source.state, fallbackState);
  const run = source.run && typeof source.run === 'object' ? source.run : {};
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
  const workersValue = run.workers;
  const normalizedWorkers =
    workersValue === null || workersValue === undefined || String(workersValue).trim() === ''
      ? null
      : Number.isFinite(Number(workersValue))
      ? Number(workersValue)
      : null;
  return {
    schemaVersion: Number(source.schemaVersion || 1),
    generatedAt: String(source.generatedAt || stats.generatedAt || new Date().toISOString()),
    state: stateFromMeta,
    run: {
      startedAt: String(run.startedAt || ''),
      endedAt: String(run.endedAt || ''),
      quick: Boolean(run.quick),
      full: Boolean(run.full),
      projects: Array.isArray(run.projects) ? run.projects.map((item) => String(item || '')) : [],
      workers: normalizedWorkers,
      interrupted: Boolean(run.interrupted),
      playwrightExitCode: Number.isFinite(Number(run.playwrightExitCode))
        ? Number(run.playwrightExitCode)
        : null
    },
    counts: {
      inputUrls: Number.isFinite(Number(counts.inputUrls)) ? Number(counts.inputUrls) : stats.totalUrls,
      resultRows: Number.isFinite(Number(counts.resultRows)) ? Number(counts.resultRows) : stats.totalRuns,
      uniqueUrls: Number.isFinite(Number(counts.uniqueUrls)) ? Number(counts.uniqueUrls) : stats.totalUrls,
      issueRows: Number.isFinite(Number(counts.issueRows))
        ? Number(counts.issueRows)
        : Number.isFinite(Number(counts.summaryRows))
        ? Number(counts.summaryRows)
        : 0,
      issueRowsRaw: Number.isFinite(Number(counts.issueRowsRaw)) ? Number(counts.issueRowsRaw) : null,
      summaryRows: Number.isFinite(Number(counts.summaryRows)) ? Number(counts.summaryRows) : 0,
      blockedSamples: Number.isFinite(Number(counts.blockedSamples)) ? Number(counts.blockedSamples) : 0
    }
  };
}

function inferFallbackRunState(results, rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object') {
    return 'partial';
  }
  const meta = rawMeta;
  if (VALID_RUN_STATES.has(String(meta.state || '').toLowerCase())) {
    return normalizeRunState(meta.state, 'partial');
  }
  if (meta.run && meta.run.interrupted) {
    return 'interrupted';
  }
  if (!Array.isArray(results) || results.length === 0) {
    return 'partial';
  }
  return 'complete';
}

function safeJsonForInlineScript(payload) {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function generate(clientName) {
  const packageRoot = path.join(__dirname, '..');
  const safeClientName = validateClientId(clientName);
  const reportClientLabel = String(process.env.REPORT_CLIENT_LABEL || '').trim() || safeClientName;
  const brandName = String(process.env.REPORT_BRAND_NAME || '').trim();
  const brandLogoUrl = String(process.env.REPORT_BRAND_LOGO_URL || '').trim();
  const brandPrimaryColor = sanitizeHexColor(process.env.REPORT_BRAND_PRIMARY_COLOR, '#2f86c3');
  const brandAccentColor = sanitizeHexColor(process.env.REPORT_BRAND_ACCENT_COLOR, '#34b3a0');
  const brandFooterText = String(process.env.REPORT_BRAND_FOOTER_TEXT || '').trim();
  const hideBaselineBranding = toBool(process.env.REPORT_HIDE_BASELINE_BRANDING);
  const reportDisplayName = hideBaselineBranding && brandName ? brandName : TOOL_NAME;
  const runRoot = resolveRunRoot(process.env, packageRoot);
  const reportsDir = resolveClientReportsDir(runRoot, safeClientName);
  const issuesJsonPath = path.join(reportsDir, 'issues.json');
  const resultsPath = path.join(reportsDir, 'results.csv');
  const summaryPath = path.join(reportsDir, 'site_summary.csv');
  const runMetaPath = path.join(reportsDir, 'run_meta.json');
  const outDir = path.join(reportsDir, 'qa_html');
  const outPath = path.join(outDir, 'index.html');
  const shareZipName = `share-${safeClientName}-latest.zip`;
  const shareZipPath = path.join(reportsDir, shareZipName);
  const hasShareZip = fs.existsSync(shareZipPath);
  const hasResultsCsv = fs.existsSync(resultsPath);
  const hasExcelWorkbook = fs.existsSync(path.join(reportsDir, 'QA_Report.xlsx'));
  const hasPdfReport = fs.existsSync(path.join(reportsDir, 'QA_Report.pdf'));
  const issuesPayload = loadJsonIfPresent(issuesJsonPath, { generatedAt: '', issues: [] });
  const rawResults = loadCsvIfPresent(resultsPath);
  const rawSummary = loadCsvIfPresent(summaryPath);
  const rawRunMeta = loadJsonIfPresent(runMetaPath, null);

  const results = rawResults.map((row) => normalizeResultRow(row));
  const summary = rawSummary.map((row) => normalizeSummaryRow(row));
  const issuesRaw = (Array.isArray(issuesPayload.issues) ? issuesPayload.issues : [])
    .map((row) => normalizeIssueRow(row))
    .map((row) => ({
      ...row,
      Severity: asSeverity(row.Severity),
      CategoryGroup: categoryGroup(row)
    }));

  const historyDir = path.join(runRoot, 'reports', '.history', safeClientName);
  const previousIssuesPath = path.join(historyDir, 'issues.previous.json');
  let previousIssuesPayload = null;
  if (fs.existsSync(previousIssuesPath)) {
    try {
      previousIssuesPayload = JSON.parse(fs.readFileSync(previousIssuesPath, 'utf8'));
    } catch {
      previousIssuesPayload = null;
    }
  }

  const stats = {
    client: safeClientName,
    generatedAt: String(issuesPayload.generatedAt || (rawRunMeta && rawRunMeta.generatedAt) || new Date().toISOString()),
    totalUrls: new Set(results.map((r) => r.url)).size,
    totalRuns: results.length,
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    blocked: results.filter((r) => r.status === 'BLOCKED').length,
    errored: results.filter((r) => r.status === 'ERROR').length
  };
  const fallbackState = inferFallbackRunState(results, rawRunMeta);
  const runMeta = normalizeRunMeta(rawRunMeta, fallbackState, stats);

  const issues = issuesRaw.map((issue) => ({
    ...issue,
    screenshotRel: relLink(outDir, runRoot, issue.screenshotPath || '')
  }));

  const displayIssues = issues.filter((issue) => String(issue._source || '').toLowerCase() !== 'lighthouse');

  const rootCause = buildRootCausePanel({ issues: displayIssues, results });
  const fixPriority = computeFixPriority(displayIssues, results);
  const hasUsableHistory =
    previousIssuesPayload &&
    previousIssuesPayload.client === stats.client &&
    Array.isArray(previousIssuesPayload.issues) &&
    previousIssuesPayload.issues.length > 0 &&
    previousIssuesPayload.generatedAt &&
    previousIssuesPayload.generatedAt !== stats.generatedAt &&
    runMeta.state === 'complete';

  const changeSummary = hasUsableHistory
    ? {
        prevGeneratedAt: previousIssuesPayload.generatedAt,
        ...computeIssueDelta(displayIssues, (previousIssuesPayload.issues || []).map((i) => ({
          ...i,
          Severity: asSeverity(i.Severity),
          CategoryGroup: categoryGroup(i)
        })))
      }
    : { prevGeneratedAt: '', newCount: 0, resolvedCount: 0, newTop: [], resolvedTop: [] };

  // Pre-compute evidence links relative to qa_html folder.
  const resultsWithLinks = results.map((row) => {
    const screenshot = row.screenshotPath ? row.screenshotPath.split(' | ')[0] : '';
    return {
      ...row,
      screenshotRel: relLink(outDir, runRoot, screenshot),
      lighthouseHtmlRel: relLink(outDir, runRoot, row.lighthouseReportHtml || ''),
      lighthouseJsonRel: relLink(outDir, runRoot, row.lighthouseReportJson || '')
    };
  });

  fs.mkdirSync(outDir, { recursive: true });
  const defaultAudienceRaw = String(process.env.REPORT_AUDIENCE_DEFAULT || 'client').toLowerCase();
  const defaultAudience = defaultAudienceRaw === 'developer' ? 'developer' : 'client';

  const data = {
    stats,
    clientLabel: reportClientLabel,
    results: resultsWithLinks,
    issues: displayIssues,
    summary,
    rootCause,
    fixPriority,
    changeSummary,
    wpInsights: {}, // populated later from results
    shareZip: hasShareZip ? `../${shareZipName}` : '',
    reportAssets: {
      csv: hasResultsCsv,
      excel: hasExcelWorkbook,
      pdf: hasPdfReport
    },
    runMeta,
    reportSettings: {
      defaultAudience,
      reportDisplayName,
      brandName,
      brandLogoUrl,
      brandPrimaryColor,
      brandAccentColor,
      brandFooterText,
      hideBaselineBranding
    }
  };
  // WordPress insights (derived client-side too, but store here for convenience if needed later)
  const jsonLdCoverage = results.filter((r) => String(r.jsonLdPresent).toLowerCase() === 'true').length;
  const wpInsights = {
    jsonLdCoveragePct: results.length ? Math.round((jsonLdCoverage / results.length) * 100) : 0,
    titleMissing: results.filter((r) => !r.metaTitle).length,
    metaDescriptionMissing: results.filter((r) => !r.metaDescriptionPresent).length,
    elementorDetected: results.some((r) => (r.templateKey || '').includes('tpl_')) || displayIssues.some((i) => (i.Element || '').includes('elementor-'))
  };

  const safeJsonPayload = safeJsonForInlineScript({ ...data, wpInsights });

  const { dataUri: brandLogoDataUri, pickedPath: brandLogoPath } = loadBrandLogoDataUri();
  const embeddedLogo = brandLogoUrl || brandLogoDataUri;
  if (!brandLogoDataUri) {
    console.warn(
      `[Baseline] Brand logo not found. Add one of: ${BRAND_LOGO_CANDIDATES
        .map((p) => path.relative(runRoot, p))
        .join(', ')}`
    );
  } else {
    console.log(`[Baseline] Embedded logo: ${path.relative(runRoot, brandLogoPath)}`);
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <title>${safeHtml(reportDisplayName)} - ${safeHtml(reportClientLabel)} Report</title>
    <style>
      :root{
        --bg: #f6f8fc;
        --panel: #ffffff;
        --panel2: #f3f6ff;
        --text: #0f172a;
        --muted: #667085;
        --border: #e6eaf5;
        --shadow: 0 8px 24px rgba(16, 24, 40, 0.06);
        --critical: #e11d48;
        --major: #f59e0b;
        --minor: #3b82f6;
        --info: #64748b;
        --pass: #16a34a;
        --blue: ${brandPrimaryColor};
        --accent: ${brandAccentColor};
        --blue2: #eef2ff;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      }
      *{box-sizing:border-box}
      body{
        margin:0;
        background: var(--bg);
        color:var(--text);
        font-family: "Inter", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      }
      body[data-audience="client"]{
        background:
          radial-gradient(1200px 900px at 15% 0%, rgba(59,130,246,.10), transparent 55%),
          radial-gradient(900px 700px at 90% 10%, rgba(16,185,129,.08), transparent 55%),
          radial-gradient(900px 800px at 60% 95%, rgba(14,165,233,.06), transparent 60%),
          var(--bg);
      }
      body[data-audience="developer"]{
        background:
          linear-gradient(180deg, rgba(245,158,11,.08), transparent 26%),
          radial-gradient(900px 700px at 85% 0%, rgba(245,158,11,.16), transparent 56%),
          radial-gradient(1100px 900px at 0% 100%, rgba(71,85,105,.16), transparent 62%),
          repeating-linear-gradient(
            -45deg,
            rgba(15,23,42,.028),
            rgba(15,23,42,.028) 10px,
            rgba(255,255,255,0) 10px,
            rgba(255,255,255,0) 22px
          ),
          var(--bg);
      }
      a{color:var(--blue);text-decoration:none}
      a:hover{text-decoration:underline}
      .wrap{max-width:1200px;margin:0 auto;padding:26px 22px 80px}

      .topbar{
        position:sticky;top:0;z-index:20;
        display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding:12px 14px;margin-bottom:10px;
        border:1px solid var(--border);border-radius:16px;background:rgba(255,255,255,.9);
        backdrop-filter: blur(12px);
      }
      body[data-audience="developer"] .topbar{
        border-color: rgba(245,158,11,.45);
        box-shadow: 0 10px 24px rgba(245,158,11,.12);
      }
      .brand{display:flex;align-items:center;gap:10px;font-weight:700}
      .brandMark{
        width:34px;height:34px;border-radius:10px;
        background: linear-gradient(135deg, rgba(37,99,235,.15), rgba(37,99,235,.04));
        border:1px solid var(--border);
        display:grid;place-items:center;color:var(--blue);
        overflow:hidden;
      }
      .brandMark img{max-width:28px;max-height:28px;display:block}
      .topActions{display:flex;gap:10px;flex-wrap:wrap}
      .topActions .btn[aria-pressed="true"]{
        background: rgba(37,99,235,.16);
        border-color: rgba(37,99,235,.40);
      }
      .btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed}

      .pageHead{margin: 6px 0 18px 0;}
      .pageHead h1{margin:0;font-size:26px;letter-spacing:.2px}
      .pageHead .sub{margin-top:8px;color:var(--muted);font-size:13px;display:flex;gap:16px;flex-wrap:wrap}
      .pageHead .pill{padding:4px 10px;border-radius:999px;border:1px solid var(--border);background:#fff;font-size:12px;color:var(--muted)}
      .pageHead .pill.ok{color:#0f172a;border-color: rgba(16,185,129,.4);background: rgba(16,185,129,.10)}
      .pageHead .pill.mode{
        color:#0f172a;
        border-color: rgba(37,99,235,.4);
        background: rgba(37,99,235,.10);
      }
      body[data-audience="developer"] .pageHead .pill.mode{
        border-color: rgba(245,158,11,.45);
        background: rgba(245,158,11,.14);
      }
      .audienceHero{
        margin: 0 0 12px 0;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: #fff;
        box-shadow: var(--shadow);
        padding: 12px 14px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
        flex-wrap: wrap;
      }
      .audienceHero .title{
        font-size: 13px;
        font-weight: 800;
        letter-spacing: .2px;
      }
      .audienceHero .desc{
        margin-top: 4px;
        max-width: 860px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .audienceHero .meta{
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .audienceHero .tag{
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .2px;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(15,23,42,.03);
      }
      body[data-audience="client"] .audienceHero{
        border-color: rgba(37,99,235,.26);
        background: linear-gradient(90deg, rgba(37,99,235,.08), rgba(16,185,129,.05));
      }
      body[data-audience="client"] .audienceHero .tag{
        border-color: rgba(37,99,235,.35);
        background: rgba(37,99,235,.12);
      }
      body[data-audience="developer"] .audienceHero{
        border-color: rgba(245,158,11,.36);
        background: linear-gradient(90deg, rgba(245,158,11,.17), rgba(71,85,105,.08));
      }
      body[data-audience="developer"] .audienceHero .tag{
        border-color: rgba(245,158,11,.44);
        background: rgba(245,158,11,.20);
      }

      .tabBar{
        position:sticky;top:70px;z-index:19;
        display:flex;gap:10px;flex-wrap:wrap;
        padding:10px 6px 6px;
        background: linear-gradient(90deg, rgba(255,255,255,0.9), rgba(255,255,255,0.8));
        backdrop-filter: blur(10px);
        margin-bottom:6px;
      }
      .tabBtn{
        border:1px solid var(--border);
        background:#fff;
        color:#0f172a;
        padding:8px 12px;
        border-radius:12px;
        font-size:13px;
        cursor:pointer;
        transition: all .18s ease;
      }
      .tabBtn[aria-selected="true"]{
        background: rgba(37,99,235,.12);
        border-color: rgba(37,99,235,.35);
        color:#0f172a;
        box-shadow: var(--shadow);
      }
      @media (min-width: 981px){
        .tabBar{display:none;}
        .stickyHeader{display:none;}
        .filtersHeader .title{display:none;}
      }
      .tabContent{display:none;animation: fade .18s ease;}
      .tabContent.active{display:block;}
      .reportShell{
        display:grid;
        grid-template-columns: 220px 1fr;
        gap:14px;
        align-items:start;
      }
      .sideNav{
        position:sticky;
        top:116px;
        border:1px solid var(--border);
        border-radius:14px;
        background: rgba(255,255,255,.92);
        backdrop-filter: blur(8px);
        padding:8px;
        box-shadow: var(--shadow);
        display:flex;
        flex-direction:column;
        gap:6px;
      }
      .sideNav .label{
        font-size:11px;
        text-transform: uppercase;
        letter-spacing: .3px;
        color: var(--muted);
        padding:4px 8px 2px;
      }
      .sideNavBtn{
        width:100%;
        text-align:left;
      }
      @media (max-width: 980px){
        .reportShell{
          grid-template-columns: 1fr;
        }
        .sideNav{
          display:none;
        }
        .filtersHeader .title{display:block;}
      }

      .runStateBanner{
        margin: 0 0 12px 0;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: #fff;
      }
      .runStateBanner strong{display:block;font-size:13px}
      .runStateBanner .meta{margin-top:5px;font-size:12px;color:var(--muted)}
      .runStateBanner.state-complete{
        border-color: rgba(16,185,129,.35);
        background: rgba(16,185,129,.10);
      }
      .runStateBanner.state-partial{
        border-color: rgba(245,158,11,.35);
        background: rgba(245,158,11,.10);
      }
      .runStateBanner.state-interrupted{
        border-color: rgba(239,68,68,.35);
        background: rgba(239,68,68,.10);
      }
      .runStateBanner.state-merge_failed{
        border-color: rgba(225,29,72,.38);
        background: rgba(225,29,72,.10);
      }

      .panel{
        border:1px solid var(--border);
        background:var(--panel);
        border-radius:18px;
        box-shadow: var(--shadow);
        padding:14px;
      }
      .panel.priority{
        border:2px solid rgba(37,99,235,.35);
        background: linear-gradient(135deg, rgba(37,99,235,.10), rgba(255,255,255,.95));
        box-shadow: 0 18px 40px rgba(37,99,235,.18);
      }
      .panelTitle{
        display:flex;align-items:center;justify-content:space-between;gap:10px;
        margin:0 0 10px 0;
      }
      .panelTitle h2{
        margin:0;
        font-size:12px;
        letter-spacing:.35px;
        color: var(--muted);
        text-transform:uppercase;
      }

      .checkGrid{display:grid;grid-template-columns:1fr;gap:12px;margin-top:14px}
      @media (min-width: 860px){ .checkGrid{grid-template-columns: 1fr 1fr;} }
      .checkItem{
        border:1px solid var(--border);
        background:#fff;
        border-radius:16px;
        padding:10px 12px;
        display:flex;align-items:flex-start;justify-content:space-between;gap:10px;
      }
      .checkItem strong{font-size:12px}
      .checkItem .meta{margin-top:4px;color:var(--muted);font-size:11px;line-height:1.35}
      .checkBadge{
        font-size:11px;
        padding:4px 8px;
        border-radius:999px;
        border:1px solid var(--border);
        background: rgba(15,23,42,.03);
        color: var(--muted);
        white-space:nowrap;
      }
      .checkBadge.ok{background: rgba(16,185,129,.10);border-color: rgba(16,185,129,.25);color:#10b981;}
      .checkBadge.warn{background: rgba(245,158,11,.10);border-color: rgba(245,158,11,.25);color: var(--major);}
      .checkBadge.bad{background: rgba(239,68,68,.10);border-color: rgba(239,68,68,.25);color: var(--critical);}

      .kpiRow{display:grid;grid-template-columns: 1fr;gap:14px;margin: 10px 0 18px 0;}
      @media (min-width: 860px){
        .kpiRow{grid-template-columns: repeat(4, 1fr);}
      }
      .kpi{
        border:1px solid var(--border);
        background: var(--panel);
        border-radius:16px;
        box-shadow: var(--shadow);
        padding:16px 16px;
        display:flex;align-items:center;justify-content:space-between;gap:10px;
        transition: transform .2s ease, box-shadow .2s ease;
      }
      .kpi:hover{transform: translateY(-2px);box-shadow: 0 12px 26px rgba(16,24,40,0.10)}
      .kpi .left{display:flex;align-items:center;gap:10px}
      .kpi .icon{
        width:38px;height:38px;border-radius:12px;display:grid;place-items:center;
        background: rgba(100,116,139,.10);
        border:1px solid rgba(100,116,139,.18);
        color: var(--info);
        font-weight:800;
      }
      .kpi[data-sev="critical"] .icon{background: rgba(239,68,68,.10);border-color: rgba(239,68,68,.22);color: var(--critical);}
      .kpi[data-sev="major"] .icon{background: rgba(245,158,11,.12);border-color: rgba(245,158,11,.26);color: var(--major);}
      .kpi[data-sev="minor"] .icon{background: rgba(59,130,246,.12);border-color: rgba(59,130,246,.26);color: var(--minor);}
      .kpi[data-sev="pass"] .icon{background: rgba(16,185,129,.12);border-color: rgba(16,185,129,.22);color: #10b981;}
      .kpi .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.3px}
      .kpi .value{font-size:26px;font-weight:800}

      .categoryGrid{display:grid;grid-template-columns:1fr;gap:14px;margin: 12px 0 18px 0;}
      @media (min-width: 860px){ .categoryGrid{grid-template-columns: repeat(4, 1fr);} }
      .categoryCard{
        border:1px solid var(--border);
        background:#fff;
        border-radius:16px;
        padding:14px 14px;
        box-shadow: var(--shadow);
        cursor:pointer;
        transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
      }
      .categoryCard:hover{transform: translateY(-2px);box-shadow: 0 12px 26px rgba(16,24,40,0.10);border-color: rgba(37,99,235,.35);}
      .categoryCard .title{font-weight:700;font-size:14px;margin:0 0 8px 0}
      .categoryCard .count{font-size:22px;font-weight:800;margin-bottom:6px}
      .categoryCard .desc{color:var(--muted);font-size:12px;line-height:1.4}
      .categoryCard .link{margin-top:10px;font-size:12px;color:var(--blue);font-weight:600}
      .categoryCard[data-sev="critical"]{border-left:4px solid var(--critical);}
      .categoryCard[data-sev="major"]{border-left:4px solid var(--major);}
      .categoryCard[data-sev="minor"]{border-left:4px solid var(--minor);}
      .categoryCard[data-sev="info"]{border-left:4px solid var(--info);}

      .stickyWrap{position:relative;top:auto;z-index:1;padding-top:4px;margin-top:4px}
      .stickyBar{
        border:1px solid var(--border);
        border-radius:12px;
        background: rgba(255,255,255,.94);
        box-shadow: 0 8px 18px rgba(15,23,42,.08);
        backdrop-filter: blur(8px);
        padding:8px 10px;
        display:flex;flex-direction:column;gap:8px;
      }
      .stickyHeader{display:none;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;}
      .stickyHeader .title{font-weight:800;font-size:14px}
      .stickyHeader .meta{color:var(--muted);font-size:12px;display:flex;gap:10px;flex-wrap:wrap}
      @media (max-width: 980px){
        .stickyWrap{position:sticky;top:0;z-index:16;}
        .stickyHeader{display:flex;}
      }

      .filters{
        padding:0;
        border:none;
        background: transparent;
        box-shadow: none;
        margin: 0;
      }
      .filtersHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
      .filtersHeader .title{font-weight:700;margin:0}
      .filtersHeader .hint{color:var(--muted);font-size:12px}
      .filterBlock{margin-top:8px}
      .filterBlock .label{color:var(--muted);font-size:12px;margin-bottom:6px}
      .chips{display:flex;gap:6px;flex-wrap:wrap}
      .chip{
        border:1px solid var(--border);
        background: #fff;
        color: #0f172a;
        padding:7px 10px;
        border-radius:12px;
        font-size:12px;
        cursor:pointer;
        user-select:none;
        display:flex;align-items:center;gap:8px;
        transition: all .2s ease;
      }
      .chip[data-on="1"]{
        background: rgba(37,99,235,.08);
        border-color: rgba(37,99,235,.28);
        color: #0f172a;
        box-shadow: 0 6px 12px rgba(37,99,235,.10);
      }
      .chip .count{
        padding:2px 8px;
        border-radius:999px;
        background: rgba(15,23,42,.06);
        border:1px solid rgba(15,23,42,.08);
        color: var(--muted);
        font-size:11px;
      }
      .chip[data-kind="severity"][data-sev="critical"][data-on="1"]{background: rgba(239,68,68,.10);border-color: rgba(239,68,68,.32);}
      .chip[data-kind="severity"][data-sev="major"][data-on="1"]{background: rgba(245,158,11,.12);border-color: rgba(245,158,11,.34);}
      .chip[data-kind="severity"][data-sev="minor"][data-on="1"]{background: rgba(59,130,246,.12);border-color: rgba(59,130,246,.34);}
      .chip[data-kind="severity"][data-sev="info"][data-on="1"]{background: rgba(100,116,139,.10);border-color: rgba(100,116,139,.28);}

      .searchRow{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
      input[type="search"]{
        flex:1;
        min-width: 260px;
        max-width: 620px;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #fff;
        color: var(--text);
        outline: none;
      }
      input[type="search"]:focus{border-color: rgba(37,99,235,.55);box-shadow: 0 0 0 4px rgba(37,99,235,.10);}
      .toggle{
        display:flex;align-items:center;gap:8px;
        color: var(--muted);
        font-size:12px;
        user-select:none;
      }

      .sectionH{margin: 18px 0 10px 0;font-size:14px}
      .sectionH .muted{font-size:12px;color:var(--muted);font-weight:500}
      .audienceModeNote{
        margin: 0 0 8px 0;
        font-size: 12px;
        color: var(--muted);
      }
      .audienceToast{
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 30;
        max-width: 360px;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.96);
        box-shadow: 0 8px 24px rgba(16,24,40,.14);
        font-size: 12px;
        color: var(--text);
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
        transition: opacity .16s ease, transform .16s ease;
      }
      .audienceToast.show{
        opacity: 1;
        transform: translateY(0);
      }
      #cards{display:grid;gap:12px;transition: opacity .2s ease}
      .issueFamilyAccordion{
        border:1px solid var(--border);
        border-radius:16px;
        background:#fff;
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .issueFamilySummary{
        list-style:none;
        cursor:pointer;
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:10px;
        padding:12px 14px;
        background: linear-gradient(180deg, rgba(15,23,42,.03), rgba(255,255,255,.92));
      }
      .issueFamilySummary::-webkit-details-marker{display:none}
      .issueFamilySummary .title{
        font-size:14px;
        font-weight:800;
        color:var(--text);
        line-height:1.3;
      }
      .issueFamilySummary .meta{
        margin-top:4px;
        color:var(--muted);
        font-size:12px;
      }
      .issueFamilySummary .badges{
        justify-content:flex-end;
      }
      .issueFamilyBody{
        padding: 10px 10px 2px 10px;
        border-top:1px solid var(--border);
        display:grid;
        gap:10px;
        background: rgba(255,255,255,.92);
      }
      body[data-audience="developer"] .issueFamilyAccordion{
        border-color: rgba(245,158,11,.24);
      }
      body[data-audience="developer"] .issueFamilySummary{
        background: linear-gradient(180deg, rgba(245,158,11,.12), rgba(255,255,255,.95));
      }

      details.card{
        border:1px solid var(--border);
        background: var(--panel);
        border-radius:18px;
        box-shadow: var(--shadow);
        overflow:hidden;
        margin-bottom: 12px;
        transition: transform .2s ease, box-shadow .2s ease;
      }
      details.card:hover{transform: translateY(-2px);box-shadow: 0 12px 24px rgba(16,24,40,0.10);}
      details.card[open]{outline: 3px solid rgba(37,99,235,.08);}
      body[data-audience="client"] details.card.card-client{
        border-color: rgba(37,99,235,.22);
      }
      body[data-audience="developer"] details.card.card-developer{
        border-color: rgba(245,158,11,.24);
        box-shadow: 0 12px 26px rgba(15,23,42,.11);
      }
      body[data-audience="developer"] details.card.card-developer[open]{
        outline-color: rgba(245,158,11,.26);
      }
      details.card[data-sev="critical"]{border-left:4px solid var(--critical);}
      details.card[data-sev="major"]{border-left:4px solid var(--major);}
      details.card[data-sev="minor"]{border-left:4px solid var(--minor);}
      details.card[data-sev="info"]{border-left:4px solid #94a3b8;}

      summary.cardSummary{
        list-style:none;
        cursor:pointer;
        display:grid;
        grid-template-columns: 12px 1fr;
        gap:12px;
        align-items:start;
        padding:14px 16px;
        background: #fff;
      }
      body[data-audience="client"] summary.cardSummary{
        background: linear-gradient(180deg, rgba(37,99,235,.04), rgba(255,255,255,.86));
      }
      body[data-audience="developer"] summary.cardSummary{
        background: linear-gradient(180deg, rgba(245,158,11,.13), rgba(255,255,255,.92));
      }
      summary.cardSummary::-webkit-details-marker{display:none}
      .sevRail{
        width:12px;
        height:100%;
        min-height:44px;
        border-radius:999px;
        background: var(--info);
        box-shadow: inset 0 0 0 1px rgba(15,23,42,.08);
      }
      details.card[data-sev="critical"] .sevRail{background: var(--critical);}
      details.card[data-sev="major"] .sevRail{background: var(--major);}
      details.card[data-sev="minor"] .sevRail{background: var(--minor);}
      details.card[data-sev="info"] .sevRail{background: #94a3b8;}
      .cardMain{min-width: 0;display:flex;flex-direction:column;gap:8px}
      .cardTitle{font-size:15px;margin:0;font-weight:700}
      .cardDesc{margin:0;color:var(--muted);font-size:12px;line-height:1.4}
      .badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .badge{
        font-size:11px;
        padding:4px 8px;
        border-radius:999px;
        border:1px solid var(--border);
        background: rgba(15,23,42,.03);
        color: var(--muted);
        white-space:nowrap;
        display:inline-flex;
        align-items:center;
        height:26px;
      }
      .badge.sev-critical{border-color: rgba(239,68,68,.30); color: rgba(239,68,68,.95); background: rgba(239,68,68,.08);}
      .badge.sev-major{border-color: rgba(245,158,11,.30); color: rgba(245,158,11,.95); background: rgba(245,158,11,.10);}
      .badge.sev-minor{border-color: rgba(59,130,246,.28); color: rgba(59,130,246,.95); background: rgba(59,130,246,.10);}
      .badge.sev-info{border-color: rgba(100,116,139,.22); color: rgba(100,116,139,.95); background: rgba(100,116,139,.08);}

      .cardBody{padding: 12px 14px 14px 14px;display:grid;gap:12px;border-top:1px solid var(--border);}
      details.card[open] .cardBody{animation: slideDown .2s ease}
      @keyframes slideDown{from{opacity:.6;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
      .sectionTitle{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.25px;margin:0 0 6px 0}
      .code{
        font-family: var(--mono);
        font-size: 12px;
        padding:10px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: #0b1220;
        color: #e5e7eb;
        overflow:auto;
        white-space: pre-wrap;
      }
      .actions{display:flex;gap:10px;flex-wrap:wrap}
      .btn{
        display:inline-flex;gap:8px;align-items:center;
        border:1px solid var(--border);
        background: #fff;
        color: #0f172a;
        padding:8px 10px;border-radius:12px;
        font-size:12px;text-decoration:none;cursor:pointer;
        transition: all .2s ease;
      }
      .btn.disabled{
        opacity:0.5;
        pointer-events:none;
      }
      .btn.primary{
        background: rgba(37,99,235,.10);
        border-color: rgba(37,99,235,.35);
        color: #0f172a;
      }
      .btn:hover{background: rgba(15,23,42,.03);text-decoration:none}

      .insightGrid{
        display:grid;
        grid-template-columns: 1fr;
        gap:14px;
        margin:12px 0 6px;
      }
      .insightSplit{
        display:grid;
        grid-template-columns: 1fr;
        gap:14px;
      }
      @media (min-width: 960px){
        .insightGrid{grid-template-columns: 1fr;}
        .insightSplit{grid-template-columns: 1fr 1fr;}
      }
      .insightTitle{font-weight:700;margin:0 0 6px 0;font-size:14px}
      .insightList{display:grid;gap:8px;margin-top:8px}
      .insightItem{
        display:flex;justify-content:space-between;align-items:center;
        gap:10px;padding:8px 10px;border-radius:12px;border:1px solid var(--border);
        background: rgba(15,23,42,.03);
        font-size:12px;
      }
      .insightItem .tag{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--border)}
      .insightItem .tag.critical{color:var(--critical);border-color: rgba(225,29,72,.35);background: rgba(225,29,72,.08)}
      .insightItem .tag.major{color:var(--major);border-color: rgba(245,158,11,.35);background: rgba(245,158,11,.08)}
      .insightItem .tag.minor{color:var(--minor);border-color: rgba(59,130,246,.35);background: rgba(59,130,246,.08)}
      .insightItem .tag.info{color:var(--info);border-color: rgba(100,116,139,.35);background: rgba(100,116,139,.08)}

      .urlList{display:flex;gap:8px;flex-wrap:wrap}
      .issueUrlList{
        margin: 0;
        padding-left: 18px;
        display:grid;
        gap:6px;
      }
      .issueUrlList li{
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
        word-break: break-word;
      }
      .issueInstanceList{
        display:grid;
        gap:8px;
      }
      .issueInstanceRow{
        border:1px solid var(--border);
        border-radius:12px;
        background:#fff;
        padding:10px;
        display:grid;
        gap:6px;
      }
      .issueInstanceRow .elem{
        font-size:12px;
        font-weight:600;
        color: var(--text);
        word-break: break-word;
      }
      .urlPill{
        font-size:11px;
        padding:4px 8px;
        border-radius:999px;
        border:1px solid var(--border);
        background: rgba(15,23,42,.03);
        color: var(--muted);
      }

      .pagesWrap{margin-top:18px}
      .pageTasks{display:grid;gap:10px}
      .pageCard{
        border:1px solid var(--border);
        border-radius:16px;
        background:#fff;
        box-shadow: var(--shadow);
        padding:12px 14px;
        display:flex;justify-content:space-between;gap:16px;align-items:flex-start;
      }
      .pageCard .meta{font-size:12px;color:var(--muted);margin-top:4px}
      .pageReasons{margin:8px 0 0 0;padding-left:16px;font-size:12px;color:var(--muted)}
      .pageActions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .status{
        font-size:11px;
        padding:3px 8px;
        border-radius:999px;
        border:1px solid var(--border);
        display:inline-block;
        background: rgba(15,23,42,.03);
        color: var(--muted);
      }
      .status-PASS{color:#10b981;border-color: rgba(16,185,129,.30);background: rgba(16,185,129,.10)}
      .status-FAIL{color:var(--major);border-color: rgba(245,158,11,.32);background: rgba(245,158,11,.10)}
      .status-BLOCKED,.status-ERROR{color:var(--critical);border-color: rgba(239,68,68,.32);background: rgba(239,68,68,.10)}
      .muted{color:var(--muted)}

      /* Evidence */
      .evidenceGrid{
        display:grid;
        gap:12px;
        grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
      }
      .evidenceCard{
        border:1px solid var(--border);
        border-radius:14px;
        background:#fff;
        box-shadow: var(--shadow);
        padding:10px;
        display:flex;
        flex-direction:column;
        gap:8px;
      }
      .evidenceCard img{
        width:100%;
        border-radius:10px;
        border:1px solid var(--border);
        display:block;
        background:#f8fafc;
      }
      .lhList{display:grid;gap:8px;margin-top:8px}
      .lhItem{
        border:1px solid var(--border);
        border-radius:12px;
        padding:10px;
        background:#fff;
        display:flex;justify-content:space-between;align-items:center;
      }
      .reportFooter{
        margin-top: 18px;
        padding: 12px 14px;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: #fff;
        color: var(--muted);
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand">
          <div class="brandMark">
            ${embeddedLogo ? `<img alt="Brand logo" src="${safeHtml(embeddedLogo)}" />` : 'B'}
          </div>
          <div>${safeHtml(reportDisplayName)}</div>
        </div>
        <div class="topActions">
          <button
            id="audienceToggle"
            class="btn"
            type="button"
            data-audience-toggle="1"
            onclick="if (window.__baselineToggleAudience) { window.__baselineToggleAudience(); } return false;"
          >Switch to Developer View</button>
          <a id="exportCsvBtn" class="btn primary" href="../results.csv" download>Export CSV</a>
          <a id="openPdfBtn" class="btn primary" href="../QA_Report.pdf" target="_blank" rel="noopener">Export PDF</a>
          <a id="shareZipBtn" class="btn" href="#" download>Export Evidence ZIP</a>
          <a id="openExcelBtn" class="btn" href="../QA_Report.xlsx" target="_blank" rel="noopener">Open Excel</a>
          <a id="lighthouseBtn" class="btn" href="#" target="_blank" rel="noopener">Lighthouse</a>
        </div>
      </div>

      <div class="pageHead">
        <h1>${safeHtml(reportDisplayName)} QA Report</h1>
        <div class="sub">
          <span class="pill">Client: ${safeHtml(reportClientLabel)}</span>
          <span class="pill">Generated: ${safeHtml(stats.generatedAt || new Date().toISOString())}</span>
          <span class="pill">Total URLs: ${safeHtml(stats.totalUrls)}</span>
          <span class="pill">Total runs: ${safeHtml(stats.totalRuns)}</span>
          <span class="pill">Run state: ${safeHtml(runMeta.state)}</span>
          <span class="pill mode" id="audienceHeadPill">Mode: Client Summary</span>
          <span class="pill ok">WordPress QA Mode Active</span>
        </div>
        <div class="topActions" style="margin-top:10px">
          <a id="goToPageFailuresBtn" class="btn" href="#page-failures">Go to Page Failures</a>
        </div>
      </div>
      <div id="runStateBanner" class="runStateBanner"></div>
      <div id="audienceHero" class="audienceHero"></div>

      <div class="tabBar" role="tablist" aria-label="Report sections">
        <button class="tabBtn" role="tab" aria-selected="true" data-tab="overview">Overview</button>
        <button class="tabBtn" role="tab" aria-selected="false" data-tab="issues">Issues</button>
        <button class="tabBtn" role="tab" aria-selected="false" data-tab="pages">Pages</button>
        <button class="tabBtn" role="tab" aria-selected="false" data-tab="evidence">Evidence</button>
        <button class="tabBtn" role="tab" aria-selected="false" data-tab="history">History</button>
      </div>

      <div class="reportShell">
        <aside class="sideNav" role="tablist" aria-label="Report sections sidebar">
          <div class="label">Sections</div>
          <button class="tabBtn sideNavBtn" role="tab" aria-selected="true" data-tab="overview">Overview</button>
          <button class="tabBtn sideNavBtn" role="tab" aria-selected="false" data-tab="issues">Issues</button>
          <button class="tabBtn sideNavBtn" role="tab" aria-selected="false" data-tab="pages">Pages</button>
          <button class="tabBtn sideNavBtn" role="tab" aria-selected="false" data-tab="evidence">Evidence</button>
          <button class="tabBtn sideNavBtn" role="tab" aria-selected="false" data-tab="history">History</button>
        </aside>
        <div>
      <div id="tab-overview" class="tabContent active">
        <div class="kpiRow" id="kpiRow"></div>
        <div id="lhNote" class="muted" style="margin:-4px 4px 8px 4px;"></div>
        <div class="insightGrid">
          <div class="panel priority" id="fixPriority"></div>
          <div class="insightSplit">
            <div class="panel" id="templateInsight"></div>
            <div class="panel" id="changeSummary"></div>
          </div>
        </div>
        <div id="checklistSummary" style="margin-top:8px"></div>
        <div class="categoryGrid" id="categorySummary"></div>
      </div>

      <div id="tab-issues" class="tabContent">
        <div class="stickyWrap">
          <div class="stickyBar">
            <div class="stickyHeader">
              <div>
                <div class="title">${safeHtml(reportDisplayName)} QA Report</div>
                <div class="meta" id="stickyMeta"></div>
                <div class="meta" id="stackMeta" style="margin-top:4px"></div>
              </div>
              <div class="topActions">
                <button
                  id="audienceToggleSticky"
                  class="btn"
                  type="button"
                  data-audience-toggle="1"
                  onclick="if (window.__baselineToggleAudience) { window.__baselineToggleAudience(); } return false;"
                >Switch to Developer View</button>
                <a id="exportCsvBtnSticky" class="btn primary" href="../results.csv" download>Export CSV</a>
                <a id="openPdfBtnSticky" class="btn primary" href="../QA_Report.pdf" target="_blank" rel="noopener">Export PDF</a>
                <a id="shareZipBtnSticky" class="btn" href="#" download>Export Evidence ZIP</a>
                <a id="openExcelBtnSticky" class="btn" href="../QA_Report.xlsx" target="_blank" rel="noopener">Open Excel</a>
                <a id="lighthouseBtnSticky" class="btn" href="#" target="_blank" rel="noopener">Lighthouse</a>
              </div>
            </div>

            <div class="filters">
              <div class="filtersHeader">
                <div class="title">Filter Issues</div>
                <div class="hint">
                  <button id="clearFilters" class="btn" type="button">Clear</button>
                </div>
              </div>

              <div class="filterBlock">
                <div class="label">Category</div>
                <div class="chips" id="categoryChips"></div>
              </div>

              <div class="filterBlock">
                <div class="label">Severity</div>
                <div class="chips" id="severityChips"></div>
              </div>

              <div class="searchRow">
                <input id="searchBox" type="search" placeholder="Search title / element / URL..." />
                <label class="toggle"><input id="globalOnly" type="checkbox" /> Global only</label>
              </div>
            </div>
          </div>
        </div>

        <div class="sectionH">Issues <span class="muted" id="issueCountLabel"></span></div>
        <div id="audienceModeNote" class="audienceModeNote"></div>
        <div id="cards"></div>
      </div>

      <div id="tab-pages" class="tabContent">
        <div class="pagesWrap" id="page-failures">
          <div class="sectionH">Pages <span class="muted">(all runs)</span></div>
          <div class="muted" style="margin-bottom:10px">PASS/FAIL/BLOCKED are per-URL per-project. Use BLOCKED to separate environment/auth issues from real site defects.</div>
          <div class="pageTasks" id="pagesTable"></div>
        </div>
      </div>

      <div id="tab-evidence" class="tabContent">
        <div class="sectionH">Evidence</div>
        <div class="muted" id="evidenceMeta"></div>
        <div class="sectionH" style="margin-top:12px">Screenshots</div>
        <div id="evidenceShots" class="evidenceGrid"></div>
        <div class="sectionH" style="margin-top:18px">Lighthouse Reports</div>
        <div id="evidenceLh" class="lhList"></div>
        <div class="sectionH" style="margin-top:18px">Blocked Samples</div>
        <div id="blockedSamples" class="lhList"></div>
      </div>

      <div id="tab-history" class="tabContent">
        <div class="sectionH">History</div>
        <div id="historyPane"></div>
      </div>
        </div>
      </div>
      <div id="reportFooter" class="reportFooter" style="display:none"></div>
    </div>
    <div id="audienceToast" class="audienceToast" aria-live="polite"></div>

    <script id="qa-report-data" type="application/json">${safeJsonPayload}</script>
    <script>
      (function(){
        let data = {
          stats: {},
          clientLabel: '',
          results: [],
          issues: [],
          summary: [],
          rootCause: { topConsole: [], topAxe: [], topOther: [], uniqueUrls: 0 },
          fixPriority: { issueCount: 0, resolvedPercent: 0, issues: [] },
          changeSummary: { prevGeneratedAt: '', newCount: 0, resolvedCount: 0, newTop: [], resolvedTop: [] },
          shareZip: '',
          reportAssets: { csv: true, excel: true, pdf: false },
          runMeta: { state: 'partial', run: {}, counts: {} },
          reportSettings: { defaultAudience: 'client' }
        };
        try {
          const payloadNode = document.getElementById('qa-report-data');
          const parsed = JSON.parse((payloadNode && payloadNode.textContent) || '{}');
          if (parsed && typeof parsed === 'object') {
            data = Object.assign(data, parsed);
          }
        } catch {
          // Keep resilient defaults.
        }
        const reportToken = (() => {
          try {
            return String(new URLSearchParams(window.location.search).get('t') || '').trim();
          } catch {
            return '';
          }
        })();
        const clientLabel = String(data.clientLabel || data.stats?.client || '').trim();
        if (clientLabel) {
          document.querySelectorAll('.pill').forEach((pill) => {
            if (!pill.textContent || !pill.textContent.startsWith('Client: ')) return;
            pill.textContent = 'Client: ' + clientLabel;
          });
        }

        function withReportToken(urlValue) {
          const href = String(urlValue || '').trim();
          if (!href || !reportToken) return href;
          if (href.startsWith('#')) return href;
          if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return href;

          if (/^https?:\\/\\//i.test(href)) {
            try {
              const parsed = new URL(href, window.location.href);
              const isReportHost = parsed.origin === window.location.origin;
              if (!isReportHost) {
                return href;
              }
              if (!parsed.searchParams.has('t')) {
                parsed.searchParams.set('t', reportToken);
              }
              return parsed.toString();
            } catch {
              return href;
            }
          }

          const hashIndex = href.indexOf('#');
          const hash = hashIndex >= 0 ? href.slice(hashIndex) : '';
          const withoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
          const queryIndex = withoutHash.indexOf('?');
          const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
          const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '';
          const params = new URLSearchParams(query);
          if (!params.has('t')) {
            params.set('t', reportToken);
          }
          return basePath + '?' + params.toString() + hash;
        }

        const issues = data.issues || [];
        const results = data.results || [];
        const stats = data.stats || {};
        const samplingMode = stats.sampling || 'unknown';
        const templateNames = stats.templateNames || {};
        const wpInsights = data.wpInsights || {};
        const reportSettings = data.reportSettings || { defaultAudience: 'client' };
        const rootStyle = document.documentElement && document.documentElement.style ? document.documentElement.style : null;
        const brandPrimaryColor = String(reportSettings.brandPrimaryColor || '').trim();
        const brandAccentColor = String(reportSettings.brandAccentColor || '').trim();
        if (rootStyle) {
          if (/^#[0-9a-fA-F]{3,6}$/.test(brandPrimaryColor)) {
            rootStyle.setProperty('--blue', brandPrimaryColor);
          }
          if (/^#[0-9a-fA-F]{3,6}$/.test(brandAccentColor)) {
            rootStyle.setProperty('--accent', brandAccentColor);
          }
        }
        const footerText = String(reportSettings.brandFooterText || '').trim();
        const footerNode = document.getElementById('reportFooter');
        if (footerNode && footerText) {
          footerNode.textContent = footerText;
          footerNode.style.display = 'block';
        }
        const audienceStorageKey = 'baseline-report-audience';
        function readStoredAudience() {
          try {
            return String(window.localStorage.getItem(audienceStorageKey) || '').toLowerCase();
          } catch {
            return '';
          }
        }
        function writeStoredAudience(value) {
          try {
            window.localStorage.setItem(audienceStorageKey, value);
          } catch {
            // best-effort only
          }
        }
        const storedAudience = readStoredAudience();
        let audience = storedAudience === 'developer' || storedAudience === 'client'
          ? storedAudience
          : (String(reportSettings.defaultAudience || 'client').toLowerCase() === 'developer' ? 'developer' : 'client');
        // Build a friendly template map from results (templateName field) as fallback.
        const derivedTemplateNames = {};
        results.forEach((r) => {
          if (r.templateKey && r.templateName) {
            derivedTemplateNames[r.templateKey] = r.templateName;
          }
        });

        // Aggregate WP context (plugins/themes/schema) from per-page hints.
        const pluginCounts = new Map();
        const themeCounts = new Map();
        const schemaCounts = new Map();
        const templateNameMap = new Map();
        results.forEach((r) => {
          const plugins = String(r.pluginHints || '').split(' | ').filter(Boolean);
          plugins.forEach((p) => pluginCounts.set(p, (pluginCounts.get(p) || 0) + 1));
          const themes = String(r.themeHints || '').split(' | ').filter(Boolean);
          themes.forEach((t) => themeCounts.set(t, (themeCounts.get(t) || 0) + 1));
          const schemas = String(r.schemaTypes || '').split(' | ').filter(Boolean);
          schemas.forEach((s) => schemaCounts.set(s, (schemaCounts.get(s) || 0) + 1));
          if (r.templateKey && r.templateName) {
            templateNameMap.set(r.templateKey, r.templateName);
          }
        });
        const pluginsDetected = Array.from(pluginCounts.entries()).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
        const themesDetected = Array.from(themeCounts.entries()).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
        const schemasDetected = Array.from(schemaCounts.entries()).sort((a,b)=>b[1]-a[1]).map(([k])=>k);

        function disableAnchorButton(btn, label) {
          if (!btn) return;
          btn.setAttribute('href', '#');
          btn.setAttribute('aria-disabled', 'true');
          btn.classList.add('disabled');
          if (label) {
            btn.textContent = label;
          }
          btn.removeAttribute('target');
          btn.removeAttribute('rel');
          btn.addEventListener('click', function(event) {
            event.preventDefault();
          });
        }

        function enableAnchorButton(btn, hrefValue, label, options) {
          if (!btn) return;
          const href = String(hrefValue || '').trim();
          if (!href) {
            disableAnchorButton(btn, label);
            return;
          }
          btn.setAttribute('href', withReportToken(href));
          btn.removeAttribute('aria-disabled');
          btn.classList.remove('disabled');
          if (label) {
            btn.textContent = label;
          }
          if (options && options.target) {
            btn.setAttribute('target', options.target);
          }
          if (options && options.rel) {
            btn.setAttribute('rel', options.rel);
          }
        }

        function asArray(value) {
          if (value instanceof Set) return Array.from(value);
          if (Array.isArray(value)) return value.slice();
          if (!value || typeof value !== 'object') return [];
          return Object.keys(value).filter((key) => Boolean(value[key]));
        }

        function groupHasUrl(group, urlValue) {
          if (!group || !urlValue) return false;
          const urls = group.urls;
          if (urls instanceof Set) return urls.has(urlValue);
          if (Array.isArray(urls)) return urls.indexOf(urlValue) >= 0;
          if (urls && typeof urls === 'object') return Boolean(urls[urlValue]);
          return false;
        }

        const firstLighthouse = results.find(r => r.lighthouseHtmlRel);
        function enableLighthouseButton(id) {
          const btn = document.getElementById(id);
          if (!btn) return;
          if (firstLighthouse && firstLighthouse.lighthouseHtmlRel) {
            enableAnchorButton(btn, firstLighthouse.lighthouseHtmlRel, 'Open Lighthouse', {
              target: '_blank',
              rel: 'noopener'
            });
          } else {
            disableAnchorButton(btn, 'No Lighthouse');
          }
        }
        enableLighthouseButton('lighthouseBtn');
        enableLighthouseButton('lighthouseBtnSticky');

        function syncAudienceButtons() {
          const label = audience === 'developer' ? 'Switch to Client View' : 'Switch to Developer View';
          [document.getElementById('audienceToggle'), document.getElementById('audienceToggleSticky')]
            .filter(Boolean)
            .forEach((btn) => {
              btn.textContent = label;
              btn.setAttribute('aria-pressed', audience === 'developer' ? 'true' : 'false');
              btn.setAttribute('data-audience-current', audience);
            });
          const headPill = document.getElementById('audienceHeadPill');
          if (headPill) {
            headPill.textContent = audience === 'developer' ? 'Mode: Developer Detail' : 'Mode: Client Summary';
          }
        }

        let audienceToastTimer = null;
        function showAudienceToast() {
          const toast = document.getElementById('audienceToast');
          if (!toast) return;
          toast.textContent =
            audience === 'developer'
              ? 'Developer Detail enabled: full technical diagnostics are visible.'
              : 'Client Summary enabled: concise, impact-first diagnostics are visible.';
          toast.classList.add('show');
          if (audienceToastTimer) window.clearTimeout(audienceToastTimer);
          audienceToastTimer = window.setTimeout(() => {
            toast.classList.remove('show');
          }, 1600);
        }

        function applyAudience() {
          document.body.setAttribute('data-audience', audience);
          writeStoredAudience(audience);
          syncAudienceButtons();
        }

        function toggleAudience() {
          audience = audience === 'client' ? 'developer' : 'client';
          applyAudience();
          render();
          showAudienceToast();
        }

        const audienceToggleButtons = [
          document.getElementById('audienceToggle'),
          document.getElementById('audienceToggleSticky')
        ].filter(Boolean);
        audienceToggleButtons.forEach((btn) => {
          btn.addEventListener('click', (event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            toggleAudience();
          });
        });
        document.addEventListener('click', (event) => {
          if (event.defaultPrevented) return;
          const trigger = event.target && event.target.closest
            ? event.target.closest('[data-audience-toggle="1"]')
            : null;
          if (!trigger) return;
          if (audienceToggleButtons.includes(trigger)) return;
          event.preventDefault();
          toggleAudience();
        });
        window.__baselineToggleAudience = toggleAudience;
        applyAudience();

        // Tabs controller
        const tabButtons = Array.from(document.querySelectorAll('.tabBtn'));
        function activateTab(tabId){
          tabButtons.forEach(btn => {
            const active = btn.dataset.tab === tabId;
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
          });
          Array.from(document.querySelectorAll('.tabContent')).forEach(node => {
            node.classList.toggle('active', node.id === 'tab-'+tabId);
          });
        }
        tabButtons.forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
        const rawInitialHash = window.location.hash.replace('#','');
        const initialTab = rawInitialHash === 'page-failures'
          ? 'pages'
          : ['overview','issues','pages','evidence','history'].includes(rawInitialHash)
          ? rawInitialHash
          : 'overview';
        activateTab(initialTab);
        const goToPageFailuresBtn = document.getElementById('goToPageFailuresBtn');
        if (goToPageFailuresBtn) {
          goToPageFailuresBtn.addEventListener('click', (event) => {
            event.preventDefault();
            activateTab('pages');
            const target = document.getElementById('page-failures');
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });
        }

        function el(tag, attrs, children){
          const node = document.createElement(tag);
          if (attrs) Object.entries(attrs).forEach(([k,v]) => {
            if (k === 'class') node.className = v;
            else if (k === 'html') node.textContent = String(v || '');
            else if (k === 'href') node.setAttribute(k, withReportToken(v));
            else if (k === 'src') node.setAttribute(k, withReportToken(v));
            else node.setAttribute(k, v);
          });
          (children || []).forEach(child => {
            if (child === null || child === undefined || child === false) return;
            if (typeof child === 'string' || typeof child === 'number') {
              node.appendChild(document.createTextNode(String(child)));
              return;
            }
            node.appendChild(child);
          });
          return node;
        }

        function issueToText(i){
          return [i.Title, i.Description, i.Element, i.URL].join(' ').toLowerCase();
        }

        function countBy(arr, keyFn){
          const m = new Map();
          arr.forEach(item => {
            const k = keyFn(item);
            m.set(k, (m.get(k) || 0) + 1);
          });
          return m;
        }

        const categoryOrder = ['All','Console','Accessibility','SEO','Structure','Forms','Performance'];
        const severityOrder = ['critical','major','minor','info'];
        const totalUniqueUrls = new Set(results.map(r => r.url)).size || 1;
        function humanTemplateName(key){
          if (!key) return 'Template';
          if (templateNames && templateNames[key]) return templateNames[key];
          if (derivedTemplateNames[key]) return derivedTemplateNames[key];
          if (templateNameMap.has(key)) return templateNameMap.get(key);
          const cleaned = key.replace(/^tpl[_-]/,'').replace(/[_-]+/g,' ');
          return cleaned.replace(/\b\w/g, c => c.toUpperCase());
        }

        function displayCategory(issue){
          const source = String(issue._source || '').toLowerCase();
          const group = String(issue.CategoryGroup || issue.Category || '').toLowerCase();
          if (source === 'console' || source === 'page' || source === 'pageerror') return 'Console';
          if (group === 'accessibility') return 'Accessibility';
          if (group === 'seo') return 'SEO';
          if (group === 'forms') return 'Forms';
          if (group === 'performance') return 'Performance';
          return 'Structure';
        }

        function groupKey(issue){
          if (issue.canonicalKey) return String(issue.canonicalKey).toLowerCase();
          const source = String(issue._source || '').toLowerCase();
          const title = String(issue.Title || '');
          const wcag = String(issue.WCAG || '');
          const category = displayCategory(issue);
          const severity = String(issue.Severity || '');
          const parts = [
            category,
            severity,
            title,
            wcag
          ];
          return parts.map(x => String(x || '').toLowerCase()).join('::');
        }

        // Build stable issue groups so "Affected pages" does not change when filtering.
        const groupsMap = new Map();
        const MAX_INSTANCES_PER_GROUP = 120;
        issues.forEach(i => {
          const key = groupKey(i);
          const entry = groupsMap.get(key) || {
            issue: i,
            urls: new Set(),
            elements: new Set(),
            instances: [],
            instanceKeys: new Set(),
            instanceOverflow: 0,
            screenshots: new Set()
          };
          if (i.URL) entry.urls.add(i.URL);
          if (i.Element) entry.elements.add(i.Element);
          if (i.screenshotRel) entry.screenshots.add(i.screenshotRel);
          const instanceKey = [i.URL || '', i.Element || '', i.Recommendation || ''].join('::');
          if (!entry.instanceKeys.has(instanceKey)) {
            entry.instanceKeys.add(instanceKey);
            if (entry.instances.length < MAX_INSTANCES_PER_GROUP) {
              entry.instances.push({
                url: i.URL || '',
                element: i.Element || '',
                recommendation: i.Recommendation || ''
              });
            } else {
              entry.instanceOverflow += 1;
            }
          }
          groupsMap.set(key, entry);
        });

        function collapseGlobal(groups){
          const locals = [];
          const globals = new Map();
          const makeKey = (g) => [
            String(g.issue.Severity || '').toLowerCase(),
            String(displayCategory(g.issue)).toLowerCase(),
            String(g.issue.Title || '').toLowerCase(),
            String(g.issue.WCAG || '').toLowerCase()
          ].join('::');

          groups.forEach((g) => {
            if (!g.isGlobal) {
              locals.push(g);
              return;
            }
            const key = makeKey(g);
            const existing = globals.get(key);
            if (existing) {
              asArray(g.urls).forEach((u) => existing.urls.add(u));
              g.elements.forEach((e) => existing.elements.add(e));
              (g.instances || []).forEach((inst) => {
                if (existing.instances.length < MAX_INSTANCES_PER_GROUP) {
                  existing.instances.push(inst);
                } else {
                  existing.instanceOverflow = (existing.instanceOverflow || 0) + 1;
                }
              });
              existing.instanceOverflow = (existing.instanceOverflow || 0) + Number(g.instanceOverflow || 0);
              (g.screenshots || []).forEach((scr) => existing.screenshots.add(scr));
              existing.impacted = existing.urls.size;
              existing.ratio = existing.impacted / totalUniqueUrls;
            } else {
              globals.set(key, {
                ...g,
                urls: new Set(asArray(g.urls)),
                elements: new Set(g.elements),
                instances: (g.instances || []).slice(),
                screenshots: new Set(g.screenshots || [])
              });
            }
          });
          return [...Array.from(globals.values()), ...locals];
        }

        const severityWeight = { critical: 4, major: 3, minor: 2, info: 1 };
        const baseGroups = Array.from(groupsMap.values()).map(g => ({
          ...g,
          impacted: g.urls.size,
          ratio: g.urls.size / totalUniqueUrls,
          isGlobal: (g.urls.size / totalUniqueUrls) >= 0.7,
          displayCategory: displayCategory(g.issue)
        }));

        const allGroups = collapseGlobal(baseGroups).sort((a,b) => {
          return (severityWeight[b.issue.Severity]||0) - (severityWeight[a.issue.Severity]||0) || b.impacted - a.impacted;
        });

        // Fallback: raw issues as 1:1 groups (used only if grouping fails).
        const rawGroups = issues.map(i => ({
          issue: i,
          urls: new Set(i.URL ? [i.URL] : []),
          elements: new Set(i.Element ? [i.Element] : []),
          impacted: i.URL ? 1 : 0,
          ratio: 0,
          isGlobal: false,
          displayCategory: displayCategory(i)
        }));

        let selectedCategory = 'All';
        let selectedSeverity = new Set(severityOrder);
        let query = '';

        function groupToText(g){
          const i = g.issue || {};
          const urls = asArray(g.urls).slice(0, 10).join(' ');
          return [i.Title, i.Description, i.Element, i.Recommendation, urls].join(' ').toLowerCase();
        }

        function aiPrioritization(group){
          const issue = group.issue || {};
          if (group.isGlobal) return 'Likely global/template issue: fix once, impacts ' + group.impacted + '/' + totalUniqueUrls + ' pages.';
          if (issue._source === 'console' && (issue.assetType === 'js' || issue.assetType === 'css')) {
            return 'Console asset failure can break interactivity (often header/theme enqueue, caching, or hardcoded paths).';
          }
          if ((issue.CategoryGroup || '') === 'Forms') return 'Form issues reduce conversions; validate plugin settings, required fields, and spam protections.';
          if ((issue.CategoryGroup || '') === 'Accessibility') return 'Accessibility issues affect compliance and usability for assistive tech users.';
          return 'Affects ' + group.impacted + '/' + totalUniqueUrls + ' pages - fix on the affected template/component and re-test.';
        }

        const issueHelp = {
          'Heading Level Skip': {
            why: 'Heading structure guides screen readers and improves scanability for all users.',
            where: 'Elementor: edit the widget heading level or section hierarchy.',
            fix: 'Ensure headings follow H1 -> H2 -> H3 without jumps.'
          },
          'H1 Count Issue': {
            why: 'Multiple H1s confuse document structure and dilute SEO focus.',
            where: 'Elementor/Theme header templates.',
            fix: 'Keep one primary H1 per page and demote others.'
          },
          'Missing Alt Text for Images': {
            why: 'Alt text is required for accessibility and improves context when images fail.',
            where: 'Media library or Elementor image widget.',
            fix: 'Add descriptive alt text for meaningful images.'
          },
          'Image Missing loading="lazy"': {
            why: 'Lazy-loading improves load speed by deferring off-screen images.',
            where: 'Elementor image widget or theme image settings.',
            fix: 'Add loading="lazy" to non-critical images.'
          },
          'External Link Missing target="_blank"': {
            why: 'External links can disrupt user flow when they replace your site.',
            where: 'Menu links, CTA buttons, or Elementor link settings.',
            fix: 'Add target="_blank" + rel="noopener" for external links.'
          },
          'Missing JSON-LD Structured Data': {
            why: 'Structured data improves how your content appears in search results.',
            where: 'SEO plugin or theme schema settings.',
            fix: 'Add Organization/WebPage/Article schema in JSON-LD.'
          },
          'Viewport Meta Missing or Invalid': {
            why: 'Incorrect viewport settings break responsive layouts and mobile UX.',
            where: 'Theme header or SEO plugin.',
            fix: 'Use: <meta name="viewport" content="width=device-width, initial-scale=1">'
          },
          'Horizontal Overflow Detected': {
            why: 'Overflow causes horizontal scrolling and layout instability.',
            where: 'Elementor sections or containers with fixed widths.',
            fix: 'Check container widths, padding, and overflow settings.'
          },
          'Cookie/Modal Blocking Content': {
            why: 'Blocked content prevents QA and real users from interacting with the page.',
            where: 'Cookie banner or modal plugin settings.',
            fix: 'Ensure banners are dismissible and do not cover core content.'
          },
          'Fixed-width Sections Detected': {
            why: 'Fixed widths cause layouts to break at common breakpoints.',
            where: 'Elementor section width / container settings.',
            fix: 'Use responsive widths or max-width with auto margins.'
          },
          'Containers Wider Than Viewport': {
            why: 'Over-wide containers create horizontal scroll and layout instability.',
            where: 'Elementor containers or custom CSS.',
            fix: 'Remove fixed widths and ensure max-width respects the viewport.'
          },
          'Full-width Sections Missing Padding': {
            why: 'Lack of padding makes content collide with viewport edges, reducing readability.',
            where: 'Elementor section padding settings.',
            fix: 'Add horizontal padding to full-width sections.'
          }
        };

        function issueDetailsForCopy(issue){
          return [
            'Category: ' + (issue.CategoryGroup || issue.Category),
            'Severity: ' + (issue.Severity || ''),
            'Title: ' + (issue.Title || ''),
            'What\\'s broken: ' + (issue.Description || ''),
            'Affected element: ' + (issue.Element || ''),
            issue.WCAG ? ('WCAG: ' + issue.WCAG) : '',
            'How to fix: ' + (issue.Recommendation || ''),
            'Example URL: ' + (issue.URL || '')
          ].filter(Boolean).join('\\n');
        }

        function renderKpis(){
          const wrap = document.getElementById('kpiRow');
          if (!wrap) return;
          wrap.innerHTML = '';

          // Worst status per URL.
          const byUrl = new Map();
          results.forEach(r => {
            const current = byUrl.get(r.url) || 'PASS';
            const next = String(r.status || 'PASS');
            const rank = { PASS: 1, FAIL: 2, BLOCKED: 3, ERROR: 3 };
            const worst = (rank[next] || 1) > (rank[current] || 1) ? next : current;
            byUrl.set(r.url, worst);
          });
          const failedUrls = Array.from(byUrl.values()).filter(s => s === 'FAIL').length;
          const errorUrls = Array.from(byUrl.values()).filter(s => s === 'ERROR').length;
          const blockedUrls = Array.from(byUrl.values()).filter(s => s === 'BLOCKED').length;
          const pagesWithIssues = failedUrls + errorUrls; // BLOCKED is informative but not “issue” by default.
          const pagesTested = byUrl.size || 0;
          const globalIssues = allGroups.filter(g => g.isGlobal).length;
          const browsersWithFailures = new Set(results.filter(r => r.status === 'FAIL').map(r => r.browser || '')).size;

          function kpi(sev, label, value, icon){
            const node = el('div', { class:'kpi', 'data-sev': sev }, [
              el('div', { class:'left' }, [
                el('div', { class:'icon' }, [document.createTextNode(icon || '!')]),
                el('div', null, [
                  el('div', { class:'value' }, [document.createTextNode(String(value))]),
                  el('div', { class:'label' }, [document.createTextNode(label)])
                ])
              ])
            ]);
            return node;
          }

          wrap.appendChild(kpi('minor', 'Pages Scanned', pagesTested, 'DOC'));
      wrap.appendChild(kpi(pagesWithIssues > 0 ? 'major' : 'pass', 'Pages With Issues', pagesWithIssues, '!'));
      wrap.appendChild(kpi('major', 'Global Issues', globalIssues, 'G'));
      wrap.appendChild(kpi('pass', 'Browsers With Failures', browsersWithFailures, 'PC'));

      const lhNote = document.getElementById('lhNote');
          if (lhNote) {
            const lighthouseRan = results.some((r) => r.lighthouseHtmlRel);
            const quick = data.runMeta && data.runMeta.run && data.runMeta.run.quick;
            lhNote.textContent = lighthouseRan
              ? 'Lighthouse: available (sampled templates).'
              : quick
              ? 'Lighthouse: skipped in quick mode.'
              : 'Lighthouse: not generated for this run.';
          }
        }

        function renderFixPriority(){
          const wrap = document.getElementById('fixPriority');
          if (!wrap) return;
          const fp = data.fixPriority || { issueCount: 0, resolvedPercent: 0, issues: [] };
          wrap.innerHTML = '';

          const header = el('div', { class:'panelTitle' }, [
            el('h2', null, [document.createTextNode('Priority Fix Engine')])
          ]);
          wrap.appendChild(header);

          const summaryLine = fp.issueCount
            ? ('Fix these ' + fp.issueCount + ' global issues and ~' + fp.resolvedPercent + '% of page failures will be resolved.')
            : 'No global issues detected yet.';
          wrap.appendChild(el('div', { class:'muted' }, [document.createTextNode(summaryLine)]));

          const list = el('div', { class:'insightList' }, []);
          fp.issues.forEach((entry) => {
            const sev = entry.severity || 'info';
            list.appendChild(el('div', { class:'insightItem' }, [
              el('div', null, [
                el('div', { style:'font-weight:600' }, [document.createTextNode(entry.issue.Title || 'Issue')]),
                el('div', { class:'muted' }, [document.createTextNode(entry.impacted + ' pages affected')])
              ]),
              el('span', { class:'tag ' + sev }, [document.createTextNode(sev)])
            ]));
          });
          if (!fp.issues.length) {
            list.appendChild(el('div', { class:'insightItem' }, [
              el('div', { class:'muted' }, [document.createTextNode('No repeat/global issues found.')])
            ]));
          }
          wrap.appendChild(list);
        }

        function renderTemplateInsight(){
          const wrap = document.getElementById('templateInsight');
          if (!wrap) return;
          wrap.innerHTML = '';

          const header = el('div', { class:'panelTitle' }, [
            el('h2', null, [document.createTextNode('Template Mapping')])
          ]);
          wrap.appendChild(header);

          const samplingNote = el('div', { class:'muted' }, [
            document.createTextNode(
              samplingMode === 'rest'
                ? 'Sampling: REST template sampling (1 per type). Use --no-rest to force full sitemap.'
                : 'Sampling: Sitemap/URL list.'
            )
          ]);
          wrap.appendChild(samplingNote);

          const byUrl = new Map();
          results.forEach(r => {
            if (!byUrl.has(r.url)) byUrl.set(r.url, r);
          });

          const templateCounts = new Map();
          const templateSamples = new Map();
          const templateFriendly = new Map();
          byUrl.forEach((row) => {
            const key = row.templateKey || '';
            if (!key) return;
            templateCounts.set(key, (templateCounts.get(key) || 0) + 1);
            if (!templateSamples.has(key)) {
              templateSamples.set(key, row.url || '');
              // Build a human-ish label from the sample URL path.
              if (row.url) {
                try {
                  const u = new URL(row.url);
                  const pathPart = u.pathname.replace(/^\\//, '').replace(/\\/$/, '');
                  const slug = pathPart || u.hostname;
                  templateFriendly.set(key, slug || row.url);
                } catch {
                  templateFriendly.set(key, row.url);
                }
              }
            }
          });

          const sorted = Array.from(templateCounts.entries()).sort((a,b) => b[1] - a[1]);
          if (sorted.length === 0) {
            wrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('Template signatures unavailable for this run.')]));
            return;
          }

          const failedUrls = Array.from(byUrl.values()).filter(row => row.status === 'FAIL');
          const failedTemplateCounts = new Map();
          failedUrls.forEach((row) => {
            const key = row.templateKey || '';
            if (!key) return;
            failedTemplateCounts.set(key, (failedTemplateCounts.get(key) || 0) + 1);
          });

          const failedSorted = Array.from(failedTemplateCounts.entries()).sort((a,b) => b[1] - a[1]);
          let templateLine = '';
          if (failedSorted.length === 1 && failedUrls.length > 0) {
            templateLine = 'All failures originate from a single template.';
          } else {
            const [topKey, topCount] = sorted[0];
            templateLine = topCount + ' pages share the same template signature.';
          }
          wrap.appendChild(el('div', { class:'muted' }, [document.createTextNode(templateLine)]));
          if (wpInsights.elementorDetected) {
            wrap.appendChild(el('div', { class:'muted', style:'margin-top:4px' }, [document.createTextNode('Detected: Elementor layouts present (template signatures captured).')]));
          }
          wrap.appendChild(el('div', { class:'muted', style:'margin-top:6px' }, [
            document.createTextNode(samplingMode === 'rest'
              ? 'Sampling: REST template sampling (1 per type). Use --no-rest to force full sitemap.'
              : 'Sampling: Sitemap/URL list.')
          ]));

          if (pluginsDetected.length || themesDetected.length || schemasDetected.length) {
            const metaRow = el('div', { class:'muted', style:'margin-top:8px; display:flex; flex-wrap:wrap; gap:8px' });
            if (pluginsDetected.length) metaRow.appendChild(el('span', { class:'badge' }, [document.createTextNode('Plugins: ' + pluginsDetected.slice(0,3).join(', '))]));
            if (themesDetected.length) metaRow.appendChild(el('span', { class:'badge' }, [document.createTextNode('Theme: ' + themesDetected[0])]));
            if (schemasDetected.length) metaRow.appendChild(el('span', { class:'badge' }, [document.createTextNode('Schema: ' + schemasDetected.slice(0,3).join(', '))]));
            wrap.appendChild(metaRow);
          }

          const lighthouseIssues = results.some(r => {
            const perf = Number(r.lighthousePerformance || 0);
            const seo = Number(r.lighthouseSEO || 0);
            const bp = Number(r.lighthouseBestPractices || 0);
            const acc = Number(r.lighthouseAccessibility || 0);
            return (perf > 0 && perf < 90) || (seo > 0 && seo < 90) || (bp > 0 && bp < 90) || (acc > 0 && acc < 90);
          });
          if (lighthouseIssues) {
            wrap.appendChild(el('div', { class:'muted', style:'margin-top:6px' }, [
              document.createTextNode('Lighthouse template issues detected.')
            ]));
          }

          const list = el('div', { class:'insightList' }, []);
          sorted.slice(0, 3).forEach(([key, count]) => {
            const sampleUrl = templateSamples.get(key) || '';
            let samplePath = '';
            if (sampleUrl) {
              try {
                const u = new URL(sampleUrl);
                const p = u.pathname || '';
                samplePath = p.startsWith('/') ? p.slice(1) : p;
              } catch {
                samplePath = sampleUrl;
              }
            }
            const friendly = templateNames[key] || templateFriendly.get(key) || samplePath || humanTemplateName(key);
            list.appendChild(el('div', { class:'insightItem' }, [
              el('div', null, [
                el('div', { style:'font-weight:600' }, [document.createTextNode(friendly)]),
                el('div', { class:'muted' }, [document.createTextNode(count + ' pages' + (samplePath ? ' • e.g. /' + samplePath : ''))])
              ])
            ]));
          });
          wrap.appendChild(list);
        }

        function renderChangeSummary(){
          const wrap = document.getElementById('changeSummary');
          if (!wrap) return;
          const change = data.changeSummary || { newCount: 0, resolvedCount: 0, newTop: [], resolvedTop: [], prevGeneratedAt: '' };
          wrap.innerHTML = '';

          const header = el('div', { class:'panelTitle' }, [
            el('h2', null, [document.createTextNode('What Changed Since Last Run')])
          ]);
          wrap.appendChild(header);

          if (!change.prevGeneratedAt) {
            wrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('No previous run found for comparison.')]));
            return;
          }

          wrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('Compared to: ' + change.prevGeneratedAt)]));
          wrap.appendChild(el('div', { style:'margin-top:6px;font-weight:600' }, [
            document.createTextNode('New issues: ' + change.newCount + ' / Resolved: ' + change.resolvedCount)
          ]));

          const list = el('div', { class:'insightList' }, []);
          change.newTop.forEach((entry) => {
            list.appendChild(el('div', { class:'insightItem' }, [
              el('div', null, [
                el('div', { style:'font-weight:600' }, [document.createTextNode(entry.issue.Title || 'Issue')]),
                el('div', { class:'muted' }, [document.createTextNode('New')])
              ])
            ]));
          });
          if (!change.newTop.length) {
            list.appendChild(el('div', { class:'insightItem' }, [
              el('div', { class:'muted' }, [document.createTextNode('No new issues detected.')])
            ]));
          }
          wrap.appendChild(list);

          const resolvedList = el('div', { class:'insightList', style:'margin-top:8px' }, []);
          change.resolvedTop.forEach((entry) => {
            resolvedList.appendChild(el('div', { class:'insightItem' }, [
              el('div', null, [
                el('div', { style:'font-weight:600' }, [document.createTextNode(entry.issue.Title || 'Issue')]),
                el('div', { class:'muted' }, [document.createTextNode('Resolved')])
              ])
            ]));
          });
          if (!change.resolvedTop.length) {
            resolvedList.appendChild(el('div', { class:'insightItem' }, [
              el('div', { class:'muted' }, [document.createTextNode('No resolved issues detected.')])
            ]));
          }
          wrap.appendChild(resolvedList);
        }

        function renderHistory(){
          const wrap = document.getElementById('historyPane');
          if (!wrap) return;
          const change = data.changeSummary || { newCount: 0, resolvedCount: 0, newTop: [], resolvedTop: [], prevGeneratedAt: '' };
          wrap.innerHTML = '';

          const header = el('div', { class:'panelTitle' }, [
            el('h2', null, [document.createTextNode('What Changed Since Last Run')])
          ]);
          wrap.appendChild(header);

          if (!change.prevGeneratedAt) {
            wrap.appendChild(el('div', { class:'panel' }, [
              el('div', { class:'muted' }, [document.createTextNode('No previous complete run available for this client. Run again to see deltas.')])
            ]));
            return;
          }

          wrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('Compared to: ' + change.prevGeneratedAt)]));
          wrap.appendChild(el('div', { style:'margin-top:6px;font-weight:600' }, [
            document.createTextNode('New issues: ' + change.newCount + ' / Resolved: ' + change.resolvedCount)
          ]));

          const makeList = (title, entries, emptyText) => {
            const box = el('div', { class:'panel', style:'margin-top:10px' }, [
              el('div', { class:'panelTitle' }, [el('h2', null, [document.createTextNode(title)])])
            ]);
            const list = el('div', { class:'insightList' }, []);
            if (!entries || !entries.length) {
              list.appendChild(el('div', { class:'insightItem' }, [
                el('div', { class:'muted' }, [document.createTextNode(emptyText)])
              ]));
            } else {
              entries.forEach((entry) => {
                list.appendChild(el('div', { class:'insightItem' }, [
                  el('div', null, [
                    el('div', { style:'font-weight:600' }, [document.createTextNode(entry.issue.Title || 'Issue')]),
                    el('div', { class:'muted' }, [document.createTextNode(title)])
                  ])
                ]));
              });
            }
            box.appendChild(list);
            return box;
          };

          wrap.appendChild(makeList('New issues', change.newTop, 'No new issues detected.'));
          wrap.appendChild(makeList('Resolved issues', change.resolvedTop, 'No resolved issues detected.'));
        }

        function renderCategorySummary(){
          const wrap = document.getElementById('categorySummary');
          if (!wrap) return;
          wrap.innerHTML = '';

          const descriptions = {
            Console: 'JS/runtime errors and blocked resources.',
            Structure: 'Layout, headings, templates, structural checks.',
            SEO: 'Meta tags, schema, indexability signals.',
            Accessibility: 'WCAG issues from automated checks.'
          };

          function maxSeverityFor(cat){
            const order = { critical:4, major:3, minor:2, info:1 };
            const relevant = allGroups.filter(g => g.displayCategory === cat);
            if (!relevant.length) return 'info';
            return relevant.sort((a,b) => (order[b.issue.Severity]||0) - (order[a.issue.Severity]||0))[0].issue.Severity;
          }

          ['Console','Structure','SEO','Accessibility'].forEach(cat => {
            const count = allGroups.filter(g => g.displayCategory === cat).length;
            const sev = maxSeverityFor(cat);
            const card = el('div', { class:'categoryCard', 'data-sev': sev }, [
              el('div', { class:'title' }, [document.createTextNode(cat)]),
              el('div', { class:'count' }, [document.createTextNode(String(count))]),
              el('div', { class:'desc' }, [document.createTextNode(descriptions[cat] || '')]),
              el('div', { class:'link' }, [document.createTextNode('View issues ->')])
            ]);
            card.addEventListener('click', () => {
              selectedCategory = cat;
              render();
              document.getElementById('cards')?.scrollIntoView({ behavior:'smooth', block:'start' });
            });
            wrap.appendChild(card);
          });
        }

        function renderChecklistSummary(){
          const wrap = document.getElementById('checklistSummary');
          if (!wrap) return;

          // Per-URL worst status (PASS/FAIL/BLOCKED/ERROR).
          const byUrl = new Map();
          results.forEach(r => {
            const current = byUrl.get(r.url) || 'PASS';
            const next = String(r.status || 'PASS');
            const rank = { PASS: 1, FAIL: 2, BLOCKED: 3, ERROR: 3 };
            const worst = (rank[next] || 1) > (rank[current] || 1) ? next : current;
            byUrl.set(r.url, worst);
          });
          const urlCount = byUrl.size || 1;

          const rows = Array.from(byUrl.keys()).map(url => {
            // pick first run row for metrics display; we only need a representative.
            const any = results.find(r => r.url === url) || {};
            return any;
          });

          const sum = (field) => rows.reduce((acc, r) => acc + Number(r[field] || 0), 0);
          const anyIssue = (predicate) => rows.some(predicate);

          const checks = [
            {
              title: 'Page loads (env health)',
              badge: (() => {
                const blocked = Array.from(byUrl.values()).filter(s => s === 'BLOCKED' || s === 'ERROR').length;
                if (blocked === 0) return { text: 'OK', cls: 'ok' };
                return { text: blocked + ' blocked', cls: 'bad' };
              })(),
              meta: 'We attempted to load every URL and recorded HTTP/load timing.'
            },
            {
              title: 'Console + runtime errors',
              badge: (() => {
                const count = sum('consoleErrors') + sum('pageErrors');
                if (count === 0) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Captured console errors and uncaught exceptions.'
            },
            {
              title: 'Broken links',
              badge: (() => {
                const count = sum('brokenLinks');
                if (count === 0) return { text: 'OK', cls: 'ok' };
                return { text: count + ' found', cls: 'warn' };
              })(),
              meta: 'Checked all anchors and flagged HTTP >= 400.'
            },
            {
              title: 'Headings (H1) + structure',
              badge: (() => {
                const bad = rows.filter(r => Number(r.h1Count || 0) !== 1).length;
                if (bad === 0) return { text: 'OK', cls: 'ok' };
                return { text: bad + ' pages', cls: 'warn' };
              })(),
              meta: 'Verified one H1 per page and checked heading level skips.'
            },
            {
              title: 'Images (alt, broken, lazy)',
              badge: (() => {
                const bad = sum('missingAlt') + sum('brokenImages') + sum('imagesMissingLazy');
                if (bad === 0) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Checked alt text, broken image URLs, and lazy-loading.'
            },
            {
              title: 'SEO basics (title/description/JSON-LD)',
              badge: (() => {
                const missingTitle = rows.filter(r => !String(r.metaTitle || '').trim()).length;
                const missingDesc = rows.filter(r => String(r.metaDescriptionPresent || '').toLowerCase() !== 'true').length;
                const missingSchema = rows.filter(r => String(r.jsonLdPresent || '').toLowerCase() !== 'true').length;
                const totalMissing = missingTitle + missingDesc + missingSchema;
                if (totalMissing === 0) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Checked <title>, meta description, and JSON-LD presence.'
            },
            {
              title: 'Forms',
              badge: (() => {
                const total = sum('formsTotal');
                if (total === 0) return { text: 'None found', cls: 'ok' };
                const failed = sum('formsFailed');
                if (failed === 0) return { text: 'OK', cls: 'ok' };
                return { text: failed + ' failed', cls: 'warn' };
              })(),
              meta: 'Detected forms, filled fields, and (optionally) submitted with success/error detection.'
            },
            {
              title: 'Accessibility (axe)',
              badge: (() => {
                const total = sum('axeViolations');
                if (total === 0) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Ran axe-core checks (reported even if not failing the run).'
            },
            {
              title: 'Performance/quality (Lighthouse sample)',
              badge: (() => {
                const ran = rows.filter(r => String(r.lighthousePerformance || '').trim() !== '').length;
                if (ran === 0) return { text: 'Not run', cls: 'ok' };
                const anyLow = rows.some(r => Number(r.lighthousePerformance || 0) > 0 && Number(r.lighthousePerformance || 0) < 60);
                if (!anyLow) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Ran Lighthouse on sampled templates (homepage/services/blog/contact).'
            },
            {
              title: 'Layout integrity (overflow/fixed width)',
              badge: (() => {
                const layoutIssues = issues.filter(i => String(i._source || '').toLowerCase() === 'layout').length;
                if (layoutIssues === 0) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Checked for overflow, fixed-width sections, and missing padding.'
            },
            {
              title: 'Modal/cookie blocking',
              badge: (() => {
                const blocked = issues.some(i => i.Title === 'Cookie/Modal Blocking Content');
                if (!blocked) return { text: 'OK', cls: 'ok' };
                return { text: 'Issues found', cls: 'warn' };
              })(),
              meta: 'Detects fixed modals/banners covering most content.'
            }
          ];

          wrap.innerHTML = '<div class=\"sectionTitle\">QA Checklist (coverage)</div>';
          const grid = el('div', { class:'checkGrid' });
          checks.forEach(c => {
            const item = el('div', { class:'checkItem' }, [
              el('div', null, [
                el('strong', null, [document.createTextNode(c.title)]),
                el('div', { class:'meta' }, [document.createTextNode(c.meta)])
              ]),
              el('span', { class:'checkBadge ' + (c.badge.cls || '') }, [document.createTextNode(c.badge.text)])
            ]);
            grid.appendChild(item);
          });
          wrap.appendChild(grid);
        }

        function renderRunStateBanner(){
          const wrap = document.getElementById('runStateBanner');
          if (!wrap) return;

          const meta = data.runMeta || {};
          const stateRaw = String(meta.state || 'partial').toLowerCase();
          const state = ['complete', 'partial', 'interrupted', 'merge_failed'].includes(stateRaw)
            ? stateRaw
            : 'partial';

          const textByState = {
            complete: {
              title: 'Run complete: report totals are final.',
              detail: 'All merged artifacts were produced successfully.'
            },
            partial: {
              title: 'Run partial: report may be incomplete.',
              detail: 'Some URLs or worker shards may not have finished before report generation.'
            },
            interrupted: {
              title: 'Run interrupted: report includes partial results.',
              detail: 'The run was interrupted before full completion.'
            },
            merge_failed: {
              title: 'Merge failed: report may not reflect all shards.',
              detail: 'Canonical merge failed. Review run metadata and rerun if accuracy is required.'
            }
          };

          const counts = meta.counts || {};
          const run = meta.run || {};
          const details = [];
          if (Number.isFinite(Number(counts.uniqueUrls)) || Number.isFinite(Number(counts.inputUrls))) {
            details.push('URLs: ' + Number(counts.uniqueUrls || 0) + ' merged of ' + Number(counts.inputUrls || 0) + ' input');
          }
          if (Array.isArray(run.projects) && run.projects.length) {
            details.push('Projects: ' + run.projects.length);
          }
          if (run.workers !== null && run.workers !== undefined && run.workers !== '') {
            details.push('Workers: ' + run.workers);
          }
          if (run.interrupted) {
            details.push('Interrupted: yes');
          }
          const lighthouseRan = results.some((r) => r.lighthouseHtmlRel);
          if (run.quick && !lighthouseRan) {
            details.push('Lighthouse skipped (quick mode)');
          } else if (!lighthouseRan) {
            details.push('Lighthouse not generated');
          }

          wrap.className = 'runStateBanner state-' + state;
          wrap.innerHTML = '';
          wrap.appendChild(el('strong', null, [document.createTextNode(textByState[state].title)]));
          wrap.appendChild(el('div', { class:'meta' }, [document.createTextNode(textByState[state].detail)]));
          if (details.length) {
            wrap.appendChild(el('div', { class:'meta' }, [document.createTextNode(details.join(' | '))]));
          }
        }

        function computeCounts(){
          const globalOnly = document.getElementById('globalOnly')?.checked;
          const q = query;
          const base = allGroups.filter(g => {
            if (globalOnly && !g.isGlobal) return false;
            if (q && !groupToText(g).includes(q)) return false;
            return true;
          });

          const categoryCounts = new Map();
          categoryCounts.set('All', base.length);
          categoryOrder.forEach(c => { if (c !== 'All') categoryCounts.set(c, 0); });
          base.forEach(g => {
            const cat = g.displayCategory || 'Structure';
            categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
          });

          const severityCounts = new Map();
          severityOrder.forEach(s => severityCounts.set(s, 0));
          base.forEach(g => {
            const sev = g.issue.Severity || 'info';
            severityCounts.set(sev, (severityCounts.get(sev) || 0) + 1);
          });

          return { categoryCounts, severityCounts };
        }

        function renderChips(){
          const { categoryCounts, severityCounts } = computeCounts();

          const catWrap = document.getElementById('categoryChips');
          catWrap.innerHTML = '';
          categoryOrder.forEach(name => {
            const count = categoryCounts.get(name) || 0;
            const chip = el('div', { class:'chip', 'data-on': selectedCategory === name ? '1':'0', 'data-kind': 'category' }, [
              document.createTextNode(name),
              el('span', { class:'count' }, [document.createTextNode(String(count))])
            ]);
            chip.addEventListener('click', () => { selectedCategory = name; render(); });
            catWrap.appendChild(chip);
          });

          const sevWrap = document.getElementById('severityChips');
          sevWrap.innerHTML = '';
          severityOrder.forEach(name => {
            const count = severityCounts.get(name) || 0;
            const on = selectedSeverity.has(name);
            const label = name.charAt(0).toUpperCase() + name.slice(1);
            const chip = el('div', { class:'chip', 'data-on': on ? '1':'0', 'data-kind':'severity', 'data-sev': name }, [
              document.createTextNode(label),
              el('span', { class:'count' }, [document.createTextNode(String(count))])
            ]);
            chip.addEventListener('click', () => {
              if (selectedSeverity.has(name)) selectedSeverity.delete(name);
              else selectedSeverity.add(name);
              render();
            });
            sevWrap.appendChild(chip);
          });
        }

        function renderPagesTable(){
          const wrap = document.getElementById('pagesTable');
          const rows = results.slice().sort((a,b) => {
            const rank = { FAIL: 1, BLOCKED: 2, ERROR: 3, PASS: 4 };
            return (rank[a.status] || 9) - (rank[b.status] || 9);
          });
          wrap.innerHTML = '';

          const reasonLabels = {
            'console errors': 'Critical console error',
            'page errors': 'Runtime error',
            'broken links': 'Broken links found',
            'h1 count': 'H1 count incorrect',
            'missing alt': 'Missing alt text',
            'heading skip': 'Heading level skip',
            'form validation': 'Form validation failed',
            'axe violations': 'Accessibility violations',
            'lighthouse performance': 'Lighthouse performance below target',
            'lighthouse seo': 'Lighthouse SEO below target',
            'lighthouse best practices': 'Lighthouse best practices below target',
            'lighthouse accessibility': 'Lighthouse accessibility below target',
            '1272 overflow': 'Horizontal overflow at 1272px'
          };

          const formatReasons = (row) => {
            if (row.status === 'BLOCKED') return [row.blockedReason || 'Blocked by environment'];
            if (row.status === 'ERROR') return [row.error || 'Run error'];
            const raw = String(row.failReasons || '').split('|').map(r => r.trim()).filter(Boolean);
            if (!raw.length && row.status === 'PASS') return ['Passed required checks'];
            return raw.map(r => {
              if (r === '1272 overflow' && (row.desktopOverflowCause || row.desktopOverflowSample)) {
                const detail = row.desktopOverflowCause || row.desktopOverflowSample || '';
                const base = reasonLabels[r] || r;
                return detail ? base + ' • ' + detail : base;
              }
              return reasonLabels[r] || r;
            });
          };

          rows.forEach(r => {
            const reasons = formatReasons(r);
            const evidence = [];
            if (r.screenshotRel) evidence.push(el('a', { class:'btn', href:r.screenshotRel, target:'_blank', rel:'noopener' }, ['Screenshot']));
            if (r.lighthouseHtmlRel) evidence.push(el('a', { class:'btn', href:r.lighthouseHtmlRel, target:'_blank', rel:'noopener' }, ['Lighthouse']));
            const evidenceBadges = [];
            if (r.screenshotRel) evidenceBadges.push(el('span', { class:'badge' }, [document.createTextNode('Screenshot')]));
            if (r.lighthouseHtmlRel) evidenceBadges.push(el('span', { class:'badge' }, [document.createTextNode('Lighthouse')]));

            const card = el('div', { class:'pageCard' }, [
              el('div', null, [
                el('div', { style:'font-weight:600' }, [
                  el('a', { href: r.url, target:'_blank', rel:'noopener' }, [document.createTextNode(r.url)])
                ]),
                el('div', { class:'meta' }, [document.createTextNode((r.browser || '') + ' / ' + (r.viewport || ''))]),
                evidenceBadges.length ? el('div', { class:'badges', style:'margin-top:6px' }, evidenceBadges) : null,
                el('ul', { class:'pageReasons' }, reasons.map(reason => el('li', null, [document.createTextNode(reason)])))
              ]),
              el('div', null, [
                el('div', { class:'status status-'+(r.status||'') }, [document.createTextNode(r.status || '')]),
                el('div', { class:'pageActions', style:'margin-top:10px' }, evidence.length ? evidence : [el('span', { class:'muted' }, ['-'])])
              ])
            ]);
            wrap.appendChild(card);
          });
        }

        function renderEvidence(){
          const shotsWrap = document.getElementById('evidenceShots');
          const lhWrap = document.getElementById('evidenceLh');
          const meta = document.getElementById('evidenceMeta');
          const blockedWrap = document.getElementById('blockedSamples');
          if (!shotsWrap || !lhWrap || !meta || !blockedWrap) return;

          shotsWrap.innerHTML = '';
          lhWrap.innerHTML = '';
          blockedWrap.innerHTML = '';

          const screenshotSet = new Set();
          issues.forEach((i) => { if (i.screenshotRel) screenshotSet.add(i.screenshotRel); });
          results.forEach((r) => { if (r.screenshotRel) screenshotSet.add(r.screenshotRel); });
          const screenshots = Array.from(screenshotSet);

          meta.textContent = screenshots.length
            ? (screenshots.length + ' screenshots captured across run.')
            : 'No screenshots captured in this run.';

          if (!screenshots.length) {
            shotsWrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('No screenshots available.')]));
          } else {
            screenshots.forEach((src) => {
              shotsWrap.appendChild(el('div', { class:'evidenceCard' }, [
                el('img', { src, alt:'Issue screenshot', loading:'lazy' }),
                el('a', { class:'btn', href: src, target:'_blank', rel:'noopener' }, [document.createTextNode('Open')])
              ]));
            });
          }

          const lhRows = results.filter(r => r.lighthouseHtmlRel);
          if (!lhRows.length) {
            lhWrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('No Lighthouse reports in this run.')]));
          } else {
            lhRows.forEach((r) => {
              lhWrap.appendChild(el('div', { class:'lhItem' }, [
                el('div', null, [
                  el('div', { style:'font-weight:600' }, [document.createTextNode(r.url || 'Lighthouse report')]),
                  el('div', { class:'muted' }, [document.createTextNode((r.browser || '') + ' / ' + (r.viewport || ''))])
                ]),
                el('a', { class:'btn', href: r.lighthouseHtmlRel, target:'_blank', rel:'noopener' }, [document.createTextNode('Open')])
              ]));
            });
          }

          blockedWrap.appendChild(el('div', { class:'muted' }, [document.createTextNode('No blocked samples captured in this run.')]));
        }

        function buildIssueCard(g, cardIndex) {
          const i = g.issue;
          const sev = i.Severity || 'info';
          const isClientAudience = audience === 'client';
          const isFormIssue = String(i._source || '').toLowerCase() === 'forms';
          const impactLabel = g.isGlobal
            ? 'Impact: High'
            : g.impacted >= Math.max(2, Math.ceil(totalUniqueUrls * 0.3))
            ? 'Impact: Medium'
            : 'Impact: Low';
          const card = el('details', {
            class: 'card ' + (isClientAudience ? 'card-client' : 'card-developer'),
            'data-sev': sev
          });
          if (!isClientAudience && cardIndex < 3) {
            card.setAttribute('open', 'open');
          }

          const hasLighthouseForGroup = results.some((r) => groupHasUrl(g, r.url) && r.lighthouseHtmlRel);
          const badgeNodes = [
            el('span', { class:'badge sev-'+sev }, [document.createTextNode(sev)]),
            el('span', { class:'badge' }, [document.createTextNode(g.displayCategory || i.CategoryGroup || i.Category || 'Structure')]),
            el('span', { class:'badge' }, [document.createTextNode(impactLabel)]),
            el('span', { class:'badge' }, [document.createTextNode('Affected pages: ' + g.impacted)]),
            g.isGlobal ? el('span', { class:'badge' }, [document.createTextNode('Global')]) : null,
            i.WCAG ? el('span', { class:'badge' }, [document.createTextNode(i.WCAG)]) : null,
            (g.screenshots && g.screenshots.size > 0)
              ? el('span', { class:'badge' }, [document.createTextNode('Screenshot')])
              : null,
            hasLighthouseForGroup ? el('span', { class:'badge' }, [document.createTextNode('Lighthouse')]) : null
          ];
          if (!isClientAudience) {
            badgeNodes.push(
              el('span', { class:'badge' }, [document.createTextNode('Instances: ' + (g.instances ? g.instances.length : 0))]),
              i.actionability ? el('span', { class:'badge' }, [document.createTextNode('Actionability: ' + i.actionability)]) : null,
              i.ownership ? el('span', { class:'badge' }, [document.createTextNode('Ownership: ' + i.ownership)]) : null,
              i.journeyScope ? el('span', { class:'badge' }, [document.createTextNode('Scope: ' + i.journeyScope)]) : null
            );
          }
          const badges = el('div', { class:'badges' }, badgeNodes.filter(Boolean));

          const summary = el('summary', { class:'cardSummary' }, [
            el('span', { class:'sevRail' }),
            el('div', { class:'cardMain' }, [
              el('div', { class:'cardTitle' }, [document.createTextNode(i.Title || 'Issue')]),
              el('div', { class:'cardDesc' }, [document.createTextNode(i.Description || '')]),
              badges
            ])
          ]);

          const urls = asArray(g.urls);
          const instances = Array.from(g.instances || []);
          const hiddenInstanceCount = Number(g.instanceOverflow || 0);
          const screenshots = Array.from(g.screenshots || []);

          const affectedList = el('ul', { class:'issueUrlList' }, []);
          const urlMax = 12;
          urls.slice(0, urlMax).forEach((u) => {
            affectedList.appendChild(el('li', null, [document.createTextNode(u)]));
          });
          const moreUrlsBtn = urls.length > urlMax
            ? el('button', { class:'btn', type:'button' }, [document.createTextNode('Show all pages')])
            : null;
          const allUrlsBox = el('ul', { class:'issueUrlList', style:'display:none;margin-top:8px' });
          if (moreUrlsBtn) {
            urls.forEach((u) => {
              allUrlsBox.appendChild(el('li', null, [document.createTextNode(u)]));
            });
            moreUrlsBtn.addEventListener('click', () => {
              const isOpen = allUrlsBox.style.display !== 'none';
              allUrlsBox.style.display = isOpen ? 'none' : 'grid';
              moreUrlsBtn.textContent = isOpen ? 'Show all pages' : 'Hide all pages';
            });
          }

          const instanceList = el('div', { class:'issueInstanceList' }, []);
          const instanceMax = 12;
          instances.slice(0, instanceMax).forEach((inst) => {
            const row = el('div', { class:'issueInstanceRow' }, [
              el('div', null, [
                el('div', { class:'elem' }, [document.createTextNode(inst.element || '-')]),
                el('div', { class:'meta' }, [document.createTextNode(inst.url || '')])
              ]),
              inst.url ? el('a', { class:'btn openLink', href: inst.url, target:'_blank', rel:'noopener' }, [document.createTextNode('Open')]) : null
            ].filter(Boolean));
            instanceList.appendChild(row);
          });

          const moreInstancesBtn = instances.length > instanceMax
            ? el('button', { class:'btn', type:'button' }, [document.createTextNode('Show all instances')])
            : null;
          const allInstanceBox = el('div', { style:'display:none;gap:8px;flex-direction:column' });
          if (moreInstancesBtn) {
            instances.forEach((inst) => {
              const row = el('div', { class:'issueInstanceRow' }, [
                el('div', null, [
                  el('div', { class:'elem' }, [document.createTextNode(inst.element || '-')]),
                  el('div', { class:'meta' }, [document.createTextNode(inst.url || '')])
                ]),
                inst.url ? el('a', { class:'btn openLink', href: inst.url, target:'_blank', rel:'noopener' }, [document.createTextNode('Open')]) : null
              ].filter(Boolean));
              allInstanceBox.appendChild(row);
            });
            moreInstancesBtn.addEventListener('click', () => {
              const isOpen = allInstanceBox.style.display !== 'none';
              allInstanceBox.style.display = isOpen ? 'none' : 'flex';
              moreInstancesBtn.textContent = isOpen ? 'Show all instances' : 'Hide all instances';
            });
          }

          const lighthouseLink = results.find((r) => groupHasUrl(g, r.url) && r.lighthouseHtmlRel);
          const bodySections = [
            el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode("What's broken")]),
              el('div', { class:'muted' }, [document.createTextNode(i.Description || '')])
            ]),
            isFormIssue && i.Element ? el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('Form diagnostics')]),
              isClientAudience
                ? el('div', { class:'muted' }, [document.createTextNode(i.Element)])
                : el('pre', { class:'code' }, [document.createTextNode(i.Element)])
            ]) : null,
            el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('AI prioritization')]),
              el('div', { class:'muted' }, [document.createTextNode(aiPrioritization(g))])
            ]),
            el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('Affected pages')]),
              affectedList,
              moreUrlsBtn || el('div', { class:'muted' }, [document.createTextNode(urls.length ? '' : '-')]),
              allUrlsBox
            ].filter(Boolean)),
            el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('How to fix')]),
              el('div', { class:'muted' }, [document.createTextNode(i.Recommendation || '')])
            ]),
            issueHelp[i.Title] ? el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('Why this matters (WP/Elementor)')]),
              el('div', { class:'muted' }, [document.createTextNode(issueHelp[i.Title].why || '')]),
              el('div', { class:'muted', style:'margin-top:6px' }, [document.createTextNode('Where to look: ' + (issueHelp[i.Title].where || ''))]),
              el('div', { class:'muted', style:'margin-top:6px' }, [document.createTextNode('Fix approach: ' + (issueHelp[i.Title].fix || ''))])
            ]) : null,
            el('div', { class:'actions' }, [
              el('button', { class:'btn', type:'button' }, [document.createTextNode('Copy Issue Details')]),
              screenshots.length ? el('a', { class:'btn', href: screenshots[0], target:'_blank', rel:'noopener' }, [document.createTextNode('View Screenshot')]) : null,
              lighthouseLink ? el('a', { class:'btn', href: lighthouseLink.lighthouseHtmlRel, target:'_blank', rel:'noopener' }, [document.createTextNode('View Lighthouse')]) : null,
              el('a', { class:'btn primary', href: urls[0] || i.URL || '#', target:'_blank', rel:'noopener' }, [document.createTextNode('Open Example Page')])
            ])
          ];
          if (!isClientAudience) {
            bodySections.splice(3, 0, el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('Affected element')]),
              el('pre', { class:'code' }, [document.createTextNode(i.Element || '')])
            ]));
            bodySections.splice(4, 0, el('div', null, [
              el('div', { class:'sectionTitle' }, [document.createTextNode('Instances')]),
              instanceList,
              hiddenInstanceCount > 0
                ? el('div', { class:'muted', style:'margin-top:6px' }, [document.createTextNode(String(hiddenInstanceCount) + ' additional duplicate instances hidden for readability.')])
                : null,
              moreInstancesBtn || el('div', { class:'muted' }, [document.createTextNode(instances.length ? '' : '-')]),
              allInstanceBox
            ].filter(Boolean)));
          }
          const body = el('div', { class:'cardBody' }, bodySections);

          const copyBtn = body.querySelector('.actions button');
          copyBtn.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(issueDetailsForCopy(i));
            } catch {
              // best-effort
            }
          });

          card.appendChild(summary);
          card.appendChild(body);
          return card;
        }

        function buildIssueFamilies(groups) {
          const families = new Map();
          groups.forEach((g) => {
            const issue = g.issue || {};
            const title = String(issue.Title || 'Issue');
            const category = String(g.displayCategory || issue.CategoryGroup || issue.Category || 'Structure');
            const key = category.toLowerCase() + '::' + title.toLowerCase();
            const existing = families.get(key) || {
              key,
              title,
              category,
              groups: [],
              urls: new Set(),
              maxSeverity: 'info',
              maxWeight: 0
            };
            existing.groups.push(g);
            asArray(g.urls).forEach((u) => existing.urls.add(u));
            const sev = String(issue.Severity || 'info').toLowerCase();
            const weight = severityWeight[sev] || 1;
            if (weight > existing.maxWeight) {
              existing.maxWeight = weight;
              existing.maxSeverity = sev;
            }
            families.set(key, existing);
          });

          return Array.from(families.values())
            .map((family) => ({ ...family, impacted: family.urls.size }))
            .sort((a, b) =>
              (b.maxWeight - a.maxWeight) ||
              (b.groups.length - a.groups.length) ||
              (b.impacted - a.impacted)
            );
        }

        function renderCards(){
          const wrap = document.getElementById('cards');
          wrap.innerHTML = '';

          const globalOnly = document.getElementById('globalOnly')?.checked;

        const groupsSource = allGroups.length ? allGroups : rawGroups;
          const hasActiveFilters = selectedCategory !== 'All' ||
            selectedSeverity.size !== severityOrder.length ||
            query ||
            document.getElementById('globalOnly')?.checked;

          let filtered = groupsSource.filter(g => {
            if (!selectedSeverity.has(g.issue.Severity || 'info')) return false;
            if (selectedCategory !== 'All' && (g.displayCategory || 'Structure') !== selectedCategory) return false;
            if (globalOnly && !g.isGlobal) return false;
            if (query && !groupToText(g).includes(query)) return false;
            return true;
          });
          if (audience === 'client') {
            filtered = filtered.slice(0, 20);
          }

          if (!filtered.length && groupsSource.length) {
            if (hasActiveFilters) {
              const msg = el('div', { class:'panel' }, [
                el('div', { class:'muted' }, [document.createTextNode('No issues match the current filters.')]),
                el('div', { class:'actions', style:'margin-top:8px' }, [
                  el('button', { class:'btn', type:'button', id:'clearFiltersInline' }, [document.createTextNode('Clear filters')])
                ])
              ]);
              wrap.appendChild(msg);
              const btn = msg.querySelector('#clearFiltersInline');
              if (btn) {
                btn.addEventListener('click', () => {
                  selectedCategory = 'All';
                  selectedSeverity = new Set(severityOrder);
                  query = '';
                  document.getElementById('searchBox').value = '';
                  document.getElementById('globalOnly').checked = false;
                  render();
                });
              }
              return;
            }
            // Failsafe: if no filters are active, show all issues.
            filtered = groupsSource.slice();
          }

          if (!filtered.length) {
            wrap.appendChild(el('div', { class:'panel' }, [
              el('div', { class:'muted' }, [document.createTextNode('No issues to display.')])
            ]));
            return;
          }

          const families = buildIssueFamilies(filtered);
          const label = document.getElementById('issueCountLabel');
          if (label) {
            label.textContent = '(showing ' + filtered.length + ' issue groups in ' + families.length + ' accordions)';
          }

          let cardIndex = 0;
          const defaultOpenFamilies = audience === 'developer' ? 5 : 3;
          families.forEach((family, familyIndex) => {
            const familyNode = el('details', { class: 'issueFamilyAccordion', 'data-family-key': family.key });
            if (familyIndex < defaultOpenFamilies) {
              familyNode.setAttribute('open', 'open');
            }
            const familySummary = el('summary', { class: 'issueFamilySummary' }, [
              el('div', null, [
                el('div', { class: 'title' }, [document.createTextNode(family.title)]),
                el('div', { class: 'meta' }, [
                  document.createTextNode(family.category + ' • ' + family.groups.length + ' similar issue group' + (family.groups.length === 1 ? '' : 's') + ' • Affected pages: ' + family.impacted)
                ])
              ]),
              el('div', { class: 'badges' }, [
                el('span', { class: 'badge sev-' + family.maxSeverity }, [document.createTextNode(family.maxSeverity)]),
                el('span', { class: 'badge' }, [document.createTextNode('Grouped')])
              ])
            ]);

            const familyBody = el('div', { class: 'issueFamilyBody' }, []);
            family.groups.forEach((g) => {
              familyBody.appendChild(buildIssueCard(g, cardIndex));
              cardIndex += 1;
            });

            familyNode.appendChild(familySummary);
            familyNode.appendChild(familyBody);
            wrap.appendChild(familyNode);
          });
        }

        function render(){
          try {
            renderRunStateBanner();
            renderAudienceHero();
            renderChips();
            renderKpis();
            renderFixPriority();
            renderTemplateInsight();
            renderChangeSummary();
            renderHistory();
            renderCategorySummary();
            renderChecklistSummary();
            renderPagesTable();
            renderEvidence();
            renderCards();
            renderStickyMeta();
            renderAudienceModeNote();
          } catch (err) {
            console.error('Render error', err);
            const root = document.querySelector('.wrap');
            if (root) {
              root.innerHTML = '';
              var panel = document.createElement('div');
              panel.className = 'panel';
              var panelTitle = document.createElement('div');
              panelTitle.className = 'panelTitle';
              panelTitle.textContent = 'Render Error';
              var errorMessage = document.createElement('div');
              errorMessage.className = 'muted';
              errorMessage.textContent = (err && err.message ? err.message : 'Unknown error');
              var errorMeta = document.createElement('div');
              errorMeta.className = 'muted';
              errorMeta.textContent = 'Issues: ' + (issues ? issues.length : 0) + ' | Results: ' + (results ? results.length : 0);
              panel.appendChild(panelTitle);
              panel.appendChild(errorMessage);
              panel.appendChild(errorMeta);
              root.appendChild(panel);
            }
          }
        }

        document.getElementById('searchBox').addEventListener('input', (e) => {
          query = String(e.target.value || '').trim().toLowerCase();
          render();
        });

        document.getElementById('globalOnly').addEventListener('change', () => render());
        document.getElementById('clearFilters').addEventListener('click', () => {
          selectedCategory = 'All';
          selectedSeverity = new Set(severityOrder);
          query = '';
          document.getElementById('searchBox').value = '';
          document.getElementById('globalOnly').checked = false;
          render();
        });

        function wireShareButtons(){
          const href = data.shareZip || '';
          const buttons = [document.getElementById('shareZipBtn'), document.getElementById('shareZipBtnSticky')].filter(Boolean);
          buttons.forEach(btn => {
            if (!href) {
              disableAnchorButton(btn, 'Export Evidence ZIP (not available)');
              return;
            }
            enableAnchorButton(btn, href, 'Export Evidence ZIP');
            btn.setAttribute('download', '');
          });
        }

        function wireStaticAssetButtons() {
          const targets = [
            ['exportCsvBtn', '../results.csv', !!(data.reportAssets && data.reportAssets.csv), 'Export CSV'],
            ['exportCsvBtnSticky', '../results.csv', !!(data.reportAssets && data.reportAssets.csv), 'Export CSV'],
            ['openPdfBtn', '../QA_Report.pdf', !!(data.reportAssets && data.reportAssets.pdf), 'Export PDF'],
            ['openPdfBtnSticky', '../QA_Report.pdf', !!(data.reportAssets && data.reportAssets.pdf), 'Export PDF'],
            ['openExcelBtn', '../QA_Report.xlsx', !!(data.reportAssets && data.reportAssets.excel), 'Open Excel'],
            ['openExcelBtnSticky', '../QA_Report.xlsx', !!(data.reportAssets && data.reportAssets.excel), 'Open Excel']
          ];
          targets.forEach(([id, href, isAvailable, label]) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            if (!isAvailable) {
              disableAnchorButton(btn, label + ' (not available)');
              return;
            }
            enableAnchorButton(btn, href, label, {
              target: btn.getAttribute('target') || '',
              rel: btn.getAttribute('rel') || ''
            });
          });
        }

        function renderStickyMeta(){
          const elMeta = document.getElementById('stickyMeta');
          if (!elMeta) return;
          const origins = Array.from(new Set(results.map(r => {
            try { return new URL(r.url).origin; } catch { return ''; }
          }).filter(Boolean)));
          const site = origins.length === 1 ? origins[0] : (results[0]?.url || '');
          elMeta.innerHTML = '';
          elMeta.appendChild(el('span', null, [document.createTextNode('Site: ' + site)]));
          elMeta.appendChild(el('span', null, [document.createTextNode('Run: ' + (data.stats?.generatedAt || ''))]));
          elMeta.appendChild(el('span', null, [document.createTextNode('Pages: ' + (data.stats?.totalUrls || 0))]));
          elMeta.appendChild(el('span', null, [document.createTextNode('State: ' + String(data.runMeta?.state || 'partial'))]));
          elMeta.appendChild(el('span', null, [document.createTextNode('Mode: WordPress QA (' + (audience === 'developer' ? 'Developer Detail' : 'Client Summary') + ')')]));

          const stackMeta = document.getElementById('stackMeta');
          if (stackMeta) {
            stackMeta.innerHTML = '';
            const parts = [];
            if (themesDetected.length) parts.push('Theme: ' + themesDetected[0]);
            if (pluginsDetected.length) parts.push('Plugins: ' + pluginsDetected.slice(0,3).join(', '));
            if (schemasDetected.length) parts.push('Schema: ' + schemasDetected.slice(0,3).join(', '));
            if (parts.length) {
              stackMeta.appendChild(el('span', null, [document.createTextNode(parts.join(' • '))]));
            }
          }
        }

        function renderAudienceModeNote() {
          const note = document.getElementById('audienceModeNote');
          if (!note) return;
          if (audience === 'developer') {
            note.textContent = 'Developer Detail mode: full technical evidence, selectors, and ownership/actionability metadata.';
          } else {
            note.textContent = 'Client Summary mode: prioritized, plain-language issues with reduced technical detail.';
          }
        }

        function renderAudienceHero() {
          const hero = document.getElementById('audienceHero');
          if (!hero) return;

          const source = allGroups.length ? allGroups : rawGroups;
          const totalGroups = source.length;
          const visibleGroups = audience === 'client' ? Math.min(20, totalGroups) : totalGroups;
          const hiddenGroups = Math.max(0, totalGroups - visibleGroups);
          const criticalCount = source.filter((g) => (g.issue.Severity || 'info') === 'critical').length;
          const majorCount = source.filter((g) => (g.issue.Severity || 'info') === 'major').length;

          hero.className = 'audienceHero mode-' + audience;
          hero.innerHTML = '';

          const title =
            audience === 'developer'
              ? 'Developer Detail Workspace'
              : 'Client Summary Workspace';
          const desc =
            audience === 'developer'
              ? 'Technical evidence is expanded with selector-level context, ownership/actionability metadata, and deep remediation detail.'
              : 'Impact-first summary for client sharing with concise language and prioritized issue groups.';

          const visibilityTag = hiddenGroups > 0
            ? ('Showing ' + visibleGroups + ' of ' + totalGroups + ' issue groups')
            : ('Showing all ' + totalGroups + ' issue groups');

          hero.appendChild(el('div', null, [
            el('div', { class: 'title' }, [document.createTextNode(title)]),
            el('div', { class: 'desc' }, [document.createTextNode(desc)])
          ]));
          hero.appendChild(el('div', { class: 'meta' }, [
            el('span', { class: 'tag' }, [document.createTextNode(visibilityTag)]),
            el('span', { class: 'tag' }, [document.createTextNode('Critical: ' + criticalCount)]),
            el('span', { class: 'tag' }, [document.createTextNode('Major: ' + majorCount)])
          ]));
        }

        render();
        wireStaticAssetButtons();
        wireShareButtons();
      })();
    </script>
  </body>
</html>`;

  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`HTML report saved to ${outPath}`);

  // Persist current issues for "What changed since last run".
  // Only persist history on successful/complete runs to avoid misleading deltas on partial/first runs.
  if (runMeta.state === 'complete') {
    try {
      fs.mkdirSync(historyDir, { recursive: true });
      fs.writeFileSync(
        path.join(historyDir, 'issues.previous.json'),
        JSON.stringify(
          { client: safeClientName, generatedAt: stats.generatedAt, issues: issuesRaw },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      // best-effort
    }
  }

  const noAutoOpen = String(process.env.NO_AUTO_OPEN || '').toLowerCase() === 'true';
  if (!noAutoOpen) {
    // Auto-open report after save (best-effort).
    try {
      if (process.platform === 'darwin') {
        const res = spawnSync('open', [outPath], { stdio: 'ignore' });
        if (res.error) throw res.error;
      } else if (process.platform === 'win32') {
        const res = spawnSync('cmd', ['/c', 'start', '', outPath], { stdio: 'ignore', shell: true });
        if (res.error) throw res.error;
      } else {
        const res = spawnSync('xdg-open', [outPath], { stdio: 'ignore' });
        if (res.error) throw res.error;
      }
    } catch (error) {
      console.warn(`[Baseline] Auto-open failed. Open manually: ${outPath}`);
    }
  }
}

const clientName = process.argv[2] || process.env.CLIENT_NAME || 'default';

generate(clientName).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
