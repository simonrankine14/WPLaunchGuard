const fs = require('fs');
const path = require('path');
const {
  resolveClientReportsDir,
  resolveRunRoot,
  validateClientId
} = require('./lib/safe-paths');
const {
  buildIssueSummary,
  normalizeIssueEntry
} = require('./lib/issue-model');

const args = process.argv.slice(2);
const clientArg = args.find((arg) => !arg.startsWith('--'));

if (!clientArg) {
  console.error('Usage: node scripts/merge-qa-results.js <clientname>');
  process.exit(1);
}

let clientName = '';
try {
  clientName = validateClientId(clientArg);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const packageRoot = path.join(__dirname, '..');
const runRoot = resolveRunRoot(process.env, packageRoot);
const reportsDir = resolveClientReportsDir(runRoot, clientName);
const shardDir = path.join(reportsDir, '.tmp', 'shards');

const RESULTS_CSV = path.join(reportsDir, 'results.csv');
const ISSUES_TSV = path.join(reportsDir, 'issues.tsv');
const SITE_SUMMARY_CSV = path.join(reportsDir, 'site_summary.csv');
const ISSUES_JSON = path.join(reportsDir, 'issues.json');
const BLOCKED_SAMPLES_JSON = path.join(reportsDir, 'blocked_samples.json');
const URL_SUMMARY_CSV = path.join(reportsDir, 'url_summary.csv');
const RUN_META_JSON = path.join(reportsDir, 'run_meta.json');

function atomicWrite(filePath, data, encoding = 'utf8') {
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmpPath, data, encoding);
  fs.renameSync(tmpPath, filePath);
}

const RESULTS_HEADERS = [
  'url',
  'status',
  'consoleErrors',
  'consoleErrorsSample',
  'pageErrors',
  'pageErrorsSample',
  'brokenLinks',
  'brokenLinksSample',
  'linkCheckErrors',
  'linkCheckErrorsSample',
  'h1Count',
  'missingAlt',
  'missingAltSample',
  'brokenImages',
  'brokenImagesSample',
  'externalLinksMissingBlank',
  'externalLinksMissingBlankSample',
  'imagesMissingLazy',
  'imagesMissingLazySample',
  'jsonLdPresent',
  'metaTitle',
  'metaDescriptionPresent',
  'viewportMeta',
  'mobileOverflow',
  'modalBlocking',
  'modalBlockingSample',
  'formsTotal',
  'formsValid',
  'formsSubmitted',
  'formsSkipped',
  'formsFailed',
  'formsInvalidSample',
  'formsIssueSample',
  'axeViolations',
  'axeViolationSample',
  'lighthousePerformance',
  'lighthouseAccessibility',
  'lighthouseBestPractices',
  'lighthouseSEO',
  'lighthouseReportHtml',
  'lighthouseReportJson',
  'failReasons',
  'error',
  'internalLinksBlank',
  'internalLinksBlankSample',
  'mobileNavFullWidth',
  'headingSkip',
  'desktopOverflow',
  'desktopOverflowSample',
  'desktopOverflowCause',
  'navMissingAriaSample',
  'anchorMissingTargetsSample',
  'schemaTypes',
  'cachingHints',
  'templateName',
  'pluginHints',
  'themeHints',
  'templateKey',
  'browser',
  'device',
  'viewport',
  'screenshotPath',
  'mainStatus',
  'blockedReason',
  'loadMs',
  'finalUrl'
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function issueKey(entry) {
  const canonical = String(entry.canonicalKey || '').toLowerCase();
  if (canonical) return canonical;
  return [
    entry.Category,
    entry.Title
  ]
    .map((part) => String(part || '').toLowerCase())
    .join('|');
}

function normalizeIssue(entry) {
  return normalizeIssueEntry(entry || {});
}

function filterGlobalAxeIssues(issueRows, summary) {
  const globalAxeKeys = new Set();
  summary.forEach((value, key) => {
    if (value.Global === 'yes' && value.Category === 'accessibility' && value._source === 'axe') {
      globalAxeKeys.add(key);
    }
  });
  if (globalAxeKeys.size === 0) return issueRows;
  return issueRows.filter((row) => {
    if (row._source !== 'axe') return true;
    return !globalAxeKeys.has(issueKey(normalizeIssue(row)));
  });
}

function writeCsv(rows) {
  const lines = [RESULTS_HEADERS.join(',')];
  rows.forEach((row) => {
    lines.push(RESULTS_HEADERS.map((header) => csvEscape(row[header])).join(','));
  });
  atomicWrite(RESULTS_CSV, lines.join('\n'), 'utf8');
}

function writeIssuesTsv(rows) {
  const headers = [
    'Category',
    'Severity',
    'Title',
    'Description',
    'Element',
    'WCAG',
    'Recommendation',
    'URL'
  ];
  const lines = [headers.join('\t')];
  rows.forEach((row) => {
    const line = headers.map((header) =>
      String(row[header] ?? '')
        .replace(/\t/g, ' ')
        .replace(/\r?\n/g, ' ')
    );
    lines.push(line.join('\t'));
  });
  atomicWrite(ISSUES_TSV, lines.join('\n'), 'utf8');
}

function writeIssuesJson(rows, summary) {
  const payload = {
    generatedAt: new Date().toISOString(),
    client: clientName,
    totals: {
      issues: rows.length,
      summary: summary.size
    },
    issues: rows,
    summary: Array.from(summary.values()).map((item) => {
      const { urls, ...rest } = item;
      return { ...rest, urls: urls ? Array.from(urls) : [] };
    })
  };
  atomicWrite(ISSUES_JSON, JSON.stringify(payload, null, 2), 'utf8');
}

function writeSiteSummaryCsv(summary, totalUrls) {
  const headers = [
    'Issue',
    'Count',
    'Example',
    'Category',
    'Severity',
    'ExampleURL',
    'Recommendation',
    'Global',
    'CanonicalKey',
    'Actionability',
    'Ownership',
    'JourneyScope'
  ];
  const lines = [headers.join(',')];
  const sorted = Array.from(summary.values()).sort((a, b) => b.Count - a.Count);
  sorted.forEach((value) => {
    const row = {
      Issue: value.Title,
      Count: value.Count,
      Example: value.Element,
      Category: value.Category,
      Severity: value.Severity,
      ExampleURL: value.ExampleURL,
      Recommendation: value.Recommendation,
      Global: totalUrls > 0 && value.Count / totalUrls >= 0.7 ? 'yes' : 'no',
      CanonicalKey: value.canonicalKey || '',
      Actionability: value.actionability || '',
      Ownership: value.ownership || '',
      JourneyScope: value.journeyScope || ''
    };
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  });
  atomicWrite(SITE_SUMMARY_CSV, lines.join('\n'), 'utf8');
}

function writeBlockedSamples(samples) {
  if (!samples.length) {
    if (fs.existsSync(BLOCKED_SAMPLES_JSON)) {
      fs.rmSync(BLOCKED_SAMPLES_JSON, { force: true });
    }
    return;
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    client: clientName,
    samples
  };
  atomicWrite(BLOCKED_SAMPLES_JSON, JSON.stringify(payload, null, 2), 'utf8');
}

function writeUrlSummary(rows) {
  const headers = [
    'url',
    'worstStatus',
    'runs',
    'passRuns',
    'failRuns',
    'blockedRuns',
    'errorRuns',
    'browsers',
    'devices',
    'sampleFailReasons'
  ];
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  });
  atomicWrite(URL_SUMMARY_CSV, lines.join('\n'), 'utf8');
}

function buildUrlSummary(results) {
  const statusRank = { ERROR: 4, BLOCKED: 3, FAIL: 2, PASS: 1 };
  const byUrl = new Map();
  results.forEach((row) => {
    const url = String(row.url || '').trim();
    if (!url) return;
    const entry =
      byUrl.get(url) ||
      {
        url,
        statuses: [],
        browsers: new Set(),
        devices: new Set(),
        reasons: []
      };
    const status = String(row.status || 'PASS').toUpperCase();
    entry.statuses.push(status);
    if (row.browser) entry.browsers.add(String(row.browser));
    if (row.device) entry.devices.add(String(row.device));
    if (row.failReasons) entry.reasons.push(String(row.failReasons));
    byUrl.set(url, entry);
  });

  return Array.from(byUrl.values())
    .map((entry) => {
      const counts = {
        PASS: entry.statuses.filter((s) => s === 'PASS').length,
        FAIL: entry.statuses.filter((s) => s === 'FAIL').length,
        BLOCKED: entry.statuses.filter((s) => s === 'BLOCKED').length,
        ERROR: entry.statuses.filter((s) => s === 'ERROR').length
      };
      const worstStatus = entry.statuses
        .slice()
        .sort((a, b) => (statusRank[b] || 0) - (statusRank[a] || 0))[0] || 'PASS';
      return {
        url: entry.url,
        worstStatus,
        runs: entry.statuses.length,
        passRuns: counts.PASS,
        failRuns: counts.FAIL,
        blockedRuns: counts.BLOCKED,
        errorRuns: counts.ERROR,
        browsers: Array.from(entry.browsers).join(' | '),
        devices: Array.from(entry.devices).join(' | '),
        sampleFailReasons: entry.reasons.filter(Boolean).slice(0, 3).join(' || ')
      };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

function dedupeResults(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const key = [row.url, row.browser, row.device, row.viewport].map((v) => String(v || '')).join('|');
    map.set(key, row);
  });
  return Array.from(map.values());
}

function parseBoolean(value) {
  return String(value || '').toLowerCase() === 'true';
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function writeRunMeta({
  state,
  shardFiles,
  totalInputUrls,
  resultsRows,
  uniqueUrls,
  issuesRows,
  summaryRows,
  blockedSamples
}) {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    client: clientName,
    state,
    run: {
      startedAt: process.env.RUN_STARTED_AT || '',
      endedAt: process.env.RUN_ENDED_AT || '',
      quick: parseBoolean(process.env.QA_QUICK),
      full: parseBoolean(process.env.QA_FULL),
      projects: String(process.env.QA_PROJECTS || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      workers: parseNumber(process.env.QA_WORKERS),
      interrupted: parseBoolean(process.env.QA_INTERRUPTED),
      playwrightExitCode: parseNumber(process.env.PLAYWRIGHT_EXIT_CODE)
    },
    merge: {
      status: 'ok',
      shardFiles
    },
    counts: {
      inputUrls: totalInputUrls,
      resultRows: resultsRows,
      uniqueUrls,
      issueRows: issuesRows,
      summaryRows,
      blockedSamples
    }
  };
  atomicWrite(RUN_META_JSON, JSON.stringify(payload, null, 2), 'utf8');
}

function main() {
  fs.mkdirSync(reportsDir, { recursive: true });

  const runStartedAt = String(process.env.RUN_STARTED_AT || '');
  const shardFiles = fs.existsSync(shardDir)
    ? fs.readdirSync(shardDir).filter((file) => file.endsWith('.json'))
    : [];

  const parsedShards = shardFiles
    .map((file) => {
      const fullPath = path.join(shardDir, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        return { file, parsed };
      } catch (error) {
        console.warn(`[merge-qa-results] Skipping unreadable shard ${file}: ${error.message}`);
        return null;
      }
    })
    .filter(Boolean);

  let selectedShards = parsedShards;
  if (runStartedAt) {
    const matching = parsedShards.filter((item) => String(item.parsed.runStartedAt || '') === runStartedAt);
    if (matching.length > 0) {
      selectedShards = matching;
    }
  }

  const allResults = [];
  const allIssues = [];
  const allBlockedSamples = [];
  let totalInputUrls = 0;

  selectedShards.forEach(({ parsed }) => {
    if (Array.isArray(parsed.results)) allResults.push(...parsed.results);
    if (Array.isArray(parsed.issues)) allIssues.push(...parsed.issues.map((issue) => normalizeIssue(issue)));
    if (Array.isArray(parsed.blockedSamples)) allBlockedSamples.push(...parsed.blockedSamples);
    totalInputUrls = Math.max(totalInputUrls, Number(parsed.totalInputUrls || 0));
  });

  const results = dedupeResults(allResults);
  const urlUniverse = totalInputUrls || new Set(results.map((row) => row.url).filter(Boolean)).size;
  const initialSummary = buildIssueSummary(allIssues, urlUniverse);
  const filteredIssues = filterGlobalAxeIssues(allIssues, initialSummary).map((issue) => normalizeIssue(issue));
  const effectiveSummary = buildIssueSummary(filteredIssues, urlUniverse);
  const urlSummaryRows = buildUrlSummary(results);

  results.sort((a, b) => String(a.url || '').localeCompare(String(b.url || '')));

  writeCsv(results);
  writeIssuesTsv(filteredIssues);
  writeSiteSummaryCsv(effectiveSummary, urlUniverse);
  writeIssuesJson(filteredIssues, effectiveSummary);
  writeBlockedSamples(allBlockedSamples);
  writeUrlSummary(urlSummaryRows);

  const interrupted = parseBoolean(process.env.QA_INTERRUPTED);
  const uniqueUrls = new Set(results.map((row) => row.url).filter(Boolean)).size;
  let state = 'complete';
  if (interrupted) {
    state = 'interrupted';
  } else if (results.length === 0) {
    state = 'partial';
  } else if (urlUniverse > 0 && uniqueUrls < urlUniverse) {
    state = 'partial';
  }

  writeRunMeta({
    state,
    shardFiles: selectedShards.length,
    totalInputUrls: totalInputUrls || uniqueUrls,
    resultsRows: results.length,
    uniqueUrls,
    issuesRows: filteredIssues.length,
    summaryRows: effectiveSummary.size,
    blockedSamples: allBlockedSamples.length
  });

  if (fs.existsSync(shardDir)) {
    fs.rmSync(shardDir, { recursive: true, force: true });
  }

  console.log(
    `[merge-qa-results] Merged ${selectedShards.length} shard(s): ${results.length} runs, ${filteredIssues.length} issues, state=${state}`
  );
}

try {
  main();
} catch (error) {
  console.error(`[merge-qa-results] ${error.message || error}`);
  process.exit(1);
}
