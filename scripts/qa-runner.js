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
  console.error('Usage: npm run qa <clientname> [--projects=..] [--quick] [--full] [--workers=N] [--skip-seo] [--sample-templates] [--profile=client-safe|engineering-deep] [--report-audience=client|developer]');
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
const relativeDataPath = path.relative(cwd, dataPath);
let clientConfig = {};
if (fs.existsSync(dataPath)) {
  try {
    clientConfig = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch (error) {
    console.warn(`[qa-runner] Could not parse client config ${dataPath}: ${error.message}`);
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
// If no sitemap flag, but client config specifies one, use it.
let derivedSitemapFlag = sitemapFlag;
if (!derivedSitemapFlag && clientConfig.sitemap) {
  derivedSitemapFlag = `--sitemap=${clientConfig.sitemap}`;
}
// If still none, try to derive from baseUrl (common WP sitemap paths).
if (!derivedSitemapFlag && clientConfig.baseUrl) {
  const base = clientConfig.baseUrl.replace(/\/+$/, '');
  derivedSitemapFlag = `--sitemap=${base}/sitemap_index.xml`;
}
// If still none and client has seed URLs, try to derive base from first URL.
if (!derivedSitemapFlag && Array.isArray(clientConfig.urls) && clientConfig.urls.length > 0) {
  try {
    const origin = new URL(clientConfig.urls[0]).origin;
    derivedSitemapFlag = `--sitemap=${origin}/sitemap_index.xml`;
    if (!clientConfig.baseUrl) {
      clientConfig.baseUrl = origin;
    }
  } catch {
    // ignore
  }
}

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

async function fetchText(url) {
  const res = await fetch(url, withAuth());
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function parseSitemap(url, parser, visited = new Set()) {
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
      const nested = await parseSitemap(sitemapUrl, parser, visited);
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
  const res = await fetch(url, withAuth({
    method: 'GET',
    headers: { Accept: 'application/json' }
  }));
  if (!res.ok) {
    throw new Error(`Failed request ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchRestUrls(restBase) {
  const apiBase = restBase.replace(/\/+$/, '');
  const types = await fetchJson(`${apiBase}/wp-json/wp/v2/types`);
  const typeKeys = Object.keys(types || {}).filter(
    (key) => !['attachment', 'nav_menu_item', 'revision'].includes(key)
  );

  const urls = [apiBase];
  const seen = new Set(urls);

  for (const typeKey of typeKeys) {
    let page = 1;
    let keepGoing = true;
    while (keepGoing) {
      const endpoint = `${apiBase}/wp-json/wp/v2/${typeKey}?per_page=100&page=${page}`;
      let items = [];
      try {
        items = await fetchJson(endpoint);
      } catch {
        break;
      }
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        if (!item || !item.link) continue;
        if (seen.has(item.link)) continue;
        seen.add(item.link);
        urls.push(item.link);
      }
      keepGoing = items.length === 100;
      page += 1;
    }
  }

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
      const res = await fetch(candidate, withAuth({ method: 'HEAD' }));
      if (res.ok) return candidate;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

async function resolveUrlsPath() {
  if (derivedSitemapFlag) {
    const sitemapUrl = derivedSitemapFlag.replace('--sitemap=', '').trim();
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
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(sitemapOutput, JSON.stringify({ urls }, null, 2));
    return sitemapOutput;
  }

  // Prefer full REST URL discovery only after explicit/derived sitemap attempts unless explicitly disabled.
  const restBaseCandidate = process.env.REST_BASE || clientConfig.restBase || clientConfig.baseUrl || (Array.isArray(clientConfig.urls) && clientConfig.urls[0]);
  if (!noRest && restBaseCandidate) {
    try {
      const uniqueUrls = await fetchRestUrls(restBaseCandidate);
      if (sampleTemplates) {
        uniqueUrls.splice(0, uniqueUrls.length, ...reduceTemplateUrls(uniqueUrls));
      }
      if (uniqueUrls.length > 0) {
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(sitemapOutput, JSON.stringify({ urls: uniqueUrls }, null, 2));
        return sitemapOutput;
      }
    } catch {
      // ignore and fall through
    }
  }

  // Try auto-discovery if no explicit sitemap and client has baseUrl.
  if (clientConfig.baseUrl) {
    const auto = await discoverSitemap(clientConfig.baseUrl);
    if (auto) {
      const parser = new XMLParser({ ignoreAttributes: false });
      let urls = await parseSitemap(auto, parser);
      if (urls.length > 0) {
        if (!sitemapNoSample && sampleTemplates) {
          urls = reduceTemplateUrls(urls);
        }
        const limitValue = sitemapLimitFlag ? Number(sitemapLimitFlag.replace('--sitemap-limit=', '')) : 200;
        urls = applySitemapLimit(urls, limitValue);
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(sitemapOutput, JSON.stringify({ urls }, null, 2));
        return sitemapOutput;
      }
    }
  }

  if (fs.existsSync(dataPath)) {
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
      `Expected ${relativeDataPath} or pass --sitemap=https://example.com/sitemap_index.xml.`
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
      LAUNCHGUARD_ROOT: cwd,
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

    // Always generate the shareable report zip so the UI export button works.
    const zipScript = path.join(packageRoot, 'scripts', 'zip-report.js');
    spawnSync('node', [zipScript, clientName], {
      stdio: 'inherit',
      env,
      cwd
    });

    // Always generate the HTML report for the same client at the end of the run.
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
