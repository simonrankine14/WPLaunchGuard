const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { chromium, firefox, webkit, devices } = require('playwright');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { resolveClientDataFile, resolveClientReportsDir, resolveWithin, validateClientId } = require('./lib/safe-paths');
const {
  DEFAULT_MASK_SELECTORS,
  COOKIE_SELECTORS,
  sanitizeSelectors,
  isBlankImage,
  resolveBrowserExecutable
} = require('./lib/visual-helpers');
const { csvEscape } = require('./lib/csv-utils');

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const clientArg = args.find((arg) => !arg.startsWith('--'));

if (!clientArg) {
  console.error('Usage: npm run visual:baseline -- <client> --base=<url>');
  console.error('       npm run visual:compare -- <client> --base=<url> --target=<url>');
  process.exit(1);
}

let clientName = '';
try {
  clientName = validateClientId(clientArg);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const modeFlag = flags.find((flag) => flag.startsWith('--mode='));
const mode = modeFlag ? modeFlag.replace('--mode=', '').trim() : 'baseline';
const baseFlag = flags.find((flag) => flag.startsWith('--base='));
const targetFlag = flags.find((flag) => flag.startsWith('--target='));
const sitemapFlag = flags.find((flag) => flag.startsWith('--sitemap='));
const sitemapLimitFlag = flags.find((flag) => flag.startsWith('--sitemap-limit='));
const projectsFlag = flags.find((flag) => flag.startsWith('--projects='));
const singleFlag = flags.find((flag) => flag.startsWith('--single='));
const singleBaselineFlag = flags.find((flag) => flag.startsWith('--single-baseline='));
const singleTargetFlag = flags.find((flag) => flag.startsWith('--single-target='));
const maskFlag = flags.find((flag) => flag.startsWith('--mask='));
const hideFlag = flags.find((flag) => flag.startsWith('--hide='));
const waitForFlag = flags.find((flag) => flag.startsWith('--wait-for='));
const noDefaultMasksFlag = flags.includes('--no-default-masks');
const noCookieAcceptFlag = flags.includes('--no-cookie-accept');
const diffThresholdFlag = flags.find((flag) => flag.startsWith('--diff-threshold='));
const scrollWaitFlag = flags.find((flag) => flag.startsWith('--scroll-wait-ms='));
const headlessFlag = flags.find((flag) => flag.startsWith('--headless='));
const authUserFlag = flags.find((flag) => flag.startsWith('--auth-user='));
const authPassFlag = flags.find((flag) => flag.startsWith('--auth-pass='));
const baseAuthUserFlag = flags.find((flag) => flag.startsWith('--base-auth-user='));
const baseAuthPassFlag = flags.find((flag) => flag.startsWith('--base-auth-pass='));
const targetAuthUserFlag = flags.find((flag) => flag.startsWith('--target-auth-user='));
const targetAuthPassFlag = flags.find((flag) => flag.startsWith('--target-auth-pass='));

const diffThreshold = diffThresholdFlag ? Number(diffThresholdFlag.replace('--diff-threshold=', '')) : 0.1;
const sitemapLimit = sitemapLimitFlag ? Number(sitemapLimitFlag.replace('--sitemap-limit=', '')) : 200;
const scrollWaitMs = scrollWaitFlag ? Number(scrollWaitFlag.replace('--scroll-wait-ms=', '')) : 150;
const headless = headlessFlag ? headlessFlag.replace('--headless=', '').trim() !== 'false' : true;

const baseUrl = baseFlag ? baseFlag.replace('--base=', '').trim() : '';
const targetUrl = targetFlag ? targetFlag.replace('--target=', '').trim() : '';
const authUser = authUserFlag ? authUserFlag.replace('--auth-user=', '') : '';
const authPass = authPassFlag ? authPassFlag.replace('--auth-pass=', '') : '';
const baseAuthUser = baseAuthUserFlag ? baseAuthUserFlag.replace('--base-auth-user=', '') : authUser;
const baseAuthPass = baseAuthPassFlag ? baseAuthPassFlag.replace('--base-auth-pass=', '') : authPass;
const targetAuthUser = targetAuthUserFlag ? targetAuthUserFlag.replace('--target-auth-user=', '') : authUser;
const targetAuthPass = targetAuthPassFlag ? targetAuthPassFlag.replace('--target-auth-pass=', '') : authPass;
const singleBaseline = singleBaselineFlag ? singleBaselineFlag.replace('--single-baseline=', '').trim() : '';
const singleTarget = singleTargetFlag ? singleTargetFlag.replace('--single-target=', '').trim() : '';
const cliMaskSelectors = parseSelectorList(maskFlag);
const cliHideSelectors = parseSelectorList(hideFlag);
const cliWaitForSelectors = parseSelectorList(waitForFlag);

function parseSelectorList(flagValue) {
  if (!flagValue) return [];
  return flagValue
    .replace(/^--[^=]+=|^--[^=]+$/, '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function uniq(list) {
  return [...new Set(list)];
}

if (!['baseline', 'compare'].includes(mode)) {
  console.error('Invalid --mode. Use baseline or compare.');
  process.exit(1);
}

if (mode === 'compare' && !targetUrl && !singleTarget) {
  console.error('Compare mode requires --target=<url> or --single-target=<url>.');
  process.exit(1);
}

if (mode === 'compare') {
  const baseCandidate = singleBaseline || baseUrl;
  const targetCandidate = singleTarget || targetUrl;
  if (baseCandidate && targetCandidate && baseCandidate === targetCandidate) {
    console.error('Baseline and target URLs are identical. Provide distinct --baseline/--target values.');
    process.exit(1);
  }
}

const cwd = process.cwd();
const clientFile = resolveClientDataFile(cwd, clientName);
const fallbackFile = path.join(cwd, 'data', 'urls.json');
const reportsRoot = resolveClientReportsDir(cwd, clientName, 'visual');

const defaultProjects = [
  'chrome-desktop-1920',
  'windows-laptop-1272',
  'iphone-14',
  'ipad'
];

const projects = projectsFlag
  ? projectsFlag.replace('--projects=', '').split(',').map((p) => p.trim()).filter(Boolean)
  : defaultProjects;

const projectConfigs = {
  'chrome-desktop-1920': {
    name: 'chrome-desktop-1920',
    browserType: chromium,
    context: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1920, height: 1080 }
    }
  },
  'windows-laptop-1272': {
    name: 'windows-laptop-1272',
    browserType: chromium,
    context: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1272, height: 900 }
    }
  },
  'iphone-14': {
    name: 'iphone-14',
    browserType: webkit,
    context: {
      ...devices['iPhone 14']
    }
  },
  'ipad': {
    name: 'ipad',
    browserType: webkit,
    context: {
      ...devices['iPad (gen 7)']
    }
  },
  'firefox-desktop': {
    name: 'firefox-desktop',
    browserType: firefox,
    context: {
      ...devices['Desktop Firefox']
    }
  },
  'webkit-desktop': {
    name: 'webkit-desktop',
    browserType: webkit,
    context: {
      ...devices['Desktop Safari']
    }
  }
};

// csvEscape is imported from ./lib/csv-utils

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// CQ-001: 30-second AbortController timeout for all sitemap fetches.
const VISUAL_FETCH_TIMEOUT_MS = Number(process.env.VISUAL_FETCH_TIMEOUT_MS || 30_000);

function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISUAL_FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchText(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// CQ-002: Depth limit prevents infinite recursion on adversarially-deep sitemap chains.
const VISUAL_SITEMAP_MAX_DEPTH = Number(process.env.VISUAL_SITEMAP_MAX_DEPTH || 5);

async function parseSitemap(url, parser, visited = new Set(), depth = 0) {
  if (depth > VISUAL_SITEMAP_MAX_DEPTH) {
    console.warn(`[visual-runner] Sitemap depth limit (${VISUAL_SITEMAP_MAX_DEPTH}) reached, skipping: ${url}`);
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

function applyLimit(urls) {
  if (!sitemapLimit || Number.isNaN(sitemapLimit)) return urls;
  return urls.slice(0, sitemapLimit);
}

function loadClientUrls() {
  const file = fs.existsSync(clientFile) ? clientFile : fallbackFile;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const urls = Array.isArray(parsed) ? parsed : parsed.urls;
  return urls || [];
}

async function resolveUrls() {
  if (singleTargetFlag) {
    return [singleTarget];
  }

  if (singleFlag) {
    return [singleFlag.replace('--single=', '').trim()];
  }

  if (sitemapFlag) {
    const sitemapUrl = sitemapFlag.replace('--sitemap=', '').trim();
    const parser = new XMLParser({ ignoreAttributes: false });
    let urls = await parseSitemap(sitemapUrl, parser);
    urls = reduceTemplateUrls(urls);
    urls = applyLimit(urls);
    return urls;
  }

  return loadClientUrls();
}

function loadVisualConfig() {
  const configPath = resolveWithin(path.join(cwd, 'visual', 'config'), `${clientName}.json`);
  const baseDefaults = {
    maskSelectors: [],
    hideSelectors: [],
    waitForSelectors: [],
    waitForTimeoutMs: 1000,
    confidenceWeights: {
      diffPercent: 0.7,
      maskedSelectors: 0.3
    }
  };

  const fileConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

  const defaultMasks = noDefaultMasksFlag ? [] : DEFAULT_MASK_SELECTORS;
  const warnings = [];
  const sanitized = sanitizeSelectors(
    [
      ...defaultMasks,
      ...(fileConfig.maskSelectors || baseDefaults.maskSelectors),
      ...cliMaskSelectors
    ],
    warnings
  );

  return {
    maskSelectors: sanitized.sanitized,
    hideSelectors: uniq([
      ...(fileConfig.hideSelectors || baseDefaults.hideSelectors),
      ...cliHideSelectors
    ]),
    waitForSelectors: uniq([
      ...(fileConfig.waitForSelectors || baseDefaults.waitForSelectors),
      ...cliWaitForSelectors
    ]),
    waitForTimeoutMs: fileConfig.waitForTimeoutMs || baseDefaults.waitForTimeoutMs,
    confidenceWeights: fileConfig.confidenceWeights || baseDefaults.confidenceWeights,
    consentSelectors: fileConfig.consentSelectors || [],
    warnings
  };
}

function replaceOrigin(url, origin) {
  if (!origin) return url;
  const parsed = new URL(url);
  const base = new URL(origin);
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  return parsed.toString();
}

function urlToSlug(url) {
  const parsed = new URL(url);
  const safePath = parsed.pathname.replace(/\/+$/, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return safePath ? `${parsed.hostname}_${safePath}` : parsed.hostname;
}

async function stabilizePage(page, config) {
  await page.addStyleTag({
    content: `*{animation-duration:0s !important;animation-delay:0s !important;transition-duration:0s !important;scroll-behavior:auto !important;}`
  });

  if (config.hideSelectors.length > 0) {
    await page.addStyleTag({
      content: `${config.hideSelectors.join(',')} { display: none !important; }`
    });
  }

  if (config.maskSelectors.length > 0) {
    await page.addStyleTag({
      content: `${config.maskSelectors.join(',')} { visibility: hidden !important; }`
    });
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  if (page.evaluate) {
    await page.evaluate(() => document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve());
  }

  for (const selector of config.waitForSelectors) {
    await page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});
  }

  await page.waitForTimeout(config.waitForTimeoutMs || 1000);

  // Force lazy assets to load (common on long pages)
  if (page.evaluate) {
    await page.evaluate(async (waitMs) => {
      const candidates = Array.from(
        document.querySelectorAll('img[loading=\"lazy\"], img[data-src], img[data-lazy-src], source[data-srcset], source[data-lazy-srcset]')
      );
      candidates.forEach((el) => {
        if (el.dataset && el.dataset.src) el.src = el.dataset.src;
        if (el.dataset && el.dataset.lazySrc) el.src = el.dataset.lazySrc;
        if (el.dataset && el.dataset.srcset) el.srcset = el.dataset.srcset;
        if (el.dataset && el.dataset.lazySrcset) el.srcset = el.dataset.lazySrcset;
        if (el.loading) el.loading = 'eager';
      });
      const viewport = window.innerHeight || 900;
      const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || viewport;
      const step = Math.max(200, viewport * 0.8);
      for (let pos = 0; pos < scrollHeight; pos += step) {
        window.scrollTo(0, pos);
        await new Promise((r) => setTimeout(r, waitMs || 150));
      }
      window.scrollTo(0, 0);
    }, scrollWaitMs).catch(() => {});
  }
}

async function clickConsent(page, config) {
  if (noCookieAcceptFlag) return false;
  const candidates = [...(config.consentSelectors || []), ...COOKIE_SELECTORS];
  for (const sel of candidates) {
    try {
      const element = await page.$(sel);
      if (element) {
        await element.click({ timeout: 1500 });
        return true;
      }
    } catch (_) {
      // ignore and continue
    }
  }
  const texts = ['accept', 'agree', 'ok'];
  for (const text of texts) {
    try {
      const locator = page.getByText(text, { exact: false });
      if (await locator.count().catch(() => 0)) {
        await locator.first().click({ timeout: 1500 });
        return true;
      }
    } catch (_) {
      // ignore and continue
    }
  }
  return false;
}

async function captureScreenshot(page, url, outputPath, config, options = {}) {
  const { allowMasks = true } = options;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await clickConsent(page, config);
  const effectiveConfig = allowMasks ? config : { ...config, maskSelectors: [] };
  await stabilizePage(page, effectiveConfig);
  await page.screenshot({ path: outputPath, fullPage: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function writePng(filePath, png) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function compareImages(baselinePath, currentPath, diffPath) {
  const baseline = readPng(baselinePath);
  const current = readPng(currentPath);

  const width = Math.max(baseline.width, current.width);
  const height = Math.max(baseline.height, current.height);

  const baselinePadded = new PNG({ width, height, fill: true });
  const currentPadded = new PNG({ width, height, fill: true });

  PNG.bitblt(baseline, baselinePadded, 0, 0, baseline.width, baseline.height, 0, 0);
  PNG.bitblt(current, currentPadded, 0, 0, current.width, current.height, 0, 0);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    baselinePadded.data,
    currentPadded.data,
    diff.data,
    width,
    height,
    { threshold: 0.1, includeAA: true }
  );

  writePng(diffPath, diff);
  const totalPixels = width * height;
  const diffPercent = totalPixels ? (diffPixels / totalPixels) * 100 : 0;
  return diffPercent;
}

function computeConfidence(diffPercent, maskCount, weights) {
  const safeDiff = Math.max(0, Math.min(100, diffPercent));
  const diffScore = 100 - safeDiff;
  const maskPenalty = Math.min(maskCount * 2, 40);
  const maskScore = Math.max(0, 100 - maskPenalty);
  const diffWeight = weights.diffPercent ?? 0.7;
  const maskWeight = weights.maskedSelectors ?? 0.3;
  const total = diffWeight + maskWeight || 1;
  const score = (diffScore * diffWeight + maskScore * maskWeight) / total;
  return Math.round(score);
}

async function run() {
  const chromiumPath = resolveBrowserExecutable(chromium);
  if (!chromiumPath) {
    console.error('Playwright browsers not found. Run "npx playwright install" (or set PLAYWRIGHT_BROWSERS_PATH).');
    process.exit(1);
  }

  const urls = await resolveUrls();
  if (!urls.length) {
    throw new Error('No URLs to process.');
  }

  const config = loadVisualConfig();
  if (config.warnings && config.warnings.length) {
    config.warnings.forEach((w) => console.warn(w));
  }
  const results = [];

  for (const projectName of projects) {
    const project = projectConfigs[projectName];
    if (!project) {
      console.warn(`Unknown project: ${projectName}`);
      continue;
    }

    const contextAuth =
      mode === 'baseline'
        ? baseAuthUser && baseAuthPass
          ? { username: baseAuthUser, password: baseAuthPass }
          : undefined
        : targetAuthUser && targetAuthPass
          ? { username: targetAuthUser, password: targetAuthPass }
          : undefined;

    // CQ-004: Wrap browser lifecycle in try-finally so the process is never
    // left with a dangling browser instance if an error occurs mid-scan.
    const browser = await project.browserType.launch({ headless });
    try {
    const context = await browser.newContext({
      ...project.context,
      ignoreHTTPSErrors: true,
      locale: 'en-GB',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      httpCredentials: contextAuth
    });

    const page = await context.newPage();

    for (const url of urls) {
      const slug = urlToSlug(url);
      const baselineUrl = singleBaseline || (baseUrl ? replaceOrigin(url, baseUrl) : url);
      const currentUrl = singleTarget || (targetUrl ? replaceOrigin(url, targetUrl) : url);

      const baselineDir = path.join(reportsRoot, 'baseline', projectName);
      const currentDir = path.join(reportsRoot, 'current', projectName);
      const diffDir = path.join(reportsRoot, 'diff', projectName);

      ensureDir(baselineDir);
      ensureDir(currentDir);
      ensureDir(diffDir);

      const baselinePath = path.join(baselineDir, `${slug}.png`);
      const currentPath = path.join(currentDir, `${slug}.png`);
      const diffPath = path.join(diffDir, `${slug}.png`);

      if (mode === 'baseline') {
        await captureScreenshot(page, baselineUrl, baselinePath, config);
        let note = '';
        const first = isBlankImage(baselinePath);
        if (first.blank) {
          await captureScreenshot(page, baselineUrl, baselinePath, config, { allowMasks: false });
          const second = isBlankImage(baselinePath);
          note = second.blank ? 'blank after retry' : 'blank fixed after retry';
        }
        results.push({
          url,
          project: projectName,
          baselineUrl,
          currentUrl: '',
          status: note === 'blank after retry' ? 'BLANK' : 'BASELINE',
          diffPercent: '',
          confidenceScore: '',
          maskedSelectors: config.maskSelectors.length,
          baselinePath: path.relative(cwd, baselinePath),
          note
        });
      } else {
        if (!fs.existsSync(baselinePath)) {
          console.warn(`Missing baseline: ${baselinePath}`);
          continue;
        }
        await captureScreenshot(page, currentUrl, currentPath, config);
        let note = '';
        const first = isBlankImage(currentPath);
        if (first.blank) {
          await captureScreenshot(page, currentUrl, currentPath, config, { allowMasks: false });
          const second = isBlankImage(currentPath);
          note = second.blank ? 'blank after retry' : 'blank fixed after retry';
        }
        if (note === 'blank after retry') {
          results.push({
            url,
            project: projectName,
            baselineUrl,
            currentUrl,
            status: 'BLANK',
            diffPercent: '',
            confidenceScore: '',
            maskedSelectors: config.maskSelectors.length,
            baselinePath: path.relative(cwd, baselinePath),
            currentPath: path.relative(cwd, currentPath),
            diffPath: '',
            note
          });
        } else {
          const diffPercent = compareImages(baselinePath, currentPath, diffPath);
          const status = diffPercent > diffThreshold ? 'FAIL' : 'PASS';
          const confidenceScore = computeConfidence(diffPercent, config.maskSelectors.length, config.confidenceWeights);
          results.push({
            url,
            project: projectName,
            baselineUrl,
            currentUrl,
            status,
            diffPercent: diffPercent.toFixed(3),
            confidenceScore,
            maskedSelectors: config.maskSelectors.length,
            baselinePath: path.relative(cwd, baselinePath),
            currentPath: path.relative(cwd, currentPath),
            diffPath: path.relative(cwd, diffPath),
            note
          });
        }
      }
    }

    await context.close();
    } finally {
      await browser.close();
    }
  }

  ensureDir(reportsRoot);
  const csvPath = path.join(reportsRoot, 'visual_results.csv');
  const headers = [
    'url',
    'project',
    'baselineUrl',
    'currentUrl',
    'status',
    'diffPercent',
    'confidenceScore',
    'maskedSelectors',
    'baselinePath',
    'currentPath',
    'diffPath',
    'note'
  ];
  const lines = [headers.join(',')];
  for (const row of results) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','));
  }
  fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
  console.log(`Visual results saved to ${csvPath}`);
}

run().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
