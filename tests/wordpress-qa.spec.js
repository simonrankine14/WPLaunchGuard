const fs = require('fs');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const lighthouse = require('lighthouse').default || require('lighthouse');
const chromeLauncher = require('chrome-launcher');
const { resolveClientReportsDir, validateClientId } = require('../scripts/lib/safe-paths');
const { normalizeIssueEntry } = require('../scripts/lib/issue-model');
const {
  buildEmbeddedFormSelector,
  detectEmbeddedFormProvider,
  isLikelyContactUrl,
  isLikelyEmbeddedFormFrame
} = require('../scripts/lib/form-detection');

const RUN_ROOT = process.env.LAUNCHGUARD_ROOT ? path.resolve(process.env.LAUNCHGUARD_ROOT) : process.cwd();
const DEFAULT_DATA_PATH = path.join(RUN_ROOT, 'data', 'urls.json');
const DATA_PATH = process.env.URLS_PATH
  ? path.resolve(process.env.URLS_PATH)
  : DEFAULT_DATA_PATH;
const CLIENT_NAME = validateClientId((process.env.CLIENT_NAME || 'default').trim(), 'CLIENT_NAME');
const REPORTS_DIR = resolveClientReportsDir(RUN_ROOT, CLIENT_NAME);
const LIGHTHOUSE_DIR = path.join(REPORTS_DIR, 'lighthouse');
const SCREENSHOTS_DIR = path.join(REPORTS_DIR, 'screenshots');
const SHARD_DIR = path.join(REPORTS_DIR, '.tmp', 'shards');
const SHARD_RUN_ID = String(process.env.RUN_STARTED_AT || '').trim();
const RESULTS_CSV = path.join(REPORTS_DIR, 'results.csv');
const ISSUES_TSV = path.join(REPORTS_DIR, 'issues.tsv');
const ISSUES_JSON = path.join(REPORTS_DIR, 'issues.json');
const SITE_SUMMARY_CSV = path.join(REPORTS_DIR, 'site_summary.csv');
const BLOCKED_SAMPLES_JSON = path.join(REPORTS_DIR, 'blocked_samples.json');
let screenshotCounter = 0;

// Default to live form submission so QA proves forms work end-to-end.
// Use FORM_SUBMIT_MODE=dry-run to avoid sending emails/leads.
const FORM_SUBMIT_MODE = (process.env.FORM_SUBMIT_MODE || 'live').toLowerCase();
const QA_PROFILE = ['client-safe', 'engineering-deep'].includes((process.env.QA_PROFILE || '').toLowerCase())
  ? (process.env.QA_PROFILE || '').toLowerCase()
  : 'client-safe';
const PROFILE_DEFAULTS = {
  'client-safe': { screenshotsMode: 'off' },
  'engineering-deep': { screenshotsMode: 'issues' }
};
const PROFILE_SETTINGS = PROFILE_DEFAULTS[QA_PROFILE];
const LINK_CHECK_CONCURRENCY = Number(process.env.LINK_CHECK_CONCURRENCY || 10);
const LINK_SCOPE = ['internal', 'all'].includes((process.env.LINK_SCOPE || '').toLowerCase())
  ? (process.env.LINK_SCOPE || '').toLowerCase()
  : 'internal';
const LINK_CHECK_TIMEOUT_MS = Number(process.env.LINK_CHECK_TIMEOUT_MS || 7000);
const LINK_ALLOWLIST = (process.env.LINK_ALLOWLIST || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);
const BROKEN_LINK_IGNORE_PATTERNS = (process.env.BROKEN_LINK_IGNORE || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => new RegExp(p, 'i'))
  .concat([/\.cpanel\.site/i, /\/wordpress\/?$/i]);
const MAX_SAMPLES = Number(process.env.MAX_SAMPLES || 5);
const SKIP_LIGHTHOUSE = (process.env.SKIP_LIGHTHOUSE || '').toLowerCase() === 'true';
const LIGHTHOUSE_QUEUE = (process.env.LIGHTHOUSE_QUEUE || 'true').toLowerCase() === 'true';
const LIGHTHOUSE_WORKERS = Math.max(1, Number(process.env.LIGHTHOUSE_WORKERS || 1));
const SKIP_AXE = (process.env.SKIP_AXE || '').toLowerCase() === 'true';
const SKIP_SEO = (process.env.SKIP_SEO || '').toLowerCase() === 'true';
const STRICT = (process.env.STRICT || '').toLowerCase() === 'true';
const FAIL_ON_CONSOLE_SEVERITY = (process.env.FAIL_ON_CONSOLE_SEVERITY || 'medium').toLowerCase();
const FAIL_ON_PAGE_ERROR_SEVERITY = (process.env.FAIL_ON_PAGE_ERROR_SEVERITY || 'critical').toLowerCase();
// Accessibility + Lighthouse are noisy for general migration QA. We still collect and report them,
// but do not fail the page unless explicitly enabled.
const FAIL_ON_AXE = (process.env.FAIL_ON_AXE || 'false').toLowerCase() === 'true';
const FAIL_ON_LIGHTHOUSE = (process.env.FAIL_ON_LIGHTHOUSE || 'false').toLowerCase() === 'true';
const FAIL_ON_AXE_SEVERITY = (process.env.FAIL_ON_AXE_SEVERITY || 'serious').toLowerCase();
const FAIL_ON_MISSING_ALT = (process.env.FAIL_ON_MISSING_ALT || 'true').toLowerCase() === 'true';
const FAIL_ON_H1 = (process.env.FAIL_ON_H1 || 'true').toLowerCase() === 'true';
const FAIL_ON_BROKEN_LINKS = (process.env.FAIL_ON_BROKEN_LINKS || 'true').toLowerCase() === 'true';
const FAIL_ON_LINK_CHECK_ERRORS = (process.env.FAIL_ON_LINK_CHECK_ERRORS || 'false').toLowerCase() === 'true';
const FAIL_ON_FORMS = (process.env.FAIL_ON_FORMS || 'true').toLowerCase() === 'true';
const FAIL_ON_LIGHTHOUSE_PERF = Number(process.env.FAIL_ON_LIGHTHOUSE_PERF || 60);
const FAIL_ON_LIGHTHOUSE_SEO = Number(process.env.FAIL_ON_LIGHTHOUSE_SEO || 70);
const FAIL_ON_LIGHTHOUSE_BEST_PRACTICES = Number(process.env.FAIL_ON_LIGHTHOUSE_BEST_PRACTICES || 70);
const FAIL_ON_LIGHTHOUSE_ACCESSIBILITY = Number(process.env.FAIL_ON_LIGHTHOUSE_ACCESSIBILITY || 80);
const SCREENSHOTS_MODE = (process.env.SCREENSHOTS_MODE || PROFILE_SETTINGS.screenshotsMode).toLowerCase();
// Keep evidence lean by default; can be increased via env override.
const SCREENSHOTS_LIMIT = Number(process.env.SCREENSHOTS_LIMIT || 2);
const CONSOLE_ALLOWLIST = (process.env.CONSOLE_ALLOWLIST || '')
  .split('|')
  .map((item) => item.trim())
  .filter(Boolean);
const PAGE_ERROR_ALLOWLIST = (process.env.PAGE_ERROR_ALLOWLIST || '')
  .split('|')
  .map((item) => item.trim())
  .filter(Boolean);
const NAV_RETRIES = Number(process.env.NAV_RETRIES || 2);
const RUN_MOBILE_CHECKS = (process.env.RUN_MOBILE_CHECKS || '').toLowerCase() === 'true';
const STAGING_FALLBACK = (process.env.STAGING_FALLBACK || 'true').toLowerCase() === 'true';
const HEADED_BLOCK_RETRY = (process.env.HEADED_BLOCK_RETRY || 'true').toLowerCase() === 'true';
const INTERACTIVE = (process.env.INTERACTIVE || '').toLowerCase() === 'true';
const BLOCKED_CONTENT_PATTERNS = (process.env.BLOCKED_CONTENT_PATTERNS ||
  'Technical Domain|Account Suspended|Access denied|Checking your browser|Forbidden|cPanel|Wordfence|Cloudflare|Attention Required|Verify you are human|Request unsuccessful|temporarily unavailable')
  .split('|')
  .map((p) => p.trim())
  .filter(Boolean);
const BLOCKED_SNIPPET_CHARS = Number(process.env.BLOCKED_SNIPPET_CHARS || 300);
const REST_LOOKUP = (process.env.REST_LOOKUP || 'true').toLowerCase() === 'true';
const SUPPRESSED_LAZYLOAD_PATTERNS = [
  /cdn-cookieyes\.com/i,
  /cookieyes/i,
  /googletagmanager/i,
  /google-analytics/i,
  /youtube\.com/i,
  /vimeo\.com/i,
  /intercom/i,
  /tawk/i
];

const results = [];
const issues = [];
const issueSummary = new Map();
const blockedSamples = [];
const linkStatusCache = new Map();
let activeTemplateKeyForIssues = '';

function loadUrls() {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`Missing URL file at ${DATA_PATH}`);
  }
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const urls = Array.isArray(parsed) ? parsed : parsed.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('URL list is empty. Add URLs to data/urls.json');
  }
  return urls;
}

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

function writeCsv(rows) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const headers = [
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
    // Append-only extensions for load health / block labeling.
    'mainStatus',
    'blockedReason',
    'loadMs',
    'finalUrl'
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(RESULTS_CSV, lines.join('\n'), 'utf8');
}

function writeIssuesTsv(rows) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
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
  for (const row of rows) {
    const line = headers.map((h) => {
      const value = row[h] ?? '';
      const str = String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
      return str;
    });
    lines.push(line.join('\t'));
  }
  fs.writeFileSync(ISSUES_TSV, lines.join('\n'), 'utf8');
}

function writeIssuesJson(rows, summary) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    client: CLIENT_NAME,
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
  fs.writeFileSync(ISSUES_JSON, JSON.stringify(payload, null, 2), 'utf8');
}

function writeBlockedSamples(samples) {
  if (!samples || samples.length === 0) return;
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    client: CLIENT_NAME,
    samples
  };
  fs.writeFileSync(BLOCKED_SAMPLES_JSON, JSON.stringify(payload, null, 2), 'utf8');
}

function writeSiteSummaryCsv(map, totalUrls) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const headers = [
    'Issue',
    'Count',
    'Example',
    'Category',
    'Severity',
    'ExampleURL',
    'Recommendation',
    'Global'
  ];
  const lines = [headers.join(',')];
  const sorted = Array.from(map.values()).sort((a, b) => b.Count - a.Count);
  for (const value of sorted) {
    const isGlobal = totalUrls > 0 ? value.Count / totalUrls >= 0.7 : false;
    const row = {
      Issue: value.Title,
      Count: value.Count,
      Example: value.Element,
      Category: value.Category,
      Severity: value.Severity,
      ExampleURL: value.ExampleURL,
      Recommendation: value.Recommendation,
      Global: isGlobal ? 'yes' : 'no'
    };
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(SITE_SUMMARY_CSV, lines.join('\n'), 'utf8');
}

function normalizeElement(element) {
  if (!element) return '';
  let output = String(element);
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

function issueKey(entry) {
  return [
    entry.canonicalKey || '',
    entry.Category,
    entry.Title
  ]
    .map((part) => String(part || '').toLowerCase())
    .join('|');
}

function addIssue(entry) {
  const normalized = normalizeIssueEntry({
    ...entry,
    templateKey: entry.templateKey || activeTemplateKeyForIssues
  });

  issues.push(normalized);

  const key = issueKey(normalized);
  const existing = issueSummary.get(key);
  if (existing) {
    if (normalized.URL) {
      existing.urls.add(normalized.URL);
      existing.Count = existing.urls.size;
    }
  } else {
    issueSummary.set(key, {
      ...normalized,
      Count: 1,
      ExampleURL: normalized.URL || '',
      urls: new Set(normalized.URL ? [normalized.URL] : []),
      screenshotPath: normalized.screenshotPath || ''
    });
  }
}

function filterLazyImagesForProfile(images) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [];
  if (QA_PROFILE !== 'client-safe') return list;
  return list.filter((src) => !SUPPRESSED_LAZYLOAD_PATTERNS.some((pattern) => pattern.test(src)));
}

function attachScreenshotToIssues(url, predicate, screenshotPath) {
  if (!screenshotPath) return;
  issues.forEach((issue) => {
    if (issue.URL !== url) return;
    if (!predicate(issue)) return;
    if (!issue.screenshotPath) {
      issue.screenshotPath = screenshotPath;
    }
  });
  // Update summary entry if it matches the same predicate (best-effort).
  issueSummary.forEach((summary) => {
    if (summary.ExampleURL !== url) return;
    if (!predicate(summary)) return;
    if (!summary.screenshotPath) {
      summary.screenshotPath = screenshotPath;
    }
  });
}

function impactToSeverity(impact) {
  switch ((impact || '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'serious':
      return 'major';
    case 'moderate':
      return 'minor';
    case 'minor':
      return 'minor';
    default:
      return 'major';
  }
}

const severityRank = {
  critical: 4,
  major: 3,
  medium: 3,
  serious: 3,
  minor: 2,
  info: 1,
  none: 0
};

function severityMeetsThreshold(severity, threshold) {
  const actual = severityRank[(severity || '').toLowerCase()] ?? 0;
  const limit = severityRank[(threshold || '').toLowerCase()] ?? 0;
  return actual >= limit;
}

function classifyConsoleError(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();

  const resourceMatch = text.match(/(https?:\/\/[^\s)"]+)/);
  const resourceUrl = resourceMatch ? resourceMatch[1] : '';
  const statusMatch = text.match(/status of\s+(\d{3})/i);
  const httpStatus = statusMatch ? statusMatch[1] : '';
  const extension = resourceUrl
    ? resourceUrl.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || ''
    : '';
  const assetType = (() => {
    if (!extension) return resourceUrl ? 'other' : '';
    if (extension === 'js' || extension === 'mjs') return 'js';
    if (extension === 'css') return 'css';
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'ico'].includes(extension)) return 'image';
    if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) return 'font';
    return 'other';
  })();

  const meta = { resourceUrl, httpStatus, assetType, ownership: 'unknown', actionability: 'actionable' };

  if (lower.includes('googletagmanager') || lower.includes('gtm') || lower.includes('google-analytics')) {
      return {
        ...meta,
        severity: 'ignore',
        title: 'Tracking Script Error',
        description: 'A tracking or analytics script failed to load.',
        recommendation: 'Ignore unless analytics is business-critical.',
        ownership: 'third_party',
        actionability: 'info'
      };
  }

  if (lower.includes('maps') || lower.includes('googleapis.com/maps') || lower.includes('maps.googleapis')) {
      return {
        ...meta,
        severity: 'ignore',
        title: 'Map Embed Error',
        description: 'A map embed failed to load or was blocked.',
        recommendation: 'Verify map embed API keys if maps are required.',
        ownership: 'third_party',
        actionability: 'info'
      };
  }

  if (lower.includes('optinmonster') && lower.includes('not currently active')) {
      return {
        ...meta,
        severity: 'critical',
        title: 'Third-party Service Disabled',
        description:
          'An OptinMonster account error indicates lead capture or popups may be broken on this page.',
        recommendation: 'Restore or reconfigure the OptinMonster account.',
        ownership: 'third_party',
        actionability: 'warning'
      };
  }

  if (lower.includes('grecaptcha.execute') || lower.includes('recaptcha')) {
      return {
        ...meta,
        severity: 'critical',
        title: 'reCAPTCHA Error',
        description:
          'A reCAPTCHA error can block form submissions and increase spam risk.',
        recommendation: 'Check reCAPTCHA configuration and ensure scripts load correctly.',
        ownership: 'third_party',
        actionability: 'actionable'
      };
  }

  if (lower.includes('failed to load resource')) {
    if (lower.includes('status of 404') || lower.includes('status of 410')) {
      const isScript = extension === 'js' || extension === 'mjs';
      const isStyle = extension === 'css';
      const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif'].includes(extension);
        return {
          ...meta,
          severity: isScript || isStyle ? 'critical' : isImage ? 'medium' : 'medium',
          title: 'Missing Resource (404)',
          description:
            'A referenced resource returned 404, which can break functionality or visual assets.',
          recommendation: 'Fix the URL or restore the missing resource.',
          actionability: isScript || isStyle ? 'blocker' : 'actionable'
        };
    }

    if (lower.includes('status of 401') || lower.includes('status of 403')) {
      return {
        ...meta,
        severity: 'medium',
        title: 'Unauthorized Resource (401/403)',
        description:
          'A resource was blocked by authentication or permissions, which may break features or third-party scripts.',
        recommendation: 'Verify permissions or replace the blocked resource.',
        actionability: 'warning'
      };
    }
  }

  if (lower.includes('cors') && lower.includes('blocked')) {
      return {
        ...meta,
        severity: 'medium',
        title: 'CORS Blocked Resource',
        description:
          'A browser CORS restriction blocked a request, which may break third-party integrations.',
        recommendation: 'Ensure the resource sends proper CORS headers or load it from the same origin.',
        actionability: 'warning'
      };
  }

  if (lower.includes('the site not found in the alli ai database')) {
      return {
        ...meta,
        severity: 'ignore',
        title: 'Third-party Widget Error',
        description:
          'A third-party widget reported a missing site configuration. This may be noise but can clutter the console.',
        recommendation: 'Remove or reconfigure the widget if unused.',
        ownership: 'third_party',
        actionability: 'info'
      };
  }

  if (lower.includes('net::err_failed')) {
      return {
        ...meta,
        severity: 'medium',
        title: 'Network Request Failed',
        description:
          'A network request failed to load. This may affect third-party scripts or assets.',
        recommendation: 'Check network availability and resource URLs.',
        actionability: 'warning'
      };
  }

  if (lower.includes('cookieyes') || lower.includes('yoshki') || lower.includes('intercom') || lower.includes('tawk')) {
    return {
      ...meta,
      severity: 'medium',
      title: 'Third-party Widget Error',
      description:
        'A third-party widget emitted a console error. This is tracked but not treated as a blocker by default.',
      recommendation: 'Verify widget configuration only if it impacts a core journey.',
      ownership: 'third_party',
      actionability: 'warning'
    };
  }

  return {
    ...meta,
    severity: 'medium',
    title: 'Console Error',
    description:
      'A console error was detected, which may indicate broken functionality or a missing/blocked resource.',
    recommendation: 'Investigate the console error to identify the failing script or asset.'
  };
}

function classifyPageError(message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  if (lower.includes('grecaptcha') || lower.includes('recaptcha')) {
    return {
      severity: 'critical',
      title: 'reCAPTCHA Runtime Error',
      description:
        'A runtime error occurred in reCAPTCHA which may break form submissions.',
      recommendation: 'Verify reCAPTCHA scripts and configuration.',
      ownership: 'third_party',
      actionability: 'actionable'
    };
  }
  if (
    lower.includes('getcontext') ||
    lower.includes('canvas') ||
    lower.includes('cookieyes') ||
    lower.includes('yoshki') ||
    lower.includes('intercom') ||
    lower.includes('tawk')
  ) {
    return {
      severity: 'major',
      title: 'Third-party Runtime Error',
      description: 'A runtime error occurred in a third-party integration.',
      recommendation: 'Validate the integration only if it affects form, navigation, or key CTA journeys.',
      ownership: 'third_party',
      actionability: 'warning'
    };
  }
  return {
    severity: 'major',
    title: 'Page Runtime Error',
    description: 'A JavaScript runtime error occurred and may break interactive components.',
    recommendation: 'Fix the underlying script error and verify in production.',
    ownership: 'first_party',
    actionability: 'actionable'
  };
}

function isAllowlisted(message, allowlist) {
  if (!message || allowlist.length === 0) return false;
  const text = String(message);
  return allowlist.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(text);
    } catch {
      return text.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function shouldIgnoreClassification(classification) {
  return classification && classification.severity === 'ignore';
}

function classificationCausesFailure(classification, threshold) {
  if (!classification || classification.allowlisted) return false;
  if (QA_PROFILE === 'engineering-deep') {
    return severityMeetsThreshold(classification.severity, threshold);
  }
  if (classification.actionability === 'blocker') return true;
  if (classification.ownership === 'first_party' && classification.actionability === 'actionable') return true;
  return false;
}

function buildImageSelectors(urls) {
  return urls.flatMap((src) => [
    `img[src="${src}"]`,
    `img[data-src="${src}"]`,
    `img[srcset*="${src}"]`
  ]);
}

function buildLinkSelectors(urls) {
  return urls.map((href) => `a[href="${href}"]`);
}

function filterGlobalAxeIssues(issueRows, summary, totalUrls) {
  if (!totalUrls) return issueRows;
  const globalAxeKeys = new Set();
  for (const [key, value] of summary.entries()) {
    const isGlobal = value.Count / totalUrls >= 0.7;
    if (isGlobal && value.Category === 'accessibility' && value._source === 'axe') {
      globalAxeKeys.add(key);
    }
  }
  if (globalAxeKeys.size === 0) return issueRows;
  return issueRows.filter((row) => {
    if (row._source !== 'axe') return true;
    const key = issueKey(row);
    return !globalAxeKeys.has(key);
  });
}

async function highlightElements(page, selectors) {
  const unique = Array.from(new Set(selectors.filter(Boolean)));
  if (unique.length === 0) return 0;
  await page.evaluate(() => {
    if (!document.querySelector('style[data-qa-outline-style]')) {
      const style = document.createElement('style');
      style.setAttribute('data-qa-outline-style', 'true');
      style.textContent = '[data-qa-outline=\"true\"]{outline:4px solid red !important; outline-offset:2px !important;}';
      document.head.appendChild(style);
    }
  });
  return page.evaluate((targets) => {
    let count = 0;
    targets.forEach((selector) => {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el) => {
          el.setAttribute('data-qa-outline', 'true');
          count += 1;
        });
      } catch {
        // ignore invalid selectors
      }
    });
    return count;
  }, unique);
}

async function clearHighlights(page) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-qa-outline=\"true\"]').forEach((el) => {
      el.removeAttribute('data-qa-outline');
    });
    const style = document.querySelector('style[data-qa-outline-style]');
    if (style) style.remove();
  }).catch(() => {});
}

async function stabilizePage(page) {
  try {
    await page.evaluate(() => {
      if (!document.querySelector('style[data-qa-stabilize]')) {
        const style = document.createElement('style');
        style.setAttribute('data-qa-stabilize', 'true');
        style.textContent = `
          *, *::before, *::after { animation: none !important; transition: none !important; }
          video, iframe { opacity: 0.01 !important; }
          [aria-busy="true"] { animation: none !important; }
        `;
        document.head.appendChild(style);
      }
    });
    await page.evaluate(async () => {
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map(
          (img) =>
            img.complete ||
            new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
        )
      );
    });
  } catch {
    // best effort
  }
}

async function captureIssueScreenshot(page, url, projectName, issueSlug, selectors) {
  if (SCREENSHOTS_LIMIT > 0 && screenshotCounter >= SCREENSHOTS_LIMIT) return null;
  await stabilizePage(page);
  const count = await highlightElements(page, selectors);
  if (count === 0) return null;
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  screenshotCounter += 1;
  const screenshotName = `${projectName}-${issueSlug}-${String(screenshotCounter).padStart(2, '0')}.png`;
  const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await clearHighlights(page);
  return path.relative(process.cwd(), screenshotPath);
}

function slugifyUrl(url) {
  const parsed = new URL(url);
  const safePath = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = safePath ? `${parsed.hostname}_${safePath}` : parsed.hostname;
  return base || 'lighthouse';
}

function isRetryableLinkError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('econnreset') ||
    text.includes('enetunreach') ||
    text.includes('ehostunreach') ||
    text.includes('err_') ||
    text.includes('network')
  );
}

async function fetchLinkStatus(request, url) {
  let attempt = 0;
  const maxAttempts = 2;
  while (attempt < maxAttempts) {
    try {
      const response = await request.get(url, { timeout: LINK_CHECK_TIMEOUT_MS });
      const status = response.status();
      if (status >= 400) {
        return { kind: 'broken', url, status, error: '' };
      }
      return { kind: 'ok', url, status, error: '' };
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryableLinkError(error)) {
        return { kind: 'error', url, status: 0, error: String(error?.message || error || 'Unknown error') };
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  return { kind: 'error', url, status: 0, error: 'Unknown link-check failure' };
}

async function collectBrokenLinks(page, request) {
  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors.map((a) => a.getAttribute('href'))
  );
  const pageUrl = page.url();
  const baseUrl = new URL(pageUrl);
  const filtered = hrefs
    .filter(Boolean)
    .map((href) => href.trim())
    .filter((href) => href.length > 0)
    .filter((href) =>
      !href.startsWith('#') &&
      !href.startsWith('mailto:') &&
      !href.startsWith('tel:') &&
      !href.startsWith('javascript:') &&
      !href.startsWith('data:')
    )
    .map((href) => {
      try {
        return new URL(href, pageUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((href) => {
      if (!href) return false;
      if (LINK_ALLOWLIST.length && LINK_ALLOWLIST.some((pattern) => href.includes(pattern))) return false;
      return true;
    })
    .filter((href) => {
      if (!href) return false;
      if (LINK_SCOPE !== 'internal') return true;
      try {
        return new URL(href).origin === baseUrl.origin;
      } catch {
        return false;
      }
    })
    .filter(Boolean);

  const unique = Array.from(new Set(filtered));
  const broken = [];
  const errors = [];
  let index = 0;

  async function worker() {
    while (index < unique.length) {
      const current = unique[index++];
      if (linkStatusCache.has(current)) {
        const cached = linkStatusCache.get(current);
        if (cached.kind === 'broken') {
          broken.push({ url: cached.url, status: cached.status });
        } else if (cached.kind === 'error') {
          errors.push({ url: cached.url, status: cached.status, error: cached.error });
        }
        continue;
      }

      const checked = await fetchLinkStatus(request, current);
      linkStatusCache.set(current, checked);
      if (checked.kind === 'broken') {
        broken.push({ url: checked.url, status: checked.status });
      } else if (checked.kind === 'error') {
        errors.push({ url: checked.url, status: checked.status, error: checked.error });
      }
    }
  }

  const workerCount = Math.min(LINK_CHECK_CONCURRENCY, unique.length || 1);
  await Promise.all(new Array(workerCount).fill(0).map(() => worker()));

  return { broken, errors };
}

async function collectMissingAltImages(page) {
  const missing = await page.$$eval('img', (images) =>
    images
      .filter((img) => !img.hasAttribute('alt') || img.getAttribute('alt').trim() === '')
      .map((img) =>
        img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset') || ''
      )
  );
  return Array.from(new Set(missing.filter(Boolean)));
}

async function collectBrokenImages(page) {
  const broken = await page.$$eval('img', (images) =>
    images
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '')
  );
  return Array.from(new Set(broken.filter(Boolean)));
}

function hashString(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

async function resolveTemplateNameFromRest(page, restBase) {
  try {
    const url = page.url();
    const parsed = new URL(url);
    const slug = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'home';
    const apiBase = restBase.replace(/\/+$/, '');
    const endpoints = [
      `${apiBase}/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}`,
      `${apiBase}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}`,
      `${apiBase}/wp-json/wp/v2/templates`
    ];
    for (const endpoint of endpoints) {
      const res = await page.request.get(endpoint, { timeout: 8000 });
      if (!res.ok()) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        if (item.template && typeof item.template === 'string' && item.template.length > 0) {
          return item.template;
        }
        if (item.title && item.title.rendered) {
          return item.title.rendered.replace(/<[^>]+>/g, '').trim();
        }
      }
      if (data && data.slug && data.title && data.title.rendered) {
        return data.title.rendered.replace(/<[^>]+>/g, '').trim();
      }
    }
  } catch {
    // ignore
  }
  return '';
}

async function collectTemplateSignature(page) {
  const signature = await page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll(
        'header, main, footer, .elementor-section, .elementor-container, .elementor-widget, .wp-block, .wp-block-group, .wp-block-columns'
      )
    ).slice(0, 120);

    function cleanClassList(className) {
      if (!className || typeof className !== 'string') return [];
      return className
        .split(/\s+/)
        .filter(Boolean)
        .filter((cls) => !cls.startsWith('elementor-element-'))
        .filter((cls) => !/^[a-z]+-\d+$/.test(cls))
        .slice(0, 3);
    }

    const tokens = elements.map((el) => {
      const tag = el.tagName.toLowerCase();
      const classes = cleanClassList(el.className || '');
      return `${tag}.${classes.join('.')}`;
    });

    return tokens.join('|').slice(0, 8000);
  }).catch(() => '');

  if (!signature) return '';
  return `tpl_${hashString(signature)}`;
}

async function collectLayoutMisuse(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const fixedWidth = [];
    const wideContainers = [];
    const missingPadding = [];

    const candidates = Array.from(
      document.querySelectorAll('.elementor-section, .elementor-container, section, .wp-block-group, .wp-block-columns')
    ).slice(0, 600);

    const toSelector = (el) => {
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\s+/).slice(0, 3).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      }
      return el.tagName.toLowerCase();
    };

    candidates.forEach((el) => {
      const style = window.getComputedStyle(el);
      const widthPx = parseFloat(style.width || '0');
      const padLeft = parseFloat(style.paddingLeft || '0');
      const padRight = parseFloat(style.paddingRight || '0');

      if (style.width && style.width.endsWith('px') && widthPx > vw + 1) {
        fixedWidth.push(toSelector(el));
      }

      if (el.scrollWidth > vw + 1 || widthPx > vw + 1) {
        wideContainers.push(toSelector(el));
      }

      if (widthPx >= vw - 2 && padLeft < 6 && padRight < 6) {
        missingPadding.push(toSelector(el));
      }
    });

    const unique = (arr) => Array.from(new Set(arr)).filter(Boolean);
    return {
      fixedWidth: unique(fixedWidth),
      wideContainers: unique(wideContainers),
      missingPadding: unique(missingPadding)
    };
  });
}

async function detectBlockingModal(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const elements = Array.from(document.body.querySelectorAll('*')).slice(0, 2000);

    function isVisible(el, style) {
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const opacity = parseFloat(style.opacity || '1');
      if (opacity < 0.2) return false;
      return true;
    }

    function toSelector(el) {
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\s+/).slice(0, 3).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      }
      return el.tagName.toLowerCase();
    }

    let candidate = null;
    let maxArea = 0;

    elements.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed') return;
      if (!isVisible(el, style)) return;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.width < vw * 0.5 || rect.height < vh * 0.4) return;
      const zIndex = parseInt(style.zIndex || '0', 10);
      if (Number.isNaN(zIndex) || zIndex < 10) return;
      if (area > maxArea) {
        maxArea = area;
        candidate = { selector: toSelector(el), zIndex };
      }
    });

    if (!candidate) return { blocked: false, selector: '' };
    return { blocked: true, selector: candidate.selector, zIndex: candidate.zIndex };
  }).catch(() => ({ blocked: false, selector: '' }));
}

async function collectWordPressSignals(page) {
  return page.evaluate(() => {
    const origin = window.location.origin;
    const title = document.title || '';
    const descriptionEl = document.querySelector('meta[name=\"description\"]');
    const metaDescription = descriptionEl ? (descriptionEl.getAttribute('content') || '').trim() : '';
    const viewportEl = document.querySelector('meta[name=\"viewport\"]');
    const viewport = viewportEl ? (viewportEl.getAttribute('content') || '').trim() : '';
    const jsonLd = Array.from(document.querySelectorAll('script[type=\"application/ld+json\"]'))
      .map((node) => node.textContent || '')
      .filter((text) => text.trim().length > 0);

    const externalLinks = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ href: a.getAttribute('href') || '', target: a.getAttribute('target') || '' }))
      .filter((link) => link.href.startsWith('http'))
      .filter((link) => !link.href.startsWith(origin));

    const externalMissingBlank = externalLinks
      .filter((link) => link.target.toLowerCase() !== '_blank')
      .map((link) => link.href);

    const internalBlank = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({ href: a.getAttribute('href') || '', target: a.getAttribute('target') || '' }))
      .filter((link) => link.href.startsWith(origin))
      .filter((link) => link.target.toLowerCase() === '_blank')
      .map((link) => link.href);

    const telLinks = Array.from(document.querySelectorAll('a[href^=\"tel:\"]')).map((a) => a.getAttribute('href') || '');

    const bodyText = document.body ? document.body.innerText || '' : '';
    const phoneMatches = bodyText.match(/(\\+?\\d[\\d\\s().-]{6,}\\d)/g) || [];
    const phoneNumbers = Array.from(new Set(phoneMatches.map((m) => m.trim())));

    const imagesMissingLazy = Array.from(document.querySelectorAll('img'))
      .filter((img) => !img.hasAttribute('loading'))
      .map((img) => img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '');

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((el) => ({
      level: Number(el.tagName.substring(1)),
      text: (el.textContent || '').trim().slice(0, 80)
    }));
    let headingSkip = null;
    for (let i = 1; i < headings.length; i += 1) {
      if (headings[i].level - headings[i - 1].level > 1) {
        headingSkip = { from: headings[i - 1], to: headings[i] };
        break;
      }
    }

    const schemaTypes = (() => {
      const types = new Set();
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20);
      const addTypes = (obj) => {
        if (!obj) return;
        if (Array.isArray(obj)) {
          obj.forEach(addTypes);
          return;
        }
        const t = obj['@type'];
        if (typeof t === 'string') types.add(t);
        if (Array.isArray(t)) t.forEach((v) => typeof v === 'string' && types.add(v));
        Object.values(obj).forEach((v) => {
          if (v && typeof v === 'object') addTypes(v);
        });
      };
      scripts.forEach((s) => {
        try {
          const json = JSON.parse(s.textContent || '{}');
          addTypes(json);
        } catch {
          // ignore invalid JSON
        }
      });
      return Array.from(types);
    })();

    const navMissingAria = (() => {
      const navs = Array.from(document.querySelectorAll('nav')).slice(0, 50);
      const missing = [];
      navs.forEach((nav, idx) => {
        const hasRole = (nav.getAttribute('role') || '').toLowerCase() === 'navigation';
        const hasLabel = (nav.getAttribute('aria-label') || '').trim().length > 0;
        if (!hasRole && !hasLabel) {
          if (nav.id) missing.push(`nav#${nav.id}`);
          else if (nav.className) missing.push(`nav.${nav.className.split(/\\s+/).slice(0, 2).join('.')}`);
          else missing.push(`nav:nth-of-type(${idx + 1})`);
        }
      });
      return Array.from(new Set(missing));
    })();

    const anchorMissingTargets = (() => {
      const anchors = Array.from(document.querySelectorAll('a[href^="#"]')).slice(0, 200);
      const missing = [];
      anchors.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const id = href.replace(/^#/, '').trim();
        if (!id) return;
        if (!document.getElementById(id)) missing.push(href);
      });
      return Array.from(new Set(missing));
    })();

    const cachingHints = (() => {
      const tokens = new Set();
      const urls = [];
      document.querySelectorAll('script,link').forEach((el) => {
        ['src', 'href'].forEach((attr) => {
          const v = el.getAttribute(attr);
          if (v) urls.push(v.toLowerCase());
        });
      });
      const patterns = [
        { pat: 'autoptimize', label: 'Autoptimize' },
        { pat: 'litespeed', label: 'LiteSpeed/LSCache' },
        { pat: 'wp-content/cache', label: 'WP cache assets' },
        { pat: 'w3tc', label: 'W3 Total Cache' },
        { pat: 'nitropack', label: 'NitroPack' },
        { pat: 'swis', label: 'SWIS Performance' }
      ];
      urls.forEach((u) => {
        patterns.forEach((p) => {
          if (u.includes(p.pat)) tokens.add(p.label);
        });
      });
      return Array.from(tokens);
    })();

    const bodyClass = (document.body && document.body.className) || '';
    const templateName =
      (bodyClass.match(/page-template-([a-z0-9-_]+)/i) || [])[1] ||
      (bodyClass.match(/elementor-template-([a-z0-9-_]+)/i) || [])[1] ||
      '';

    const pluginHints = (() => {
      const hints = new Set();
      if (bodyClass.includes('elementor')) hints.add('Elementor');
      if (bodyClass.includes('woocommerce')) hints.add('WooCommerce');
      if (document.querySelector('.wpcf7')) hints.add('Contact Form 7');
      if (document.querySelector('.wpforms')) hints.add('WPForms');
      if (document.querySelector('.gform_wrapper')) hints.add('Gravity Forms');
      if (document.querySelector('.forminator-ui')) hints.add('Forminator');
      if (document.querySelector('.rank-math-schema')) hints.add('Rank Math');
      if (document.querySelector('script[data-schema-yaost]') || bodyClass.includes('yoast')) hints.add('Yoast');
      return Array.from(hints);
    })();

    const themeHints = (() => {
      const hints = new Set();
      if (bodyClass.includes('astra')) hints.add('Astra');
      if (bodyClass.includes('hello-elementor')) hints.add('Hello Elementor');
      if (bodyClass.includes('generatepress')) hints.add('GeneratePress');
      if (bodyClass.includes('kadence')) hints.add('Kadence');
      return Array.from(hints);
    })();

    return {
      title,
      metaDescription,
      viewport,
      hasJsonLd: jsonLd.length > 0,
      externalMissingBlank: Array.from(new Set(externalMissingBlank)).filter(Boolean),
      internalBlank: Array.from(new Set(internalBlank)).filter(Boolean),
      telLinks: Array.from(new Set(telLinks)).filter(Boolean),
      phoneNumbers,
      imagesMissingLazy: Array.from(new Set(imagesMissingLazy)).filter(Boolean),
      headingSkip,
      schemaTypes,
      navMissingAria,
      anchorMissingTargets,
      cachingHints,
      templateName,
      pluginHints,
      themeHints
    };
  });
}

async function checkHoverStates(page) {
  const selector = 'button, a.button, a.elementor-button, input[type=\"submit\"], input[type=\"button\"]';
  const locator = page.locator(selector);
  const total = await locator.count();
  const count = Math.min(total, Math.max(MAX_SAMPLES * 4, 12));
  const issues = [];
  const ignoreContainerSelector = [
    '[id*=\"cookie\"]',
    '[class*=\"cookie\"]',
    '[id*=\"consent\"]',
    '[class*=\"consent\"]',
    '[id*=\"chat\"]',
    '[class*=\"chat\"]',
    'footer',
    '[role=\"dialog\"]'
  ].join(',');

  for (let i = 0; i < count; i += 1) {
    const handle = locator.nth(i);
    const isVisible = await handle.isVisible().catch(() => false);
    if (!isVisible) continue;
    const eligible = await handle
      .evaluate((el, ignoreSelector) => {
        if (!el || el.disabled) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.closest(ignoreSelector)) return false;
        return true;
      }, ignoreContainerSelector)
      .catch(() => false);
    if (!eligible) continue;
    const box = await handle.boundingBox().catch(() => null);
    if (!box) continue;
    const centerY = box.y + box.height / 2;
    const viewport = page.viewportSize();
    if (viewport && (centerY < viewport.height * 0.12 || centerY > viewport.height * 0.9)) continue;
    const descriptor = await handle.evaluate((el) => {
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.split(/\s+/).slice(0, 3).join('.');
        return `${el.tagName.toLowerCase()}.${classes}`;
      }
      return el.tagName.toLowerCase();
    });

    const before = await handle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        textDecoration: style.textDecoration
      };
    });

    await handle.hover().catch(() => {});

    const after = await handle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        textDecoration: style.textDecoration
      };
    });

    const changed =
      before.color !== after.color ||
      before.backgroundColor !== after.backgroundColor ||
      before.borderColor !== after.borderColor ||
      before.boxShadow !== after.boxShadow ||
      before.textDecoration !== after.textDecoration;

    if (!changed) {
      issues.push({ selector: descriptor });
      if (issues.length >= MAX_SAMPLES) {
        break;
      }
    }
  }

  return issues;
}

function isRetryableNavError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('net::err_connection_timed_out') ||
    text.includes('net::err_connection_reset') ||
    text.includes('net::err_connection_refused') ||
    text.includes('net::err_name_not_resolved') ||
    text.includes('net::err_network_changed') ||
    text.includes('timeout') ||
    text.includes('navigation') && text.includes('timeout')
  );
}

function blockedReasonFromError(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return 'Unknown navigation error';
  // Keep it short for CSV + reporting.
  return message.split('\n')[0].slice(0, 240);
}

function buildBlockedPatternRegex() {
  // Patterns come from env and may not be safe regex; treat as case-insensitive substring match.
  const lowered = BLOCKED_CONTENT_PATTERNS.map((p) => p.toLowerCase());
  return lowered;
}

async function detectBlockedContent(page) {
  const patterns = buildBlockedPatternRegex();
  const data = await page
    .evaluate((maxChars) => {
      const title = document.title || '';
      const text = (document.body && document.body.innerText ? document.body.innerText : '') || '';
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const hasWp = html.includes('wp-content') || html.includes('wp-includes');
      const hasElementor = html.includes('elementor') || html.includes('Elementor');
      return { title, snippet, hasWp, hasElementor };
    }, BLOCKED_SNIPPET_CHARS)
    .catch(() => ({ title: '', snippet: '', hasWp: false, hasElementor: false }));

  const haystack = `${data.title}\n${data.snippet}`.toLowerCase();
  const matched = patterns.find((p) => p && haystack.includes(p));
  if (matched) {
    return { blocked: true, signature: matched, ...data };
  }

  // Heuristic: WordPress URL but no WP markers at all (often hosting placeholder page).
  const url = page.url() || '';
  const looksWp =
    url.includes('/wp-') ||
    url.includes('/wordpress') ||
    url.includes('/wp-admin') ||
    url.includes('/wp-content') ||
    url.includes('/wp-login');
  if (looksWp && !data.hasWp && !data.hasElementor) {
    return { blocked: true, signature: 'missing-wp-markers', ...data };
  }

  return { blocked: false, signature: '', ...data };
}

async function tryBypassTechnicalDomain(page) {
  // Some cPanel "Technical Domain" pages are an interstitial that can be dismissed
  // (sets a cookie) to view the actual site. If we can bypass it, we can proceed
  // with QA; otherwise we must mark the URL BLOCKED to avoid false data.
  const title = await page.title().catch(() => '');
  const isTechnicalDomain = String(title || '').toLowerCase().includes('technical domain');
  if (!isTechnicalDomain) return { bypassed: false, response: null };

  // Try common interstitial "I understand" checkbox + CTA flow.
  const checkboxCandidates = [
    'input[type="checkbox"]',
    'input[type="checkbox"][name*="accept" i]',
    'input[type="checkbox"][id*="accept" i]'
  ];

  for (const sel of checkboxCandidates) {
    const cb = page.locator(sel).first();
    const visible = await cb.isVisible().catch(() => false);
    if (!visible) continue;
    await cb.check({ timeout: 5000 }).catch(() => cb.click().catch(() => {}));
    break;
  }

  // Try common interstitial CTAs.
  const candidates = [
    'text=/^(continue|proceed|open website|enter|i understand|accept|view website)$/i',
    'text=/continue|proceed|open website|enter|i understand|accept|view website/i',
    'a:has-text("Continue")',
    'button:has-text("Continue")'
  ];

  for (const sel of candidates) {
    const locator = page.locator(sel).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;

    // Clicking often triggers either navigation or cookie set + DOM update.
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
    await locator.click({ timeout: 15000 }).catch(() => {});
    const response = await nav;

    // Reload to get a clean main-document response (status codes on interstitials are often 428).
    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // If the content no longer looks blocked, we consider it bypassed.
    const detect = await detectBlockedContent(page);
    if (!detect.blocked) {
      return { bypassed: true, response: reloadResponse || response };
    }
  }

  return { bypassed: false, response: null };
}

async function gotoWithRetries(page, url, options, retries) {
  let attempt = 0;
  let lastError = null;
  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);

  while (attempt < maxAttempts) {
    try {
      return await page.goto(url, options);
    } catch (error) {
      lastError = error;
      if (!isRetryableNavError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      const backoffMs = attempt === 0 ? 500 : 1500;
      await page.waitForTimeout(backoffMs);
    } finally {
      attempt += 1;
    }
  }

  throw lastError || new Error('Navigation failed');
}

function humanizedDesktopProfile() {
  return {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1365, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-GB,en;q=0.9',
      DNT: '1',
      'Upgrade-Insecure-Requests': '1'
    }
  };
}

function resolveChromiumExecutablePath() {
  const candidate = chromium.executablePath();
  if (candidate && fs.existsSync(candidate)) return candidate;
  // On Apple Silicon, Playwright may sometimes report an x64 path even if only arm64 was downloaded.
  if (candidate && candidate.includes('chrome-mac-x64')) {
    const alt = candidate.replace('chrome-mac-x64', 'chrome-mac-arm64');
    if (fs.existsSync(alt)) return alt;
  }
  return candidate;
}

async function captureBlockedEvidence(page, url, projectName, reason, detection) {
  blockedSamples.push({
    url,
    finalUrl: page.url(),
    project: projectName,
    blockedReason: reason,
    title: detection?.title || '',
    snippet: detection?.snippet || ''
  });

  if (SCREENSHOTS_MODE !== 'issues' || SCREENSHOTS_LIMIT <= 0) return '';
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  screenshotCounter += 1;
  const name = `${projectName}-blocked-${screenshotCounter}.png`;
  const screenshotPath = path.join(SCREENSHOTS_DIR, name);
  await stabilizePage(page);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return path.relative(process.cwd(), screenshotPath);
}

const FORM_SUCCESS_SELECTORS = [
  // Contact Form 7
  '.wpcf7 form.sent .wpcf7-response-output',
  '.wpcf7-response-output',
  // WPForms
  '.wpforms-confirmation-container',
  // Gravity
  '.gform_confirmation_message',
  // Elementor
  '.elementor-message-success',
  // Forminator
  '.forminator-response-message--success',
  // Ninja Forms
  '.nf-response-msg'
];
const FORM_SUCCESS_OVERRIDE = (process.env.FORM_SUCCESS_OVERRIDE || '')
  .split('|')
  .map((s) => s.trim())
  .filter(Boolean);
const FORM_SUCCESS_MATCHERS = FORM_SUCCESS_OVERRIDE.length
  ? [...FORM_SUCCESS_SELECTORS, ...FORM_SUCCESS_OVERRIDE]
  : FORM_SUCCESS_SELECTORS;
const REST_BASE = (process.env.REST_BASE || '').trim();
let restTypesCache = null;
async function getRestTypes(page) {
  if (!REST_BASE) return null;
  if (restTypesCache) return restTypesCache;
  try {
    const response = await page.request.get(`${REST_BASE.replace(/\/+$/, '')}/wp-json/wp/v2/types`, {
      timeout: 8000
    });
    if (!response.ok()) return null;
    const json = await response.json();
    restTypesCache = json;
    return json;
  } catch {
    return null;
  }
}

function mapRestTypesToTemplates(restTypes) {
  if (!restTypes) return null;
  const templates = new Map();
  Object.entries(restTypes).forEach(([key, value]) => {
    const slug = key.toLowerCase();
    if (slug === 'page') templates.set('tpl_page', value);
    else if (slug === 'post') templates.set('tpl_post', value);
    else if (slug.includes('product')) templates.set('tpl_product', value);
    else templates.set(`tpl_${slug}`, value);
  });
  return templates;
}

function buildTemplateSampleSet(urls) {
  const samples = new Set();
  if (urls.length > 0) samples.add(urls[0]);
  const pickFirst = (predicate) => {
    for (const target of urls) {
      if (predicate(target.toLowerCase())) {
        samples.add(target);
        break;
      }
    }
  };
  pickFirst((url) => url.includes('/services/'));
  pickFirst((url) => url.includes('/blog/') || url.includes('/news/'));
  pickFirst((url) => url.includes('/contact'));
  return samples;
}

const FORM_ERROR_SELECTORS = [
  // Contact Form 7
  '.wpcf7 form.invalid .wpcf7-response-output',
  '.wpcf7-not-valid-tip',
  // WPForms
  '.wpforms-error',
  // Gravity
  '.gform_validation_errors',
  // Elementor
  '.elementor-message-danger',
  // Forminator
  '.forminator-response-message--error',
  // Ninja Forms
  '.nf-error-msg, .nf-form-errors'
];

function findFrameForForm(page, form) {
  if (!form || !form.frameUrl) return null;
  const targetUrl = String(form.frameUrl || '');
  const targetName = String(form.frameName || '');

  // Prefer exact URL match; fall back to prefix match for dynamic params.
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  let match = frames.find((f) => f.url() === targetUrl);
  if (!match && targetUrl) {
    match = frames.find((f) => f.url() && (f.url().startsWith(targetUrl) || targetUrl.startsWith(f.url())));
  }
  if (!match && targetName) {
    match = frames.find((f) => (f.name && f.name() === targetName) || false);
  }
  return match || null;
}

function summarizeFormDiagnostics(formCheck) {
  const diagnostics = formCheck && typeof formCheck === 'object' ? formCheck.diagnostics : null;
  if (!diagnostics || typeof diagnostics !== 'object') return '';
  const parts = [];
  if (typeof diagnostics.mainContextForms === 'number') {
    parts.push(`main-context forms=${diagnostics.mainContextForms}`);
  }
  if (typeof diagnostics.iframeContextForms === 'number') {
    parts.push(`iframe forms=${diagnostics.iframeContextForms}`);
  }
  if (typeof diagnostics.embeddedFrameCandidates === 'number') {
    parts.push(`embedded-form iframes=${diagnostics.embeddedFrameCandidates}`);
  }
  if (typeof diagnostics.pageFrames === 'number') {
    parts.push(`frames scanned=${diagnostics.pageFrames}`);
  }
  if (Array.isArray(diagnostics.embeddedFrameSamples) && diagnostics.embeddedFrameSamples.length > 0) {
    parts.push(`embedded samples=${diagnostics.embeddedFrameSamples.slice(0, MAX_SAMPLES).join(', ')}`);
  }
  if (Array.isArray(diagnostics.frameScanErrors) && diagnostics.frameScanErrors.length > 0) {
    parts.push(`frame scan errors=${diagnostics.frameScanErrors.slice(0, MAX_SAMPLES).join(', ')}`);
  }
  return parts.join(' | ');
}

async function submitFormsAndAwaitResult(page, formCheck) {
  if (!formCheck || !Array.isArray(formCheck.results)) {
    return { submitted: 0, success: 0, failed: 0, sample: '', failures: [] };
  }
  const toSubmit = formCheck.results.filter((r) => !r.skipped);
  let submitted = 0;
  let success = 0;
  let failed = 0;
  const samples = [];
  const failures = [];

  for (const form of toSubmit.slice(0, MAX_SAMPLES)) {
    const frame = findFrameForForm(page, form);
    const ctx = frame || page;
    const formLocator = ctx.locator(form.selector);
    const visible = await formLocator.first().isVisible().catch(() => false);
    if (!visible) continue;

    // Prefer explicit submit buttons inside the form.
    const submitButton = formLocator.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    const canClick = await submitButton.isVisible().catch(() => false);
    if (!canClick) {
      const detail = `${form.plugin || 'Form'} (${form.selector}): no submit button found`;
      samples.push(detail);
      failures.push({
        plugin: form.plugin || 'Form',
        selector: form.selector,
        frameUrl: form.frameUrl || '',
        reason: 'no-submit-button',
        message: detail
      });
      failed += 1;
      continue;
    }

    // Click submit and wait for either a success or error indicator.
    await submitButton.click({ timeout: 15000 }).catch(() => {});
    submitted += 1;

    const scopedSuccess = FORM_SUCCESS_SELECTORS.map((s) => `${form.selector} ${s}`);
    const scopedError = FORM_ERROR_SELECTORS.map((s) => `${form.selector} ${s}`);
    const successLocator = ctx.locator(scopedSuccess.join(', '));
    const errorLocator = ctx.locator(scopedError.join(', '));

    // Some plugins render messages outside the form; also check globally.
    const globalSuccess = ctx.locator(FORM_SUCCESS_SELECTORS.join(', '));
    const globalError = ctx.locator(FORM_ERROR_SELECTORS.join(', '));

    const outcome = await Promise.race([
      successLocator.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => 'success').catch(() => null),
      errorLocator.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => 'error').catch(() => null),
      globalSuccess.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => 'success').catch(() => null),
      globalError.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => 'error').catch(() => null),
      ctx.waitForTimeout(15000).then(() => 'timeout')
    ]);

    if (outcome === 'success') {
      success += 1;
      continue;
    }

    failed += 1;
    // Capture a useful sample message (best-effort).
    const message =
      (await errorLocator.first().textContent().catch(() => null)) ||
      (await globalError.first().textContent().catch(() => null)) ||
      (outcome === 'timeout' ? 'no success/error message detected' : 'submission failed');
    const normalized = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const detail = `${form.plugin || 'Form'} (${form.selector}): ${normalized}`;
    samples.push(detail);
    failures.push({
      plugin: form.plugin || 'Form',
      selector: form.selector,
      frameUrl: form.frameUrl || '',
      reason: outcome || 'failed',
      message: normalized
    });
  }

  return { submitted, success, failed, sample: samples.join(' | '), failures };
}

async function checkMobileViewport(page, url) {
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  // Avoid re-navigating (major source of flakiness on staging). Responsive layout should update on resize.
  await page.waitForTimeout(750);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const viewport = await page.evaluate(() => {
    const meta = document.querySelector('meta[name=\"viewport\"]');
    return meta ? meta.getAttribute('content') || '' : '';
  });

  let navFullWidth = true;
  const menuToggle = page.locator(
    'button[aria-label*=\"menu\"], .elementor-menu-toggle, .menu-toggle, .navbar-toggle'
  );
  if (await menuToggle.first().isVisible().catch(() => false)) {
    await menuToggle.first().click().catch(() => {});
    await page.waitForTimeout(500);
    const panel = page.locator(
      '.elementor-nav-menu--dropdown, nav[aria-expanded=\"true\"], .menu, .elementor-nav-menu__container'
    );
    const panelBox = await panel.first().boundingBox().catch(() => null);
    const width = panelBox ? panelBox.width : 0;
    navFullWidth = width >= 330;
  }

  if (previous) {
    await page.setViewportSize(previous);
    await page.waitForTimeout(250);
  }

  return { overflow, viewport, navFullWidth };
}

async function validateFormsInContext(context, submitMode) {
  return context.evaluate(({ submitMode, successMatchers }) => {
    const results = [];
    const forms = [];
    const seenForms = new Set();
    const seenRoots = new Set();
    const runToken = `wplg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    function collectForms(root) {
      if (!root || seenRoots.has(root)) return;
      seenRoots.add(root);

      const scopedForms = Array.from(root.querySelectorAll ? root.querySelectorAll('form') : []);
      for (const form of scopedForms) {
        if (seenForms.has(form)) continue;
        seenForms.add(form);
        forms.push(form);
      }

      const hosts = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
      for (const host of hosts) {
        if (host && host.shadowRoot) collectForms(host.shadowRoot);
      }
    }

    collectForms(document);

    function getFormSelector(form, index) {
      const existing = String(form.getAttribute('data-wplg-form-key') || '').trim();
      const key = existing || `${runToken}-${index + 1}`;
      form.setAttribute('data-wplg-form-key', key);
      return `form[data-wplg-form-key="${key}"]`;
    }

    function fieldSignature(el) {
      return [
        el.name || '',
        el.id || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('autocomplete') || ''
      ]
        .join(' ')
        .toLowerCase();
    }

    function assignTextValue(signature) {
      if (/first|fname|given/.test(signature)) return 'Alex';
      if (/last|lname|family|surname/.test(signature)) return 'Tester';
      if (/full.?name|name/.test(signature)) return 'Alex Tester';
      if (/company|organisation|organization|firm/.test(signature)) return 'QA Test Ltd';
      if (/subject/.test(signature)) return 'Website QA submission test';
      if (/city|town/.test(signature)) return 'London';
      if (/postcode|post code|zip/.test(signature)) return 'SW1A 1AA';
      if (/address/.test(signature)) return '10 QA Street';
      if (/message|enquiry|inquiry|comment|details|describe/.test(signature)) {
        return 'Automated QA form submission verification.';
      }
      return 'QA Test';
    }

    function detectPlugin(form) {
      const parts = [];
      let node = form;
      for (let depth = 0; node && depth < 4; depth += 1) {
        parts.push(node.className || '', node.id || '');
        node = node.parentElement;
      }
      parts.push(form.getAttribute('name') || '', form.getAttribute('action') || '');
      const className = parts.join(' ').toLowerCase();

      if (className.includes('wpcf7') || className.includes('contact-form-7')) return 'Contact Form 7';
      if (className.includes('wpforms')) return 'WPForms';
      if (className.includes('gform') || className.includes('gravityforms')) return 'Gravity Forms';
      if (className.includes('elementor-form')) return 'Elementor';
      if (className.includes('forminator')) return 'Forminator';
      if (className.includes('nf-form') || className.includes('ninja-forms')) return 'Ninja Forms';
      if (className.includes('hubspot') || className.includes('hs-form') || className.includes('hbspt')) {
        return 'HubSpot';
      }
      return 'Generic';
    }

    function looksLikeCaptcha(form) {
      return (
        form.querySelector('.g-recaptcha, .h-captcha, [class*="captcha"], [id*="captcha"]') ||
        form.querySelector(
          'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name*="captcha"]'
        ) ||
        form.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')
      );
    }

    function fillInput(el) {
      if (el instanceof HTMLInputElement) {
        const type = (el.type || 'text').toLowerCase();
        const signature = fieldSignature(el);
        if (type === 'checkbox' || type === 'radio') {
          el.checked = true;
          return;
        }
        if (type === 'email') {
          el.value = 'qa+launchguard@example.com';
          return;
        }
        if (type === 'tel') {
          el.value = '+447700900123';
          return;
        }
        if (type === 'url') {
          el.value = 'https://example.com';
          return;
        }
        if (type === 'number') {
          el.value = '1';
          return;
        }
        if (type === 'password') {
          el.value = 'TestPassword123!';
          return;
        }
        if (type === 'date') {
          el.value = '2025-01-01';
          return;
        }
        if (type === 'time') {
          el.value = '12:00';
          return;
        }
        if (type === 'file') {
          return;
        }
        el.value = assignTextValue(signature);
        return;
      }

      if (el instanceof HTMLTextAreaElement) {
        el.value = assignTextValue(fieldSignature(el));
        return;
      }

      if (el instanceof HTMLSelectElement) {
        const options = Array.from(el.options).filter((opt) => {
          if (opt.disabled) return false;
          const value = String(opt.value || '').trim();
          const text = String(opt.textContent || '').trim();
          if (!value) return false;
          if (/select|choose|please|none/i.test(value) || /select|choose|please|none/i.test(text)) return false;
          return true;
        });
        if (options.length > 0) {
          el.value = options[0].value;
        }
      }
    }

    for (const [index, form] of forms.entries()) {
        const result = {
        selector: getFormSelector(form, index),
        plugin: detectPlugin(form),
        id: form.id || '',
        name: form.getAttribute('name') || '',
        action: form.getAttribute('action') || '',
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        valid: true,
        submitted: false,
        skipped: false,
        skipReason: '',
        invalidFields: [],
        errorMessages: [],
        successMessages: [],
        captchaDetected: false
      };

      if (looksLikeCaptcha(form) && submitMode === 'live') {
        result.captchaDetected = true;
        result.skipped = true;
        result.skipReason = 'captcha';
        results.push(result);
        continue;
      }

      const elements = Array.from(form.elements).filter(
        (el) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      );

      for (const el of elements) {
        if (el.disabled) continue;
        if (el instanceof HTMLInputElement) {
          const type = (el.type || 'text').toLowerCase();
          if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
        }
        fillInput(el);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      form.addEventListener(
        'submit',
        (event) => {
          result.submitted = true;
          if (submitMode === 'dry-run') {
            event.preventDefault();
          }
        },
        { once: true }
      );

      if (!form.checkValidity()) {
        result.valid = false;
        result.invalidFields = elements
          .filter((el) => !el.checkValidity())
          .map((el) => {
            const label = el.name || el.id || el.tagName;
            const message = el.validationMessage || '';
            return message ? `${label}: ${message}` : label;
          });
      }

      // In live mode, we do not submit here because we need Playwright to wait for async responses.
      if (submitMode === 'dry-run') {
        try {
          form.requestSubmit();
        } catch (error) {
          const event = new Event('submit', { bubbles: true, cancelable: true });
          form.dispatchEvent(event);
        }
      }

      const errorSelectors = [
        '.wpcf7-response-output',
        '.wpcf7-not-valid-tip',
        '.wpforms-error',
        '.gform_validation_errors',
        '.elementor-message-danger',
        '.forminator-response-message--error',
        '.nf-error-msg',
        '.nf-form-errors'
      ];

      const successSelectors = [
        ...(Array.isArray(successMatchers) ? successMatchers : [])
      ];

      const scope =
        form.closest(
          '.wpcf7, .wpforms-container, .gform_wrapper, .elementor-widget-container, .forminator-ui, .nf-form-cont, [class*="hubspot"], [class*="hs-form"]'
        ) || form;

      const errors = errorSelectors
        .flatMap((selector) => Array.from(scope.querySelectorAll(selector)))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);

      const successes = successSelectors
        .flatMap((selector) => Array.from(scope.querySelectorAll(selector)))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);

      result.errorMessages = Array.from(new Set(errors));
      result.successMessages = Array.from(new Set(successes));

      results.push(result);
    }

    if (results.length === 0) {
      const hintSelectors = [
        '.wpcf7',
        '.wpforms-container',
        '.gform_wrapper',
        '.elementor-form',
        '.forminator-ui',
        '.nf-form-cont',
        '[class*="hubspot"]',
        '[class*="hs-form"]',
        '[data-form-id]',
        '[data-hs-forms-root]'
      ];
      const seenHints = new Set();
      const hints = hintSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      for (const [index, hint] of hints.entries()) {
        if (!hint || seenHints.has(hint)) continue;
        seenHints.add(hint);
        const id = String(hint.id || '').trim();
        const cls = String(hint.className || '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        const selector =
          id
            ? `${hint.tagName.toLowerCase()}#${id}`
            : cls
            ? `${hint.tagName.toLowerCase()}.${cls}`
            : `${hint.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        results.push({
          selector,
          plugin: detectPlugin(hint),
          id,
          name: '',
          action: '',
          method: 'post',
          valid: true,
          submitted: false,
          skipped: true,
          skipReason: 'form-container-without-form',
          invalidFields: [],
          errorMessages: [],
          successMessages: [],
          captchaDetected: false
        });
      }
    }

    return {
      total: results.length,
      results
    };
  }, { submitMode, successMatchers: FORM_SUCCESS_MATCHERS });
}

async function validateForms(page) {
  const combined = { total: 0, results: [], diagnostics: {} };
  const seenFrameKeys = new Set();
  const diagnostics = {
    mainContextForms: 0,
    iframeContextForms: 0,
    embeddedFrameCandidates: 0,
    embeddedFrameSamples: [],
    frameScanErrors: [],
    pageFrames: 0
  };

  const main = await validateFormsInContext(page, FORM_SUBMIT_MODE).catch(() => ({ total: 0, results: [] }));
  diagnostics.mainContextForms = main.total || 0;
  for (const r of main.results) {
    r.frameUrl = '';
    r.frameName = '';
  }
  combined.total += main.total;
  combined.results.push(...main.results);

  // Include forms inside iframes. This prevents false "no forms found" when forms are embedded.
  // Playwright can inspect cross-origin frames, so we don't need same-origin access.
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  diagnostics.pageFrames = frames.length;
  for (const frame of frames) {
    const frameUrl = frame.url() || '';
    const frameName = typeof frame.name === 'function' ? frame.name() : '';
    // Skip empty frames unless they contain forms (evaluation will tell us).
    const frameResult = await validateFormsInContext(frame, FORM_SUBMIT_MODE).catch((error) => {
      const frameLabel = frameName || frameUrl || 'iframe';
      const detail = `${frameLabel}: ${(error && error.message ? error.message : 'scan failed')}`;
      diagnostics.frameScanErrors.push(detail.slice(0, 180));
      return null;
    });
    if (frameResult && frameResult.total) {
      for (const r of frameResult.results) {
        r.frameUrl = frameUrl;
        r.frameName = frameName;
      }
      diagnostics.iframeContextForms += frameResult.total;
      combined.total += frameResult.total;
      combined.results.push(...frameResult.results);
      continue;
    }

    if (!isLikelyEmbeddedFormFrame(frameUrl, frameName)) continue;
    const key = `${frameName}::${frameUrl}`;
    if (seenFrameKeys.has(key)) continue;
    seenFrameKeys.add(key);
    diagnostics.embeddedFrameCandidates += 1;
    if (diagnostics.embeddedFrameSamples.length < MAX_SAMPLES) {
      diagnostics.embeddedFrameSamples.push(frameName || frameUrl || 'iframe');
    }

    combined.total += 1;
    combined.results.push({
      selector: buildEmbeddedFormSelector(frameUrl, frameName),
      plugin: detectEmbeddedFormProvider(frameUrl, frameName) || 'Embedded Form',
      id: '',
      name: frameName || '',
      action: frameUrl,
      method: 'post',
      valid: true,
      submitted: false,
      skipped: true,
      skipReason: 'embedded-form-iframe',
      invalidFields: [],
      errorMessages: [],
      successMessages: [],
      captchaDetected: false,
      frameUrl,
      frameName
    });
  }

  combined.diagnostics = diagnostics;
  return combined;
}

const lighthouseQueue = [];
let lighthouseActive = 0;

async function withLighthouseSlot(task) {
  if (!LIGHTHOUSE_QUEUE) return task();
  return new Promise((resolve, reject) => {
    const run = () => {
      if (lighthouseActive >= LIGHTHOUSE_WORKERS) {
        lighthouseQueue.push(run);
        return;
      }
      lighthouseActive += 1;
      Promise.resolve()
        .then(task)
        .then((res) => {
          lighthouseActive -= 1;
          const next = lighthouseQueue.shift();
          if (next) next();
          resolve(res);
        })
        .catch((err) => {
          lighthouseActive -= 1;
          const next = lighthouseQueue.shift();
          if (next) next();
          reject(err);
        });
    };
    run();
  });
}

async function runLighthouse(url) {
  fs.mkdirSync(LIGHTHOUSE_DIR, { recursive: true });
  const chromePath = resolveChromiumExecutablePath();
  const chrome = await chromeLauncher.launch({
    chromePath,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const options = {
      logLevel: 'error',
      output: ['html', 'json'],
      port: chrome.port
    };
    const runnerResult = await lighthouse(url, options);
    const reports = Array.isArray(runnerResult.report) ? runnerResult.report : [runnerResult.report];
    const [htmlReport, jsonReport] = reports;
    const slug = slugifyUrl(url);
    const htmlPath = path.join(LIGHTHOUSE_DIR, `${slug}.lighthouse.html`);
    const jsonPath = path.join(LIGHTHOUSE_DIR, `${slug}.lighthouse.json`);
    fs.writeFileSync(htmlPath, htmlReport, 'utf8');
    fs.writeFileSync(jsonPath, jsonReport, 'utf8');

    const categories = runnerResult.lhr.categories || {};
    const scores = {
      performance: Math.round((categories.performance?.score || 0) * 100),
      accessibility: Math.round((categories.accessibility?.score || 0) * 100),
      bestPractices: Math.round((categories['best-practices']?.score || 0) * 100),
      seo: Math.round((categories.seo?.score || 0) * 100)
    };

    return { htmlPath, jsonPath, scores };
  } finally {
    await chrome.kill();
  }
}

const urls = loadUrls();
const lighthouseSampleUrls = buildTemplateSampleSet(urls);

function safeShardPart(value, fallback) {
  const normalized = String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function writeWorkerShard(testInfo, totalInputUrls) {
  fs.mkdirSync(SHARD_DIR, { recursive: true });
  const projectName = safeShardPart(testInfo?.project?.name, 'project');
  const workerIndex = Number.isFinite(testInfo?.workerIndex) ? testInfo.workerIndex : 0;
  const fileName = `${projectName}-w${workerIndex}-p${process.pid}-${Date.now()}.json`;
  const filePath = path.join(SHARD_DIR, fileName);
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runStartedAt: SHARD_RUN_ID,
    client: CLIENT_NAME,
    projectName,
    workerIndex,
    pid: process.pid,
    totalInputUrls: totalInputUrls || 0,
    results,
    issues,
    blockedSamples
  };
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
}

test.describe('WordPress QA suite', () => {
  test.afterAll(async ({}, testInfo) => {
    writeWorkerShard(testInfo, urls.length);
  });

  for (const [index, url] of urls.entries()) {
    test(`QA: ${url}`, async ({ page, request }) => {
      screenshotCounter = 0;
      const projectMeta = test.info().project.metadata || {};
      const viewport = page.viewportSize();
      const result = {
        url,
        browser: projectMeta.browser || test.info().project.name,
        device: projectMeta.device || test.info().project.name,
        viewport: projectMeta.viewport || (viewport ? `${viewport.width}x${viewport.height}` : ''),
        status: 'PASS',
        failReasons: '',
        desktopOverflow: false,
        desktopOverflowSample: '',
        consoleErrors: 0,
        consoleErrorsSample: '',
          pageErrors: 0,
          pageErrorsSample: '',
          brokenLinks: 0,
          brokenLinksSample: '',
          linkCheckErrors: 0,
          linkCheckErrorsSample: '',
          h1Count: 0,
        missingAlt: 0,
        missingAltSample: '',
        brokenImages: 0,
        brokenImagesSample: '',
        externalLinksMissingBlank: 0,
        externalLinksMissingBlankSample: '',
        internalLinksBlank: 0,
        internalLinksBlankSample: '',
        imagesMissingLazy: 0,
        imagesMissingLazySample: '',
        jsonLdPresent: false,
        metaTitle: '',
        metaDescriptionPresent: false,
        viewportMeta: '',
        mobileOverflow: false,
        mobileNavFullWidth: true,
        headingSkip: '',
        modalBlocking: false,
        modalBlockingSample: '',
        formsTotal: 0,
        formsValid: 0,
        formsSubmitted: 0,
        formsSkipped: 0,
        formsFailed: 0,
        formsInvalidSample: '',
        formsIssueSample: '',
        axeViolations: 0,
        axeViolationSample: '',
        lighthousePerformance: '',
        lighthouseAccessibility: '',
        lighthouseBestPractices: '',
        lighthouseSEO: '',
        lighthouseReportHtml: '',
        lighthouseReportJson: '',
        screenshotPath: '',
        desktopOverflowCause: '',
        templateKey: '',
        error: '',
        mainStatus: '',
        blockedReason: '',
        loadMs: '',
        finalUrl: ''
      };

      const consoleErrors = [];
      const pageErrors = [];

      let captureConsole = true;
      const attachErrorListeners = (targetPage) => {
        targetPage.on('console', (message) => {
          if (!captureConsole) return;
          if (message.type() === 'error') {
            consoleErrors.push(message.text());
          }
        });

        targetPage.on('pageerror', (error) => {
          if (!captureConsole) return;
          pageErrors.push(error.message || String(error));
        });
      };

      attachErrorListeners(page);

      // If a staging/WAF blocks headless requests, we may create a one-off fallback browser/context.
      // These are cleaned up in the outer finally block.
      let activePage = page;
      let fallbackBrowser = null;
      let fallbackContext = null;

      try {
        const projectName = test.info().project.name;
        const isMobileProject = projectName === 'iphone-14' || projectName === 'ipad';
        const is1272Project = projectName === 'windows-laptop-1272';
        const shouldRunMobileChecks = RUN_MOBILE_CHECKS || isMobileProject;

        const navStart = Date.now();
        let response = null;

        const attemptHumanized = async (headless) => {
          const profile = humanizedDesktopProfile();
          const browser = await chromium.launch({
            executablePath: resolveChromiumExecutablePath(),
            headless,
            args: [
              '--disable-blink-features=AutomationControlled',
              '--no-default-browser-check',
              '--disable-infobars',
              '--disable-features=IsolateOrigins,site-per-process'
            ]
          });
          const context = await browser.newContext({
            viewport: profile.viewport,
            userAgent: profile.userAgent,
            locale: profile.locale,
            timezoneId: profile.timezoneId,
            extraHTTPHeaders: profile.extraHTTPHeaders,
            ignoreHTTPSErrors: true,
            httpCredentials:
              process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
                ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
                : undefined
          });
          // Best-effort stealth tweaks for staging/WAF environments.
          // This won't bypass strict access controls, but it helps when a host blocks obvious automation signals.
          await context.addInitScript(() => {
            try {
              Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
              Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
              Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
              window.chrome = window.chrome || { runtime: {} };
            } catch {
              // ignore
            }
          });
          const fbPage = await context.newPage();
          attachErrorListeners(fbPage);
          const fbResponse = await gotoWithRetries(
            fbPage,
            url,
            { waitUntil: 'domcontentloaded' },
            0
          ).catch(() => null);
          let effectiveResponse = fbResponse;
          await fbPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          let fbStatus = fbResponse ? fbResponse.status() : 0;
          if (fbStatus === 428) {
            const bypass = await tryBypassTechnicalDomain(fbPage);
            if (bypass.bypassed) {
              if (bypass.response) effectiveResponse = bypass.response;
              fbStatus = effectiveResponse ? effectiveResponse.status() : fbStatus;
            }
          }
          const fbDetect = await detectBlockedContent(fbPage);
          const blocked =
            (fbStatus >= 400 && fbStatus !== 0 && fbStatus !== 428) || fbDetect.blocked;
          const blockedReason =
            fbStatus >= 400 && fbStatus !== 0 && fbStatus !== 428
              ? `HTTP ${fbStatus}`
              : fbDetect.blocked
              ? `BLOCKED_CONTENT:${fbDetect.signature}`
              : '';
          return { browser, context, page: fbPage, response: effectiveResponse, status: fbStatus, detect: fbDetect, blocked, blockedReason };
        };

        try {
          response = await gotoWithRetries(activePage, url, { waitUntil: 'domcontentloaded' }, NAV_RETRIES);
          await activePage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          result.loadMs = Date.now() - navStart;
          result.mainStatus = response ? String(response.status()) : '';
          result.finalUrl = activePage.url();
        } catch (navError) {
          result.loadMs = Date.now() - navStart;
          result.status = 'BLOCKED';
          result.blockedReason = blockedReasonFromError(navError);
          result.finalUrl = activePage.url();
          // Surface as an issue entry, but mark as environment so the report can distinguish it.
          addIssue({
            Category: 'functionality',
            Severity: 'critical',
            Title: 'Page Blocked',
            Description: 'The page could not be loaded during automated QA (timeout/DNS/refused/auth/etc).',
            Element: result.blockedReason,
            Recommendation: 'Verify environment availability, authentication, and firewall/allowlist settings.',
            URL: url,
            _source: 'blocked',
            isEnvironment: true
          });
          result.screenshotPath = await captureBlockedEvidence(
            activePage,
            url,
            projectName,
            result.blockedReason,
            null
          );
          return;
        }

        // HTTP-based block detection + content-based block detection.
        const initialStatusCode = response ? response.status() : 0;
        // Special-case: cPanel "Technical Domain" (often HTTP 428) can sometimes be bypassed.
        if (initialStatusCode === 428) {
          const bypass = await tryBypassTechnicalDomain(activePage);
          if (bypass.bypassed) {
            response = bypass.response || response;
            result.mainStatus = response ? String(response.status()) : result.mainStatus;
            result.finalUrl = activePage.url();
          }
        }
        const initialDetect = await detectBlockedContent(activePage);
        // Treat 428 as "soft-block" because it may be an interstitial we can bypass.
        let blockedReason =
          initialStatusCode >= 400 && initialStatusCode !== 0 && initialStatusCode !== 428
            ? `HTTP ${initialStatusCode}`
            : initialDetect.blocked
            ? `BLOCKED_CONTENT:${initialDetect.signature}`
            : '';

        if (blockedReason && STAGING_FALLBACK) {
          // Attempt B: humanized headless
          const attemptB = await attemptHumanized(true);
          if (!attemptB.blocked) {
            fallbackBrowser = attemptB.browser;
            fallbackContext = attemptB.context;
            activePage = attemptB.page;
            response = attemptB.response;
            result.mainStatus = attemptB.status ? String(attemptB.status) : '';
            result.finalUrl = activePage.url();
            blockedReason = '';
          } else if (HEADED_BLOCK_RETRY) {
            await attemptB.context.close().catch(() => {});
            await attemptB.browser.close().catch(() => {});
            // Attempt C: headed retry
            const attemptC = await attemptHumanized(false);
            if (!attemptC.blocked) {
              fallbackBrowser = attemptC.browser;
              fallbackContext = attemptC.context;
              activePage = attemptC.page;
              response = attemptC.response;
              result.mainStatus = attemptC.status ? String(attemptC.status) : '';
              result.finalUrl = activePage.url();
              blockedReason = '';
            } else {
              await attemptC.context.close().catch(() => {});
              await attemptC.browser.close().catch(() => {});
              blockedReason = attemptC.blockedReason || blockedReason;
            }
          } else {
            // No headed retry configured; close attempt B before marking blocked.
            await attemptB.context.close().catch(() => {});
            await attemptB.browser.close().catch(() => {});
          }
        }

        if (blockedReason) {
          // If interactive mode is enabled, let the user manually dismiss any interstitials,
          // then re-check blocked status before we mark the page as BLOCKED.
          if (INTERACTIVE) {
            try {
              // This opens Playwright Inspector and pauses execution until you resume.
              await activePage.pause();
            } catch {
              // ignore (pause requires headed mode; runner enables --headed for --interactive)
            }
            await activePage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            const afterManualStatus = response ? response.status() : 0;
            const afterManualDetect = await detectBlockedContent(activePage);
            const afterManualBlockedReason =
              afterManualStatus >= 400 && afterManualStatus !== 0 && afterManualStatus !== 428
                ? `HTTP ${afterManualStatus}`
                : afterManualDetect.blocked
                ? `BLOCKED_CONTENT:${afterManualDetect.signature}`
                : '';
            if (!afterManualBlockedReason) {
              blockedReason = '';
            }
          }

          if (!blockedReason) {
            // Manual action cleared the blocker; continue with QA checks.
          } else {
          // Still blocked => stop noise pipeline.
          result.status = 'BLOCKED';
          result.blockedReason = blockedReason;
          const finalDetect = await detectBlockedContent(activePage);
          result.screenshotPath = await captureBlockedEvidence(
            activePage,
            url,
            projectName,
            blockedReason,
            finalDetect
          );
          addIssue({
            Category: 'functionality',
            Severity: 'critical',
            Title: blockedReason.startsWith('HTTP') ? 'Page Blocked (HTTP Error)' : 'Page Blocked (Content)',
            Description: blockedReason.startsWith('HTTP')
              ? 'The main document returned an HTTP error response, so page-level QA checks are not reliable.'
              : 'The page content appears to be a block/placeholder page (WAF/hosting), so QA checks are not reliable.',
            Element: blockedReason.startsWith('HTTP')
              ? `${blockedReason} ${activePage.url()}`
              : `${finalDetect.title || ''} | ${finalDetect.snippet || ''}`.slice(0, 240),
            Recommendation:
              'Verify allowlists/authentication and ensure the environment returns the real site HTML to automated browsers.',
            URL: url,
            _source: 'blocked',
            isEnvironment: true
          });
          return;
          }
        }

        if (activePage.isClosed()) {
          result.status = result.status === 'ERROR' ? 'ERROR' : 'FAIL';
          result.error = result.error || 'Page closed before layout checks';
          return;
        }

        const desktopOverflowData = await activePage.evaluate(() => {
          const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
          const samples = [];
          let cause = '';
          let maxOverflow = 0;
          const nodes = Array.from(document.body.querySelectorAll('*')).slice(0, 2000);
          for (const el of nodes) {
            const rect = el.getBoundingClientRect();
            const overflowPx = rect.right - window.innerWidth;
            if (overflowPx > 1 && rect.width > 20) {
              const selector = el.id
                ? `${el.tagName.toLowerCase()}#${el.id}`
                : el.className && typeof el.className === 'string'
                ? `${el.tagName.toLowerCase()}.${el.className.split(/\\s+/).slice(0, 2).join('.')}`
                : el.tagName.toLowerCase();
              if (samples.length < 3) {
                samples.push(selector);
              }
              if (overflowPx > maxOverflow) {
                maxOverflow = overflowPx;
                cause = selector;
              }
            }
          }
          return { overflow, samples, cause };
        });

        const templateKey = await collectTemplateSignature(activePage);
        activeTemplateKeyForIssues = templateKey || '';
        const layoutMisuse = await collectLayoutMisuse(activePage);
        const modalBlocking = await detectBlockingModal(activePage);
        const { broken: brokenLinks, errors: linkCheckErrors } = await collectBrokenLinks(activePage, request);
        const h1Count = SKIP_SEO ? 0 : await activePage.locator('h1').count();
        const missingAlt = await collectMissingAltImages(activePage);
        const brokenImages = await collectBrokenImages(activePage);
        const wpSignals = await collectWordPressSignals(activePage);
        const lazyImageCandidates = filterLazyImagesForProfile(wpSignals.imagesMissingLazy);
        const formCheck = await validateForms(activePage);
        const hoverIssues = await checkHoverStates(activePage);
        captureConsole = false;
        const mobileCheck = shouldRunMobileChecks && !is1272Project ? await checkMobileViewport(activePage, url) : null;

        result.consoleErrors = consoleErrors.length;
        result.consoleErrorsSample = consoleErrors.slice(0, MAX_SAMPLES).join(' | ');
        result.pageErrors = pageErrors.length;
        result.pageErrorsSample = pageErrors.slice(0, MAX_SAMPLES).join(' | ');
        result.brokenLinks = brokenLinks.length;
        result.linkCheckErrors = linkCheckErrors.length;
        result.brokenLinksSample = brokenLinks
          .slice(0, MAX_SAMPLES)
          .map((item) => `${item.status}:${item.url}`)
          .join(' | ');
        result.linkCheckErrorsSample = linkCheckErrors
          .slice(0, MAX_SAMPLES)
          .map((item) => `${item.error || item.status}:${item.url}`)
          .join(' | ');
        result.desktopOverflow = desktopOverflowData.overflow;
        result.desktopOverflowSample = desktopOverflowData.samples.join(' | ');
        result.desktopOverflowCause = desktopOverflowData.cause || '';
        result.h1Count = SKIP_SEO ? '' : h1Count;
        result.missingAlt = missingAlt.length;
        result.missingAltSample = missingAlt.slice(0, MAX_SAMPLES).join(' | ');
        result.brokenImages = brokenImages.length;
        result.brokenImagesSample = brokenImages.slice(0, MAX_SAMPLES).join(' | ');
        result.externalLinksMissingBlank = wpSignals.externalMissingBlank.length;
        result.externalLinksMissingBlankSample = wpSignals.externalMissingBlank.slice(0, MAX_SAMPLES).join(' | ');
        result.internalLinksBlank = wpSignals.internalBlank.length;
        result.internalLinksBlankSample = wpSignals.internalBlank.slice(0, MAX_SAMPLES).join(' | ');
        result.imagesMissingLazy = lazyImageCandidates.length;
        result.imagesMissingLazySample = lazyImageCandidates.slice(0, MAX_SAMPLES).join(' | ');
        result.schemaTypes = (wpSignals.schemaTypes || []).slice(0, MAX_SAMPLES).join(' | ');
        result.navMissingAriaSample = (wpSignals.navMissingAria || []).slice(0, MAX_SAMPLES).join(' | ');
        result.anchorMissingTargetsSample = (wpSignals.anchorMissingTargets || []).slice(0, MAX_SAMPLES).join(' | ');
        result.cachingHints = (wpSignals.cachingHints || []).slice(0, MAX_SAMPLES).join(' | ');
        result.templateName = wpSignals.templateName || '';
        result.pluginHints = (wpSignals.pluginHints || []).slice(0, MAX_SAMPLES).join(' | ');
        result.themeHints = (wpSignals.themeHints || []).slice(0, MAX_SAMPLES).join(' | ');
        result.jsonLdPresent = SKIP_SEO ? '' : wpSignals.hasJsonLd;
        result.metaTitle = SKIP_SEO ? '' : wpSignals.title;
        result.metaDescriptionPresent = SKIP_SEO ? '' : Boolean(wpSignals.metaDescription);
        result.viewportMeta = wpSignals.viewport;
        result.templateKey = templateKey;
        if (REST_LOOKUP && process.env.REST_BASE) {
          const templateFromRest = await resolveTemplateNameFromRest(activePage, process.env.REST_BASE);
          if (templateFromRest) {
            result.templateName = templateFromRest;
          }
        }
        result.modalBlocking = modalBlocking.blocked;
        result.modalBlockingSample = modalBlocking.selector || '';
        if (mobileCheck) {
          result.mobileOverflow = mobileCheck.overflow;
          result.mobileNavFullWidth = mobileCheck.navFullWidth;
        }
        result.headingSkip = wpSignals.headingSkip
          ? `H${wpSignals.headingSkip.from.level} -> H${wpSignals.headingSkip.to.level}`
          : '';

        result.formsTotal = formCheck.total;
        result.formsValid = formCheck.results.filter((r) => r.valid && !r.skipped).length;
        result.formsSubmitted = formCheck.results.filter((r) => r.submitted && !r.skipped).length;
        result.formsSkipped = formCheck.results.filter((r) => r.skipped).length;
        result.formsFailed = formCheck.results.filter((r) => !r.valid && !r.skipped).length;
        result.formsInvalidSample = formCheck.results
          .filter((r) => !r.valid && !r.skipped)
          .slice(0, MAX_SAMPLES)
          .map((r) => r.invalidFields.join(';'))
          .join(' | ');
        result.formsIssueSample = formCheck.results
          .filter((r) => (!r.valid && !r.skipped) || r.errorMessages.length > 0)
          .slice(0, MAX_SAMPLES)
          .map((r) => `${r.selector}: ${r.errorMessages.join('; ') || r.invalidFields.join('; ')}`)
          .join(' | ');
        if (!result.formsIssueSample && result.formsSkipped > 0) {
          result.formsIssueSample = formCheck.results
            .filter((r) => r.skipped)
            .slice(0, MAX_SAMPLES)
            .map((r) => `${r.selector}: skipped (${r.skipReason || 'unknown'})`)
            .join(' | ');
        }
        if (!result.formsIssueSample) {
          result.formsIssueSample = summarizeFormDiagnostics(formCheck);
        }

        if (FORM_SUBMIT_MODE === 'live' && formCheck.total > 0) {
          const submission = await submitFormsAndAwaitResult(activePage, formCheck);
          result.formsSubmitted = submission.submitted;
          // Treat "success" as valid submissions; failures will be handled as issues/fail rules.
          if (submission.failed > 0) {
            result.formsFailed = submission.failed;
            result.formsIssueSample = submission.sample || result.formsIssueSample;
            for (const failure of (submission.failures || []).slice(0, MAX_SAMPLES)) {
              const frameHint = failure.frameUrl ? ` | frame: ${failure.frameUrl}` : '';
              const reasonHint = failure.reason ? `reason=${failure.reason}` : 'reason=unknown';
              addIssue({
                Category: 'functionality',
                Severity: 'major',
                Title: 'Form Submission Error Detail',
                Description:
                  `${failure.plugin || 'Form'} submission failed (${reasonHint}). ${failure.message || 'No error text detected.'}`,
                Element: `${failure.selector || 'form'}${frameHint}`,
                Recommendation:
                  'Inspect the form endpoint response, anti-spam/captcha flow, and front-end validation handlers.',
                URL: url,
                _source: 'forms'
              });
            }
          }
        }

        const consoleClassifications = consoleErrors.map((msg) => {
          const classification = classifyConsoleError(msg);
          return {
            message: msg,
            ...classification,
            allowlisted:
              shouldIgnoreClassification(classification) || isAllowlisted(msg, CONSOLE_ALLOWLIST)
          };
        });

        const pageClassifications = pageErrors.map((msg) => {
          const classification = classifyPageError(msg);
          return {
            message: msg,
            ...classification,
            allowlisted:
              shouldIgnoreClassification(classification) || isAllowlisted(msg, PAGE_ERROR_ALLOWLIST)
          };
        });

        for (const classified of consoleClassifications.filter((c) => !c.allowlisted)) {
          addIssue({
            Category: 'functionality',
            Severity: classified.severity,
            Title: classified.title,
            Description: classified.description,
            Element: classified.message,
            Recommendation: classified.recommendation,
            URL: url,
            _source: 'console',
            resourceUrl: classified.resourceUrl || '',
            httpStatus: classified.httpStatus || '',
            assetType: classified.assetType || '',
            ownership: classified.ownership || 'unknown',
            actionability: classified.actionability || 'actionable'
          });
        }

        for (const classified of pageClassifications.filter((c) => !c.allowlisted)) {
          addIssue({
            Category: 'functionality',
            Severity: classified.severity,
            Title: classified.title,
            Description: classified.description,
            Element: classified.message,
            Recommendation: classified.recommendation,
            URL: url,
            _source: 'page',
            ownership: classified.ownership || 'unknown',
            actionability: classified.actionability || 'actionable'
          });
        }

        for (const link of brokenLinks) {
          const skip = BROKEN_LINK_IGNORE_PATTERNS.some((re) => re.test(link.url || ''));
          if (skip) continue;
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Broken Link',
            Description:
              'A link returned an error response, which can lead users to dead ends or missing resources.',
            Element: link.url,
            Recommendation: 'Update the link target or restore the missing resource.',
            URL: url,
            _source: 'links'
          });
        }

        for (const linkError of linkCheckErrors) {
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Link Check Error',
            Description:
              'A link could not be verified due to a transient network/timeout error. This may hide real link health.',
            Element: `${linkError.error || 'Request failed'} | ${linkError.url}`,
            Recommendation:
              'Re-run checks for this URL and verify connectivity/firewall/CDN behavior for automated traffic.',
            URL: url,
            _source: 'links',
            httpStatus: linkError.status || '',
            resourceUrl: linkError.url
          });
        }

        if (!SKIP_SEO && h1Count !== 1) {
          addIssue({
            Category: 'seo',
            Severity: 'minor',
            Title: 'H1 Count Issue',
            Description:
              `The page contains ${h1Count} H1 elements. Pages typically should have exactly one primary H1 for clarity and SEO.`,
            Element: 'h1',
            Recommendation: 'Ensure there is a single, descriptive H1 per page.',
            URL: url,
            _source: 'structure'
          });
        }

        for (const src of missingAlt) {
          addIssue({
            Category: 'accessibility',
            Severity: 'major',
            Title: 'Missing Alt Text for Images',
            Description:
              'An image is missing alternative text, which can block screen reader users from understanding content.',
            Element: `img[src="${src}"]`,
            WCAG: 'WCAG 1.1.1',
            Recommendation: 'Add meaningful alt text describing the image content or function.',
            URL: url,
            _source: 'images'
          });
        }

        for (const src of brokenImages) {
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Broken Image',
            Description:
              'An image failed to load, which can hurt credibility and visual clarity.',
            Element: `img[src="${src}"]`,
            Recommendation: 'Fix the image URL or restore the missing image file.',
            URL: url,
            _source: 'images'
          });
        }

        if (!SKIP_SEO && !wpSignals.title) {
          addIssue({
            Category: 'seo',
            Severity: 'major',
            Title: 'Missing Page Title',
            Description: 'The document title is missing, which can impact SEO and browser tab labels.',
            Element: '<title>',
            Recommendation: 'Add a descriptive, unique page title.',
            URL: url,
            _source: 'seo'
          });
        }

        if (!SKIP_SEO && !wpSignals.metaDescription) {
          addIssue({
            Category: 'seo',
            Severity: 'major',
            Title: 'Missing Meta Description',
            Description: 'The page is missing a meta description, which can reduce search snippet quality.',
            Element: 'meta[name=\"description\"]',
            Recommendation: 'Add a concise, descriptive meta description.',
            URL: url,
            _source: 'seo'
          });
        }

        if (!SKIP_SEO && !wpSignals.hasJsonLd) {
          addIssue({
            Category: 'seo',
            Severity: 'minor',
            Title: 'Missing JSON-LD Structured Data',
            Description: 'No JSON-LD structured data was found on the page.',
            Element: 'script[type=\"application/ld+json\"]',
            Recommendation: 'Add appropriate structured data (Organization, WebPage, Article, etc.).',
            URL: url,
            _source: 'seo'
          });
        }

        if (!wpSignals.viewport || !wpSignals.viewport.toLowerCase().includes('width=device-width')) {
          addIssue({
            Category: 'accessibility',
            Severity: 'major',
            Title: 'Viewport Meta Missing or Invalid',
            Description:
              'The viewport meta tag is missing or does not include width=device-width, which can break mobile layouts.',
            Element: 'meta[name=\"viewport\"]',
            Recommendation: 'Add viewport meta with width=device-width, initial-scale=1.',
            URL: url,
            _source: 'mobile'
          });
        }

        for (const href of wpSignals.externalMissingBlank.slice(0, MAX_SAMPLES)) {
          addIssue({
            Category: 'ux',
            Severity: 'minor',
            Title: 'External Link Missing target=\"_blank\"',
            Description:
              'External links that open in the same tab can disrupt user flow and increase bounce risk.',
            Element: `a[href=\"${href}\"]`,
            Recommendation: 'Add target=\"_blank\" and rel=\"noopener\" for external links.',
            URL: url,
            _source: 'links'
          });
        }

        for (const href of wpSignals.internalBlank.slice(0, MAX_SAMPLES)) {
          addIssue({
            Category: 'ux',
            Severity: 'minor',
            Title: 'Internal Link Opens New Tab',
            Description:
              'Internal links opening new tabs can be confusing and inconsistent with expected navigation.',
            Element: `a[href=\"${href}\"]`,
            Recommendation: 'Remove target=\"_blank\" for internal links.',
            URL: url,
            _source: 'links'
          });
        }

        for (const src of lazyImageCandidates.slice(0, MAX_SAMPLES)) {
          addIssue({
            Category: 'performance',
            Severity: 'minor',
            Title: 'Image Missing loading=\"lazy\"',
            Description:
              'Images without lazy-loading can increase initial page load time.',
            Element: `img[src=\"${src}\"]`,
            Recommendation: 'Add loading=\"lazy\" to non-critical images.',
            URL: url,
            _source: 'performance'
          });
        }

        if (wpSignals.phoneNumbers.length > 0 && wpSignals.telLinks.length === 0) {
          addIssue({
            Category: 'ux',
            Severity: 'major',
            Title: 'Phone Numbers Not Clickable',
            Description:
              'Phone numbers are present but no tel: links were detected, which hurts mobile usability.',
            Element: wpSignals.phoneNumbers.slice(0, MAX_SAMPLES).join(' | '),
            Recommendation: 'Wrap phone numbers in tel: links for one-tap calling.',
            URL: url,
            _source: 'mobile'
          });
        }

        for (const item of hoverIssues) {
          addIssue({
            Category: 'ux',
            Severity: 'minor',
            Title: 'Button Hover State Missing',
            Description:
              'A button did not show a visual change on hover, which can reduce perceived interactivity.',
            Element: item.selector,
            Recommendation: 'Add a hover style to interactive buttons/links.',
            URL: url,
            _source: 'ux'
          });
        }

        if (mobileCheck && mobileCheck.overflow) {
          addIssue({
            Category: 'ux',
            Severity: 'major',
            Title: 'Mobile Horizontal Overflow',
            Description:
              'The page overflows horizontally on a mobile viewport, causing unwanted sideways scrolling.',
            Element: 'document.documentElement',
            Recommendation: 'Identify the overflowing element and constrain its width.',
            URL: url,
            _source: 'mobile'
          });
        }

        if (desktopOverflowData.overflow) {
          addIssue({
            Category: 'structure',
            Severity: 'major',
            Title: 'Horizontal Overflow Detected',
            Description:
              `Elements extend beyond the viewport width, causing horizontal scroll.${desktopOverflowData.cause ? ` Overflow likely caused by ${desktopOverflowData.cause}.` : ''}`,
            Element: desktopOverflowData.cause || desktopOverflowData.samples.join(' | ') || 'document.documentElement',
            Recommendation: 'Identify overflowing elements and constrain their width.',
            URL: url,
            _source: 'layout'
          });
        }

        if (layoutMisuse.fixedWidth.length > 0) {
          addIssue({
            Category: 'structure',
            Severity: 'major',
            Title: 'Fixed-width Sections Detected',
            Description:
              'Some sections/containers use fixed pixel widths wider than the viewport, which breaks responsiveness.',
            Element: layoutMisuse.fixedWidth.slice(0, MAX_SAMPLES).join(' | '),
            Recommendation: 'Use relative widths (%, max-width) or Elementor responsive settings.',
            URL: url,
            _source: 'layout'
          });
        }

        if (layoutMisuse.wideContainers.length > 0) {
          addIssue({
            Category: 'structure',
            Severity: 'major',
            Title: 'Containers Wider Than Viewport',
            Description:
              'Some containers exceed the viewport width, which causes overflow and horizontal scrolling.',
            Element: layoutMisuse.wideContainers.slice(0, MAX_SAMPLES).join(' | '),
            Recommendation: 'Constrain container widths and check Elementor section settings.',
            URL: url,
            _source: 'layout'
          });
        }

        if (layoutMisuse.missingPadding.length > 0) {
          addIssue({
            Category: 'structure',
            Severity: 'minor',
            Title: 'Full-width Sections Missing Padding',
            Description:
              'Full-width sections appear to have little or no horizontal padding, which can cause edge collisions.',
            Element: layoutMisuse.missingPadding.slice(0, MAX_SAMPLES).join(' | '),
            Recommendation: 'Add horizontal padding to full-width containers (Elementor section padding).',
            URL: url,
            _source: 'layout'
          });
        }

        if (wpSignals.navMissingAria && wpSignals.navMissingAria.length > 0) {
          addIssue({
            Category: 'accessibility',
            Severity: 'minor',
            Title: 'Navigation Missing ARIA Label',
            Description: 'Navigation landmarks should have role=\"navigation\" or aria-label for accessibility.',
            Element: wpSignals.navMissingAria.slice(0, MAX_SAMPLES).join(' | '),
            Recommendation: 'Add aria-label to nav elements (e.g., <nav aria-label=\"Primary navigation\">).',
            URL: url,
            _source: 'structure'
          });
        }

        if (wpSignals.anchorMissingTargets && wpSignals.anchorMissingTargets.length > 0) {
          addIssue({
            Category: 'structure',
            Severity: 'minor',
            Title: 'Anchor Target Missing',
            Description: 'In-page links reference IDs that are not present, causing broken jumps.',
            Element: wpSignals.anchorMissingTargets.slice(0, MAX_SAMPLES).join(' | '),
            Recommendation: 'Ensure each #id in links matches an element id on the page.',
            URL: url,
            _source: 'structure'
          });
        }

        if (modalBlocking.blocked) {
          addIssue({
            Category: 'structure',
            Severity: 'major',
            Title: 'Cookie/Modal Blocking Content',
            Description:
              'A fixed-position modal/banner covers most of the viewport, blocking page content during QA.',
            Element: modalBlocking.selector || 'fixed modal',
            Recommendation: 'Ensure cookie banners/modals are dismissible and do not block core content.',
            URL: url,
            _source: 'layout'
          });
        }

        if (mobileCheck && !mobileCheck.navFullWidth) {
          addIssue({
            Category: 'ux',
            Severity: 'major',
            Title: 'Mobile Nav Not Full Width',
            Description:
              'The mobile navigation drawer/panel does not span the full viewport width.',
            Element: 'nav',
            Recommendation: 'Ensure mobile navigation panels use full-width styling.',
            URL: url,
            _source: 'mobile'
          });
        }

        if (wpSignals.headingSkip) {
          addIssue({
            Category: 'accessibility',
            Severity: 'major',
            Title: 'Heading Level Skip',
            Description:
              `Heading levels jump from H${wpSignals.headingSkip.from.level} to H${wpSignals.headingSkip.to.level}.`,
            Element: `${wpSignals.headingSkip.from.text} -> ${wpSignals.headingSkip.to.text}`,
            Recommendation: 'Ensure heading levels follow a logical order (H1, H2, H3...).',
            URL: url,
            _source: 'structure'
          });
        }

        for (const formResult of formCheck.results.filter((r) => !r.valid && !r.skipped)) {
          const invalidDetail = (formResult.invalidFields || []).slice(0, MAX_SAMPLES).join('; ');
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Form Validation Issue',
            Description:
              `A form failed validation (${formResult.plugin} @ ${formResult.selector}). ${invalidDetail || 'No field-level message provided.'}`,
            Element: `${formResult.selector}${invalidDetail ? ` | ${invalidDetail}` : ''}`,
            Recommendation:
              'Review required fields and validation rules; ensure form can be submitted with valid data.',
            URL: url,
            _source: 'forms'
          });
        }

        for (const formResult of formCheck.results.filter((r) => r.errorMessages.length > 0 && !r.skipped)) {
          const errorDetail = (formResult.errorMessages || []).slice(0, MAX_SAMPLES).join('; ');
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Form Error Message Detected',
            Description:
              `A form displayed validation errors (${formResult.plugin} @ ${formResult.selector}). ${errorDetail || 'No error text captured.'}`,
            Element: `${formResult.selector}${errorDetail ? ` | ${errorDetail}` : ''}`,
            Recommendation: 'Ensure form validation messages are resolved and submission succeeds.',
            URL: url,
            _source: 'forms'
          });
        }

        if (FORM_SUBMIT_MODE === 'live' && result.formsTotal > 0 && result.formsFailed > 0) {
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Form Submission Failed',
            Description: `A form submission did not result in a detectable success message. ${result.formsIssueSample || 'No form diagnostics captured.'}`,
            Element: result.formsIssueSample || 'Form submission did not show success',
            Recommendation:
              'Check form endpoints, email/CRM configuration, spam protection (reCAPTCHA), and confirmation messages.',
            URL: url,
            _source: 'forms'
          });
        }

        if (isLikelyContactUrl(url) && result.formsTotal === 0) {
          const diagnostic = result.formsIssueSample || summarizeFormDiagnostics(formCheck);
          addIssue({
            Category: 'functionality',
            Severity: 'major',
            Title: 'Contact Form Not Detected',
            Description:
              `No form elements or embedded form iframes were detected on a contact-intent page. ${diagnostic || 'No additional detection hints were captured.'}`,
            Element: diagnostic || 'No <form> or known embedded form iframe found',
            Recommendation:
              'Ensure the contact form renders without extra user interaction and is visible to automated QA (including embedded provider iframes).',
            URL: url,
            _source: 'forms'
          });
        }

        let axeResultsData = null;
        if (!SKIP_AXE) {
          const axeResults = await new AxeBuilder({ page: activePage }).analyze();
          axeResultsData = axeResults;
          result.axeViolations = axeResults.violations.length;
          result.axeViolationSample = axeResults.violations
            .slice(0, MAX_SAMPLES)
            .map((v) => v.id)
            .join(' | ');

          for (const violation of axeResults.violations) {
            const wcagTags = (violation.tags || []).filter((t) => t.startsWith('wcag'));
            const wcag = wcagTags.length > 0 ? wcagTags.join(', ') : '';
            const sampleNodes = violation.nodes.slice(0, MAX_SAMPLES);
            for (const node of sampleNodes) {
              addIssue({
                Category: 'accessibility',
                Severity: impactToSeverity(violation.impact),
                Title: violation.help,
                Description: violation.description,
                Element: node.target ? node.target.join(', ') : '',
                WCAG: wcag,
                Recommendation: violation.helpUrl ? `See: ${violation.helpUrl}` : 'Resolve per WCAG guidance.',
                URL: url,
                _source: 'axe'
              });
            }
          }
        }

        let lighthouseScores = null;
        if (!SKIP_LIGHTHOUSE && lighthouseSampleUrls.has(url)) {
          try {
            const lighthouseResult = await withLighthouseSlot(() => runLighthouse(url));
            lighthouseScores = lighthouseResult.scores;
            result.lighthousePerformance = lighthouseResult.scores.performance;
            result.lighthouseAccessibility = lighthouseResult.scores.accessibility;
            result.lighthouseBestPractices = lighthouseResult.scores.bestPractices;
            result.lighthouseSEO = lighthouseResult.scores.seo;
            result.lighthouseReportHtml = path.relative(process.cwd(), lighthouseResult.htmlPath);
            result.lighthouseReportJson = path.relative(process.cwd(), lighthouseResult.jsonPath);

            if (lighthouseResult.scores.performance < 90) {
              addIssue({
                Category: 'performance',
                Severity: lighthouseResult.scores.performance < 70 ? 'major' : 'minor',
                Title: 'Performance Score Below Target',
                Description:
                  `Lighthouse performance score is ${lighthouseResult.scores.performance}, indicating opportunities to improve load speed.`,
                Element: '',
                Recommendation: 'Review Lighthouse report to address performance opportunities.',
                URL: url,
                _source: 'lighthouse'
              });
            }

            if (!SKIP_SEO && lighthouseResult.scores.seo < 90) {
              addIssue({
                Category: 'seo',
                Severity: lighthouseResult.scores.seo < 70 ? 'major' : 'minor',
                Title: 'SEO Score Below Target',
                Description:
                  `Lighthouse SEO score is ${lighthouseResult.scores.seo}, indicating potential SEO issues.`,
                Element: '',
                Recommendation: 'Review Lighthouse report to address SEO opportunities.',
                URL: url,
                _source: 'lighthouse'
              });
            }

            if (lighthouseResult.scores.bestPractices < 90) {
              addIssue({
                Category: 'quality',
                Severity: lighthouseResult.scores.bestPractices < 70 ? 'major' : 'minor',
                Title: 'Best Practices Score Below Target',
                Description:
                  `Lighthouse best practices score is ${lighthouseResult.scores.bestPractices}, indicating technical quality issues.`,
                Element: '',
                Recommendation: 'Review Lighthouse report to address best-practice opportunities.',
                URL: url,
                _source: 'lighthouse'
              });
            }

            if (lighthouseResult.scores.accessibility < 90) {
              addIssue({
                Category: 'accessibility',
                Severity: lighthouseResult.scores.accessibility < 70 ? 'major' : 'minor',
                Title: 'Accessibility Score Below Target',
                Description:
                  `Lighthouse accessibility score is ${lighthouseResult.scores.accessibility}, indicating accessibility issues.`,
                Element: '',
                Recommendation: 'Review Lighthouse report to address accessibility opportunities.',
                URL: url,
                _source: 'lighthouse'
              });
            }
          } catch (error) {
            result.lighthouseError = `Lighthouse failed: ${error.message}`;
            addIssue({
              Category: 'performance',
              Severity: 'minor',
              Title: 'Lighthouse Audit Skipped',
              Description: 'Lighthouse could not complete for this URL.',
              Element: result.lighthouseError,
              Recommendation: 'Re-run Lighthouse manually if a performance/SEO audit is needed.',
              URL: url,
              _source: 'lighthouse'
            });
          }
        }

        const failReasons = [];
        if (consoleClassifications.some((c) => classificationCausesFailure(c, FAIL_ON_CONSOLE_SEVERITY))) {
          failReasons.push('console errors');
        }
        if (pageClassifications.some((c) => classificationCausesFailure(c, FAIL_ON_PAGE_ERROR_SEVERITY))) {
          failReasons.push('page errors');
        }
        if (FAIL_ON_BROKEN_LINKS && brokenLinks.length > 0) {
          failReasons.push('broken links');
        }
        if (FAIL_ON_LINK_CHECK_ERRORS && linkCheckErrors.length > 0) {
          failReasons.push('link check errors');
        }
        if (!SKIP_SEO && FAIL_ON_H1 && h1Count !== 1) {
          failReasons.push('h1 count');
        }
        if (FAIL_ON_MISSING_ALT && missingAlt.length > 0) {
          failReasons.push('missing alt');
        }
        if (wpSignals.headingSkip) {
          failReasons.push('heading skip');
        }
        const hasInvalidForm = formCheck.results.some((r) => !r.valid && !r.skipped);
        const hasUnsubmittedForm = formCheck.results.filter((r) => !r.skipped).length > result.formsSubmitted;
        const missingContactForm = isLikelyContactUrl(url) && result.formsTotal === 0;
        if (FAIL_ON_FORMS && (hasInvalidForm || hasUnsubmittedForm || missingContactForm)) {
          failReasons.push('form validation');
        }
        if (
          FAIL_ON_AXE &&
          !SKIP_AXE &&
          axeResultsData &&
          axeResultsData.violations.some((v) => severityMeetsThreshold(v.impact, FAIL_ON_AXE_SEVERITY))
        ) {
          failReasons.push('axe violations');
        }
        if (FAIL_ON_LIGHTHOUSE && lighthouseScores) {
          if (lighthouseScores.performance < FAIL_ON_LIGHTHOUSE_PERF) {
            failReasons.push('lighthouse performance');
          }
          if (!SKIP_SEO && lighthouseScores.seo < FAIL_ON_LIGHTHOUSE_SEO) {
            failReasons.push('lighthouse seo');
          }
          if (lighthouseScores.bestPractices < FAIL_ON_LIGHTHOUSE_BEST_PRACTICES) {
            failReasons.push('lighthouse best practices');
          }
          if (lighthouseScores.accessibility < FAIL_ON_LIGHTHOUSE_ACCESSIBILITY) {
            failReasons.push('lighthouse accessibility');
          }
        }

        if (test.info().project.name === 'windows-laptop-1272' && desktopOverflowData.overflow) {
          failReasons.push('1272 overflow');
        }

        result.failReasons = failReasons.join(' | ');
        if (result.status !== 'ERROR') {
          result.status = failReasons.length > 0 ? 'FAIL' : 'PASS';
        }

        if (result.status === 'FAIL' && SCREENSHOTS_MODE === 'issues' && SCREENSHOTS_LIMIT > 0) {
          const screenshotPaths = [];
          let remaining = SCREENSHOTS_LIMIT;

          if (remaining > 0 && failReasons.includes('h1 count')) {
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'h1',
              ['h1']
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(url, (issue) => issue.Title === 'H1 Count Issue', pathForIssue);
              remaining -= 1;
            }
          }

          if (remaining > 0 && failReasons.includes('missing alt')) {
            const selectors = buildImageSelectors(missingAlt.slice(0, MAX_SAMPLES));
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'missing-alt',
              selectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue.Title === 'Missing Alt Text for Images',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          if (remaining > 0 && result.imagesMissingLazy > 0) {
            const selectors = buildImageSelectors(lazyImageCandidates.slice(0, MAX_SAMPLES));
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'missing-lazy',
              selectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue.Title === 'Image Missing loading=\"lazy\"',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          if (remaining > 0 && result.externalLinksMissingBlank > 0) {
            const selectors = buildLinkSelectors(wpSignals.externalMissingBlank.slice(0, MAX_SAMPLES));
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'external-links',
              selectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue.Title === 'External Link Missing target=\"_blank\"',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          if (remaining > 0 && hoverIssues.length > 0) {
            const selectors = hoverIssues.slice(0, MAX_SAMPLES).map((item) => item.selector);
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'hover',
              selectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue.Title === 'Button Hover State Missing',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          if (remaining > 0 && desktopOverflowData.overflow && (desktopOverflowData.cause || desktopOverflowData.samples.length > 0)) {
            const selectors = desktopOverflowData.cause
              ? [desktopOverflowData.cause, ...desktopOverflowData.samples]
              : desktopOverflowData.samples;
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'overflow',
              selectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue._source === 'layout',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          if (remaining > 0 && axeResultsData && axeResultsData.violations.length > 0) {
            const axeSelectors = [];
            axeResultsData.violations.slice(0, MAX_SAMPLES).forEach((violation) => {
              violation.nodes.slice(0, 1).forEach((node) => {
                if (node.target && node.target.length > 0) {
                  axeSelectors.push(node.target[0]);
                }
              });
            });
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'axe',
              axeSelectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue._source === 'axe',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          const failedForms = formCheck.results.filter((r) => !r.valid && !r.skipped);
          if (remaining > 0 && failedForms.length > 0) {
            const selectors = failedForms.slice(0, MAX_SAMPLES).map((form) => form.selector);
            const pathForIssue = await captureIssueScreenshot(
              activePage,
              url,
              projectName,
              'form',
              selectors
            );
            if (pathForIssue) {
              screenshotPaths.push(pathForIssue);
              attachScreenshotToIssues(
                url,
                (issue) => issue._source === 'forms',
                pathForIssue
              );
              remaining -= 1;
            }
          }

          if (screenshotPaths.length > 0) {
            result.screenshotPath = screenshotPaths.join(' | ');
          }
        }

        if (STRICT) {
          expect.soft(consoleErrors, 'Console errors').toEqual([]);
          expect.soft(pageErrors, 'Page errors').toEqual([]);
          expect.soft(brokenLinks.length, 'Broken links').toBe(0);
          expect.soft(linkCheckErrors.length, 'Link-check errors').toBe(0);
          if (!SKIP_SEO) {
            expect.soft(h1Count, 'H1 count').toBe(1);
          }
          expect.soft(missingAlt.length, 'Missing image alt text').toBe(0);
          expect.soft(formCheck.results.some((r) => !r.valid && !r.skipped), 'Form validation').toBe(false);
          if (!SKIP_AXE) {
            expect.soft(result.axeViolations, 'Axe violations').toBe(0);
          }
        }
      } catch (error) {
        result.status = 'ERROR';
        result.error = error.message;
      } finally {
        if (fallbackContext) {
          await fallbackContext.close().catch(() => {});
        }
        if (fallbackBrowser) {
          await fallbackBrowser.close().catch(() => {});
        }
        activeTemplateKeyForIssues = '';
        results.push(result);
      }
    });
  }
});
