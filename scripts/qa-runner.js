const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { resolveClientDataFile, resolveClientReportsDir, validateClientId } = require('./lib/safe-paths');

const packageRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const clientArg = args.find((arg) => !arg.startsWith('--'));

if (!clientArg) {
  console.error('Usage: npm run qa <clientname> [--projects=..] [--quick] [--full] [--workers=N] [--skip-seo] [--sample-templates] [--sitemap=..] [--single=..] [--profile=client-safe|engineering-deep] [--report-audience=client|developer]');
  process.exit(1);
}

let clientName = '';
try {
  clientName = validateClientId(clientArg);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const projectsFlag = flags.find((flag) => flag.startsWith('--projects='));
const workersFlag = flags.find((flag) => flag.startsWith('--workers='));
const sitemapFlag = flags.find((flag) => flag.startsWith('--sitemap='));
const singleFlag = flags.find((flag) => flag.startsWith('--single='));
const sitemapLimitFlag = flags.find((flag) => flag.startsWith('--sitemap-limit='));
const sitemapNoSample = flags.includes('--sitemap-no-sample');
const archiveScreenshots = flags.includes('--archive-screenshots');
const keepReports = flags.includes('--keep-reports');
const authUserFlag = flags.find((flag) => flag.startsWith('--auth-user='));
const authPassFlag = flags.find((flag) => flag.startsWith('--auth-pass='));
const profileFlag = flags.find((flag) => flag.startsWith('--profile='));
const reportAudienceFlag = flags.find((flag) => flag.startsWith('--report-audience='));
const interactive = flags.includes('--interactive');
const headed = flags.includes('--headed');
const quick = flags.includes('--quick');
const full = flags.includes('--full');
const skipSeo = flags.includes('--skip-seo');
const noRest = flags.includes('--no-rest');
const sampleTemplates = flags.includes('--sample-templates');
const cwd = process.cwd();
const dataPath = resolveClientDataFile(cwd, clientName);
const fallbackPath = path.join(cwd, 'data', 'urls.json');
const allowGlobalFallback = String(process.env.QA_ALLOW_GLOBAL_URL_FALLBACK || '').toLowerCase() === 'true';
const allowClientDataFallback = String(process.env.QA_ALLOW_CLIENT_DATA_FALLBACK || '').toLowerCase() === 'true';
const relativeDataPath = path.relative(cwd, dataPath);
let clientConfig = {};
if (fs.existsSync(dataPath)) {
  try {
    clientConfig = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (error) {
    console.warn(`[qa-runner] Could not parse client config ${dataPath}: ${error.message}`);
  }
}

let singleUrl = '';
let singleOrigin = '';
if (singleFlag) {
  singleUrl = singleFlag.replace('--single=', '').trim();
  try {
    singleOrigin = new URL(singleUrl).origin;
  } catch {
    console.error('Invalid --single URL');
    process.exit(1);
  }
}

const basicUser = authUserFlag
  ? authUserFlag.replace('--auth-user=', '')
  : clientConfig.basicAuth && clientConfig.basicAuth.user;
const basicPass = authPassFlag
  ? authPassFlag.replace('--auth-pass=', '')
  : clientConfig.basicAuth && clientConfig.basicAuth.pass;

function withAuth(init = {}) {
  if (!basicUser || !basicPass) return init;
  const headers = {
    ...(init.headers || {}),
    Authorization: `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`
  };
  return { ...init, headers };
}
// Sitemap is now explicit-only. We do not auto-derive sitemap URLs because
// WordPress-native REST discovery is the default source of truth.
const explicitSitemapUrl = sitemapFlag
  ? sitemapFlag.replace('--sitemap=', '').trim()
  : String(clientConfig.sitemap || '').trim();

const allProjects = [
  'chrome-desktop-1920',
  'firefox-desktop',
  'webkit-desktop',
  'iphone-14',
  'ipad',
  'windows-laptop-1272'
];

let projects = allProjects;

if (projectsFlag) {
  projects = projectsFlag
    .replace('--projects=', '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
} else if (quick) {
  projects = ['chrome-desktop-1920', 'windows-laptop-1272'];
} else if (full) {
  projects = allProjects;
}

const reportsDir = resolveClientReportsDir(cwd, clientName);
const sitemapOutput = path.join(reportsDir, 'urls.json');

function writeResolvedUrls(urls, sourceLabel) {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(sitemapOutput, JSON.stringify({ urls }, null, 2));
  console.log(`[qa-runner] URL source: ${sourceLabel}. URLs discovered: ${urls.length}.`);
  return sitemapOutput;
}

// CQ-001: All fetch calls now use a 30-second AbortController timeout so a
// hanging server cannot stall the runner indefinitely.
const FETCH_TIMEOUT_MS = Number(process.env.QA_FETCH_TIMEOUT_MS || 30_000);

function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url, withAuth());
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// CQ-002: Depth limit prevents infinite recursion if a sitemap index
// references itself or an adversarially-deep chain of sub-sitemaps.
const SITEMAP_MAX_DEPTH = Number(process.env.QA_SITEMAP_MAX_DEPTH || 5);

async function parseSitemap(url, parser, visited = new Set(), depth = 0) {
  if (depth > SITEMAP_MAX_DEPTH) {
    console.warn(`[qa-runner] Sitemap depth limit (${SITEMAP_MAX_DEPTH}) reached, skipping: ${url}`);
    return [];
  }
  if (visited.has(url)) return [];
  visited.add(url);
  const xml = await fetchText(url);
  const doc = parser.parse(xml);

  if (doc.sitemapindex && doc.sitemapindex.sitemap) {
    const sitemapUrls = normalizeArray(doc.sitemapindex.sitemap)
      .map((entry) => entry.loc)
      .filter(Boolean);
    const all = [];
    for (const sitemapUrl of sitemapUrls) {
      const nested = await parseSitemap(sitemapUrl, parser, visited, depth + 1);
      all.push(...nested);
    }
    return all;
  }

  if (doc.urlset && doc.urlset.url) {
    return normalizeArray(doc.urlset.url).map((entry) => entry.loc).filter(Boolean);
  }

  return [];
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, withAuth({
    method: 'GET',
    headers: { Accept: 'application/json' }
  }));
  if (!res.ok) {
    throw new Error(`Failed request ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchJsonWithMeta(url) {
  const res = await fetchWithTimeout(url, withAuth({
    method: 'GET',
    headers: { Accept: 'application/json' }
  }));
  if (!res.ok) {
    throw new Error(`Failed request ${res.status} for ${url}`);
  }
  const data = await res.json();
  const totalPages = Number(res.headers.get('x-wp-totalpages') || 0);
  return {
    data,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 0
  };
}

function normalizeContentUrl(rawUrl, expectedOrigin) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(String(rawUrl).trim());
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    if (expectedOrigin && parsed.origin !== expectedOrigin) return '';
    parsed.hash = '';
    parsed.search = '';
    const normalizedPath = parsed.pathname.replace(/\/{2,}/g, '/');
    parsed.pathname = normalizedPath || '/';
    const href = parsed.toString();
    return href.endsWith('/') ? href : `${href}/`;
  } catch {
    return '';
  }
}

function shouldIncludeContentUrl(urlValue) {
  if (!urlValue) return false;
  try {
    const parsed = new URL(urlValue);
    const path = parsed.pathname.toLowerCase();
    if (path.startsWith('/wp-admin') || path.startsWith('/wp-json')) return false;
    if (path.includes('/feed/')) return false;
    if (path.includes('/embed/')) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchRestUrls(restBase) {
  const apiBase = restBase.replace(/\/+$/, '');
  const origin = new URL(apiBase).origin;
  const defaultCollections = ['pages', 'posts'];
  const collections = new Set(defaultCollections);

  try {
    const types = await fetchJson(`${apiBase}/wp-json/wp/v2/types`);
    if (types && typeof types === 'object') {
      for (const typeRecord of Object.values(types)) {
        if (!typeRecord || typeof typeRecord !== 'object') continue;
        const restBaseName = String(typeRecord.rest_base || '').trim();
        const isPublic = Boolean(typeRecord.public);
        if (!isPublic || !restBaseName) continue;
        if (['attachments', 'revisions', 'nav_menu_item'].includes(restBaseName)) continue;
        collections.add(restBaseName);
      }
    }
  } catch {
    // Keep defaults when type introspection is blocked.
  }

  const urls = [];
  const seen = new Set();
  const pushUrl = (candidate) => {
    const normalized = normalizeContentUrl(candidate, origin);
    if (!normalized) return;
    if (!shouldIncludeContentUrl(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  };

  for (const typeKey of collections) {
    let page = 1;
    let keepGoing = true;
    let totalPages = 0;
    while (keepGoing) {
      const endpoint = `${apiBase}/wp-json/wp/v2/${typeKey}?per_page=100&page=${page}&status=publish&_fields=link,status`;
      let items = [];
      try {
        const response = await fetchJsonWithMeta(endpoint);
        items = Array.isArray(response.data) ? response.data : [];
        totalPages = response.totalPages || totalPages;
      } catch {
        break;
      }
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        if (!item || !item.link) continue;
        pushUrl(item.link);
      }
      if (totalPages > 0) {
        keepGoing = page < totalPages;
      } else {
        keepGoing = items.length > 0 && page < 100;
      }
      page += 1;
    }
  }

  pushUrl(apiBase);
  return urls;
}

function reduceTemplateUrls(urls) {
  const templatePrefixes = [
    '/blog/',
    '/news/',
    '/insights/',
    '/case-studies/',
    '/guides/',
    '/author/',
    '/tag/',
    '/category/'
  ];

  const seen = new Set();
  const output = [];

  for (const raw of urls) {
    try {
      const parsed = new URL(raw);
      const pathName = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
      const lower = pathName.toLowerCase();
      const matchPrefix = templatePrefixes.find((prefix) => lower.startsWith(prefix));

      if (matchPrefix) {
        if (seen.has(matchPrefix)) continue;
        seen.add(matchPrefix);
        output.push(raw);
        continue;
      }

      const segments = lower.split('/').filter(Boolean);
      const hasDate = segments.length >= 3 && /^\d{4}$/.test(segments[0]) && /^\d{2}$/.test(segments[1]);
      if (hasDate) {
        const key = `date:${segments[0]}/${segments[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(raw);
        continue;
      }

      output.push(raw);
    } catch {
      output.push(raw);
    }
  }

  return output;
}

function applySitemapLimit(urls, limit) {
  if (!limit || Number.isNaN(limit)) return urls;
  return urls.slice(0, limit);
}

async function discoverSitemap(baseUrl) {
  if (!baseUrl) return null;
  const trimmed = baseUrl.replace(/\/+$/, '');
  const candidates = [
    `${trimmed}/sitemap_index.xml`,
    `${trimmed}/sitemap.xml`
  ];
  for (const candidate of candidates) {
    try {
      const res = await fetchWithTimeout(candidate, withAuth({ method: 'HEAD' }));
      if (res.ok) return candidate;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

async function resolveUrlsPath() {
  if (singleUrl) {
    return writeResolvedUrls([singleUrl], 'single');
  }

  if (explicitSitemapUrl) {
    const sitemapUrl = explicitSitemapUrl;
    if (!sitemapUrl) {
      throw new Error('Invalid --sitemap URL');
    }
    const parser = new XMLParser({ ignoreAttributes: false });
    let urls = await parseSitemap(sitemapUrl, parser);
    if (urls.length === 0) {
      throw new Error('No URLs found in sitemap.');
    }
    if (!sitemapNoSample && sampleTemplates) {
      urls = reduceTemplateUrls(urls);
    }
    const limitValue = sitemapLimitFlag ? Number(sitemapLimitFlag.replace('--sitemap-limit=', '')) : 200;
    urls = applySitemapLimit(urls, limitValue);
    return writeResolvedUrls(urls, 'sitemap-explicit');
  }

  // Prefer full REST URL discovery only after explicit/derived sitemap attempts unless explicitly disabled.
  const restBaseCandidate = process.env.REST_BASE || clientConfig.restBase || clientConfig.baseUrl || (Array.isArray(clientConfig.urls) && clientConfig.urls[0]);
  if (!noRest && restBaseCandidate) {
    try {
      const uniqueUrls = await fetchRestUrls(restBaseCandidate);
      if (sampleTemplates) {
        uniqueUrls.splice(0, uniqueUrls.length, ...reduceTemplateUrls(uniqueUrls));
      }
      const limitValue = sitemapLimitFlag ? Number(sitemapLimitFlag.replace('--sitemap-limit=', '')) : 500;
      const limited = applySitemapLimit(uniqueUrls, limitValue);
      const nonHomeUrls = uniqueUrls.filter((url) => {
        try {
          return new URL(url).pathname.replace(/\/+$/, '') !== '';
        } catch {
          return false;
        }
      });
      if (nonHomeUrls.length > 0) {
        return writeResolvedUrls(limited, 'wp-rest-published-pages-posts');
      }
      console.warn('[qa-runner] REST discovery returned only homepage.');
    } catch {
      // ignore and fall through
    }
  }

  // No implicit sitemap fallback: avoid hidden/private/non-front-facing URLs.

  if (allowClientDataFallback && fs.existsSync(dataPath)) {
    console.warn(
      `[qa-runner] URL source fallback: client data file ${relativeDataPath}. ` +
      `Set QA_ALLOW_CLIENT_DATA_FALLBACK=false to disable this behavior.`
    );
    return dataPath;
  }

  if (allowGlobalFallback && fs.existsSync(fallbackPath)) {
    console.warn(
      `[qa-runner] Using fallback URL file data/urls.json for client "${clientName}". ` +
      `Set QA_ALLOW_GLOBAL_URL_FALLBACK=false to disable this behavior.`
    );
    return fallbackPath;
  }

  throw new Error(
    `No URL source found for client "${clientName}". ` +
      `Pass --sitemap=https://example.com/sitemap_index.xml or set QA_ALLOW_CLIENT_DATA_FALLBACK=true to use ${relativeDataPath}.`
  );
}


function readLastRunState(runRoot) {
  const filePath = path.join(runRoot, 'test-results', '.last-run.json');
  if (!fs.existsSync(filePath)) {
    return { interrupted: false, failedTests: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const status = String(parsed.status || '').toLowerCase();
    return {
      interrupted: status === 'interrupted',
      failedTests: Array.isArray(parsed.failedTests) ? parsed.failedTests : []
    };
  } catch {
    return { interrupted: false, failedTests: [] };
  }
}

function writeFallbackRunMeta({
  client,
  reportsPath,
  startedAt,
  endedAt,
  quickMode,
  fullMode,
  projectsList,
  workersValue,
  interrupted,
  playwrightExitCode,
  mergeError
}) {
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    client,
    state: 'merge_failed',
    run: {
      startedAt,
      endedAt,
      quick: quickMode,
      full: fullMode,
      projects: projectsList,
      workers: workersValue || null,
      interrupted: Boolean(interrupted),
      playwrightExitCode
    },
    merge: {
      status: 'failed',
      error: String(mergeError || '').slice(0, 500)
    }
  };

  fs.mkdirSync(reportsPath, { recursive: true });
  fs.writeFileSync(path.join(reportsPath, 'run_meta.json'), JSON.stringify(payload, null, 2), 'utf8');
}

const playwrightConfigPath = path.join(packageRoot, 'playwright.config.js');
const playwrightArgs = ['playwright', 'test', `--config=${playwrightConfigPath}`];
projects.forEach((project) => {
  playwrightArgs.push(`--project=${project}`);
});

// Allow manual intervention during a run when staging shows interstitials (e.g., cPanel technical domain).
// We force headed + single-worker behavior unless explicitly overridden.
if (interactive || headed) {
  playwrightArgs.push('--headed');
}

let selectedWorkers = null;
if (workersFlag) {
  const raw = workersFlag.replace('--workers=', '').trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Invalid --workers value: ${raw}`);
    process.exit(1);
  }
  selectedWorkers = value;
} else if (interactive || quick) {
  // Quick mode is optimized for stability and report integrity.
  selectedWorkers = 1;
}
if (selectedWorkers) {
  playwrightArgs.push(`--workers=${selectedWorkers}`);
}

// Cleanup must happen BEFORE sitemap resolution, because sitemap mode writes
// `reports/<client>/urls.json`. If we cleanup after generating the sitemap file,
// we delete it and Playwright will report "Missing URL file".
if (!keepReports && fs.existsSync(reportsDir)) {
  const visualDir = path.join(reportsDir, 'visual');
  const visualTemp = path.join(cwd, `.visual-${clientName}-backup`);
  if (fs.existsSync(visualTemp)) {
    fs.rmSync(visualTemp, { recursive: true, force: true });
  }
  if (fs.existsSync(visualDir)) {
    fs.renameSync(visualDir, visualTemp);
  }

  const screenshotsDir = path.join(reportsDir, 'screenshots');
  if (archiveScreenshots && fs.existsSync(screenshotsDir)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = path.join(reportsDir, `screenshots-${timestamp}.zip`);
    try {
      spawnSync('zip', ['-r', archiveName, 'screenshots'], {
        cwd: reportsDir,
        stdio: 'ignore'
      });
    } catch {
      // ignore archive failures
    }
  }
  fs.rmSync(reportsDir, { recursive: true, force: true });
  if (fs.existsSync(visualTemp)) {
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.renameSync(visualTemp, path.join(reportsDir, 'visual'));
  }
}

const runStartedAt = new Date().toISOString();

resolveUrlsPath()
  .then((urlsPath) => {
    const env = {
      ...process.env,
      CLIENT_NAME: clientName,
      URLS_PATH: urlsPath,
      BASELINE_ROOT: cwd,
      RUN_STARTED_AT: runStartedAt
    };

    if (quick) {
      env.SKIP_LIGHTHOUSE = 'true';
      if (!Object.prototype.hasOwnProperty.call(process.env, 'FORM_SUBMIT_MODE')) {
        env.FORM_SUBMIT_MODE = 'dry-run';
      }
      if (!Object.prototype.hasOwnProperty.call(process.env, 'SCREENSHOTS_MODE')) {
        env.SCREENSHOTS_MODE = 'off';
      }
    }
    if (skipSeo) {
      env.SKIP_SEO = 'true';
    }
    if (profileFlag) {
      const profile = profileFlag.replace('--profile=', '').trim().toLowerCase();
      if (profile === 'client-safe' || profile === 'engineering-deep') {
        env.QA_PROFILE = profile;
      }
    }
    if (reportAudienceFlag) {
      const audience = reportAudienceFlag.replace('--report-audience=', '').trim().toLowerCase();
      if (audience === 'client' || audience === 'developer') {
        env.REPORT_AUDIENCE_DEFAULT = audience;
      }
    }

  if (interactive) {
    env.INTERACTIVE = 'true';
  }

    if (clientConfig.restBase) {
      env.REST_BASE = clientConfig.restBase;
    } else if (clientConfig.baseUrl) {
      env.REST_BASE = clientConfig.baseUrl;
    } else if (singleOrigin) {
      env.REST_BASE = singleOrigin;
    } else if (Array.isArray(clientConfig.urls) && clientConfig.urls.length > 0) {
      try {
        env.REST_BASE = new URL(clientConfig.urls[0]).origin;
      } catch {
        // ignore
      }
    }

    if (basicUser && basicPass) {
      env.BASIC_AUTH_USER = basicUser;
      env.BASIC_AUTH_PASS = basicPass;
    }

    if (clientConfig.formSuccessSelector) {
      env.FORM_SUCCESS_OVERRIDE = clientConfig.formSuccessSelector;
    }

    if (clientConfig.restBase) {
      env.REST_BASE = clientConfig.restBase;
    }

    const result = spawnSync('npx', playwrightArgs, {
      stdio: 'inherit',
      env,
      cwd
    });

    const runEndedAt = new Date().toISOString();
    const lastRunState = readLastRunState(cwd);

    // Merge worker shards into canonical HTML/CSV artifacts.
    const mergeScript = path.join(packageRoot, 'scripts', 'merge-qa-results.js');
    const mergeResult = spawnSync('node', [mergeScript, clientName], {
      stdio: 'inherit',
      env: {
        ...env,
        RUN_STARTED_AT: runStartedAt,
        RUN_ENDED_AT: runEndedAt,
        QA_QUICK: quick ? 'true' : 'false',
        QA_FULL: full ? 'true' : 'false',
        QA_PROJECTS: projects.join(','),
        QA_WORKERS: selectedWorkers ? String(selectedWorkers) : '',
        QA_INTERRUPTED: lastRunState.interrupted ? 'true' : 'false',
        PLAYWRIGHT_EXIT_CODE: String(result.status ?? 1)
      },
      cwd
    });
    if (mergeResult.status !== 0) {
      writeFallbackRunMeta({
        client: clientName,
        reportsPath: reportsDir,
        startedAt: runStartedAt,
        endedAt: runEndedAt,
        quickMode: quick,
        fullMode: full,
        projectsList: projects,
        workersValue: selectedWorkers,
        interrupted: lastRunState.interrupted,
        playwrightExitCode: result.status ?? 1,
        mergeError: `merge-qa-results failed with status ${mergeResult.status}`
      });
    }

    const zipExportEnabled = String(env.ZIP_EXPORT_ENABLED || 'true').toLowerCase() !== 'false';
    const latestZipPath = path.join(reportsDir, `share-${clientName}-latest.zip`);
    if (zipExportEnabled) {
      const zipScript = path.join(packageRoot, 'scripts', 'zip-report.js');
      spawnSync('node', [zipScript, clientName], {
        stdio: 'inherit',
        env,
        cwd
      });
    } else if (fs.existsSync(latestZipPath)) {
      fs.rmSync(latestZipPath, { force: true });
    }

    const pdfExportEnabled = String(env.PDF_EXPORT_ENABLED || '').toLowerCase() === 'true';
    const pdfPath = path.join(reportsDir, 'QA_Report.pdf');
    if (pdfExportEnabled) {
      const pdfScript = path.join(packageRoot, 'reporting', 'generate-pdf-report.js');
      const pdfResult = spawnSync('node', [pdfScript, clientName], {
        stdio: 'inherit',
        env,
        cwd
      });
      if (pdfResult.status !== 0) {
        console.warn('[qa-runner] PDF report generation failed; continuing without QA_Report.pdf.');
      }
    } else if (fs.existsSync(pdfPath)) {
      fs.rmSync(pdfPath, { force: true });
    }

    const htmlReportScript = path.join(packageRoot, 'reporting', 'generate-html-report.js');
    spawnSync('node', [htmlReportScript, clientName], {
      stdio: 'inherit',
      env,
      cwd
    });

    process.exit(result.status ?? 1);
  })
  .catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
