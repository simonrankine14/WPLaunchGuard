const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { resolveClientReportsDir, resolveRunRoot, validateClientId } = require('../scripts/lib/safe-paths');
const { safeHtml } = require('../scripts/lib/html-utils');
const { parseCSV } = require('../scripts/lib/csv-utils');

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function sanitizeHexColor(value, fallback) {
  const candidate = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(candidate)) return candidate;
  return fallback;
}

function toScore(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function roundAverage(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round(total / values.length);
}

function buildScoreAverages(results) {
  const perUrl = new Map();
  results.forEach((row) => {
    const url = String(row.url || '').trim();
    if (!url) return;
    const entry = perUrl.get(url) || {
      performance: [],
      accessibility: [],
      bestPractices: [],
      seo: []
    };
    const performance = toScore(row.lighthousePerformance);
    const accessibility = toScore(row.lighthouseAccessibility);
    const bestPractices = toScore(row.lighthouseBestPractices);
    const seo = toScore(row.lighthouseSEO);
    if (performance !== null) entry.performance.push(performance);
    if (accessibility !== null) entry.accessibility.push(accessibility);
    if (bestPractices !== null) entry.bestPractices.push(bestPractices);
    if (seo !== null) entry.seo.push(seo);
    perUrl.set(url, entry);
  });

  const pageAverages = {
    performance: [],
    accessibility: [],
    bestPractices: [],
    seo: []
  };

  perUrl.forEach((entry) => {
    const performance = roundAverage(entry.performance);
    const accessibility = roundAverage(entry.accessibility);
    const bestPractices = roundAverage(entry.bestPractices);
    const seo = roundAverage(entry.seo);
    if (performance !== null) pageAverages.performance.push(performance);
    if (accessibility !== null) pageAverages.accessibility.push(accessibility);
    if (bestPractices !== null) pageAverages.bestPractices.push(bestPractices);
    if (seo !== null) pageAverages.seo.push(seo);
  });

  return {
    performance: roundAverage(pageAverages.performance),
    accessibility: roundAverage(pageAverages.accessibility),
    bestPractices: roundAverage(pageAverages.bestPractices),
    seo: roundAverage(pageAverages.seo),
    pageCounts: {
      performance: pageAverages.performance.length,
      accessibility: pageAverages.accessibility.length,
      bestPractices: pageAverages.bestPractices.length,
      seo: pageAverages.seo.length
    }
  };
}

function buildFailingPages(results) {
  const perUrl = new Map();
  results.forEach((row) => {
    const status = String(row.status || '').trim().toUpperCase();
    if (!['FAIL', 'BLOCKED', 'ERROR'].includes(status)) return;
    const url = String(row.url || '').trim();
    if (!url) return;
    const existing = perUrl.get(url) || {
      url,
      failures: 0,
      statuses: new Set(),
      reasons: new Set()
    };
    existing.failures += 1;
    existing.statuses.add(status);
    const reason = String(row.failReasons || row.blockedReason || row.error || '').trim();
    if (reason) existing.reasons.add(reason);
    perUrl.set(url, existing);
  });

  return Array.from(perUrl.values())
    .map((row) => ({
      url: row.url,
      failures: row.failures,
      status: Array.from(row.statuses).join(', '),
      reason: Array.from(row.reasons).slice(0, 2).join(' | ')
    }))
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 10);
}

function buildTopIssues(summaryRows) {
  return summaryRows
    .slice()
    .sort((a, b) => Number(b.Count || 0) - Number(a.Count || 0))
    .slice(0, 8)
    .map((row) => ({
      issue: String(row.Issue || '').trim(),
      count: Number(row.Count || 0),
      category: String(row.Category || '').trim(),
      severity: String(row.Severity || '').trim(),
      recommendation: String(row.Recommendation || '').trim()
    }));
}

function buildPdfReportModel(clientName, results, summaryRows, runMeta, clientLabel) {
  const uniqueUrls = new Set(results.map((row) => String(row.url || '').trim()).filter(Boolean));
  const statusCounts = {
    passed: results.filter((row) => String(row.status || '').toUpperCase() === 'PASS').length,
    failed: results.filter((row) => String(row.status || '').toUpperCase() === 'FAIL').length,
    blocked: results.filter((row) => String(row.status || '').toUpperCase() === 'BLOCKED').length,
    errored: results.filter((row) => String(row.status || '').toUpperCase() === 'ERROR').length
  };

  return {
    clientName,
    clientLabel: String(clientLabel || '').trim() || clientName,
    generatedAt: String(runMeta?.generatedAt || new Date().toISOString()),
    runState: String(runMeta?.state || 'complete'),
    totalUrls: uniqueUrls.size,
    totalRuns: results.length,
    statuses: statusCounts,
    lighthouseAverages: buildScoreAverages(results),
    topIssues: buildTopIssues(summaryRows),
    failingPages: buildFailingPages(results)
  };
}

function buildPdfBranding() {
  const brandName = String(process.env.REPORT_BRAND_NAME || '').trim();
  const brandLogoUrl = String(process.env.REPORT_BRAND_LOGO_URL || '').trim();
  const brandPrimaryColor = sanitizeHexColor(process.env.REPORT_BRAND_PRIMARY_COLOR, '#2f86c3');
  const brandAccentColor = sanitizeHexColor(process.env.REPORT_BRAND_ACCENT_COLOR, '#34b3a0');
  const brandFooterText = String(process.env.REPORT_BRAND_FOOTER_TEXT || '').trim();
  const hideBaselineBranding = toBool(process.env.REPORT_HIDE_BASELINE_BRANDING);
  const useCustomBrand = hideBaselineBranding && brandName.length > 0;
  const reportDisplayName = useCustomBrand ? brandName : 'Baseline';
  const reportLogoText = useCustomBrand ? String(brandName[0] || 'B').toUpperCase() : 'B';

  return {
    reportDisplayName,
    reportLogoText,
    logoUrl: useCustomBrand ? brandLogoUrl : '',
    primaryColor: brandPrimaryColor,
    accentColor: brandAccentColor,
    footerText: brandFooterText
  };
}

function scoreMarkup(label, value, count) {
  const displayValue = value === null ? 'n/a' : `${value}`;
  const displayCount = count > 0 ? `${count} pages` : 'no Lighthouse data';
  return `
    <div class="scoreCard">
      <div class="scoreLabel">${safeHtml(label)}</div>
      <div class="scoreValue">${safeHtml(displayValue)}</div>
      <div class="scoreMeta">${safeHtml(displayCount)}</div>
    </div>
  `;
}

function tableRows(rows, renderRow) {
  if (!rows.length) {
    return '<tr><td colspan="5" class="empty">No data available for this report.</td></tr>';
  }
  return rows.map(renderRow).join('');
}

function renderPdfHtml(model) {
  const brand = model.branding || buildPdfBranding();
  const logoMarkup = brand.logoUrl
    ? `<img class="brandLogoImage" src="${safeHtml(brand.logoUrl)}" alt="${safeHtml(brand.reportDisplayName)} logo" />`
    : `<div class="brandLogoText">${safeHtml(brand.reportLogoText)}</div>`;
  const averages = model.lighthouseAverages;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${safeHtml(model.clientLabel)} PDF Report</title>
  <style>
    :root {
      --brand-primary: ${safeHtml(brand.primaryColor)};
      --brand-accent: ${safeHtml(brand.accentColor)};
    }
    @page { margin: 18mm 14mm; }
    body { font-family: Arial, sans-serif; color: #172033; margin: 0; }
    h1, h2, h3, p { margin: 0; }
    .page { width: 100%; }
    .hero { border-bottom: 2px solid #d7e0ea; padding-bottom: 14px; margin-bottom: 18px; }
    .brandBar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .brandLogoImage { width: 36px; height: 36px; border-radius: 8px; object-fit: contain; border: 1px solid #d7e0ea; background: #fff; padding: 4px; }
    .brandLogoText { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--brand-primary); color: #fff; font-size: 16px; font-weight: 700; }
    .brandName { font-size: 16px; font-weight: 700; color: #172033; }
    .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #4b6478; margin-bottom: 8px; }
    .title { font-size: 26px; font-weight: 700; margin-bottom: 8px; }
    .meta { font-size: 12px; color: #4b6478; }
    .summaryGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0; }
    .summaryCard, .scoreCard { border: 1px solid #d7e0ea; border-radius: 10px; padding: 12px; background: #f8fbfd; }
    .summaryLabel, .scoreLabel { font-size: 11px; text-transform: uppercase; color: #4b6478; margin-bottom: 6px; }
    .summaryValue, .scoreValue { font-size: 22px; font-weight: 700; color: #172033; }
    .section { margin-top: 18px; }
    .sectionTitle { font-size: 16px; font-weight: 700; margin-bottom: 10px; color: var(--brand-primary); }
    .scoreGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .scoreMeta { font-size: 11px; color: #4b6478; margin-top: 4px; }
    .note { font-size: 11px; color: #4b6478; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border-bottom: 1px solid #d7e0ea; padding: 8px 6px; text-align: left; vertical-align: top; }
    th { text-transform: uppercase; font-size: 10px; color: #4b6478; letter-spacing: 0.05em; }
    .empty { color: #4b6478; text-align: center; padding: 18px 6px; }
    .footer { margin-top: 18px; font-size: 10px; color: #4b6478; border-top: 1px solid #d7e0ea; padding-top: 8px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div class="brandBar">
        ${logoMarkup}
        <div class="brandName">${safeHtml(brand.reportDisplayName)}</div>
      </div>
      <div class="eyebrow">${safeHtml(brand.reportDisplayName)} WordPress QA Summary PDF</div>
      <div class="title">${safeHtml(model.clientLabel)}</div>
      <div class="meta">Generated ${safeHtml(model.generatedAt)} • Run state: ${safeHtml(model.runState)}</div>
    </div>

    <div class="summaryGrid">
      <div class="summaryCard"><div class="summaryLabel">URLs Scanned</div><div class="summaryValue">${safeHtml(model.totalUrls)}</div></div>
      <div class="summaryCard"><div class="summaryLabel">Page Runs</div><div class="summaryValue">${safeHtml(model.totalRuns)}</div></div>
      <div class="summaryCard"><div class="summaryLabel">Passed</div><div class="summaryValue">${safeHtml(model.statuses.passed)}</div></div>
      <div class="summaryCard"><div class="summaryLabel">Failed / Blocked / Error</div><div class="summaryValue">${safeHtml(model.statuses.failed + model.statuses.blocked + model.statuses.errored)}</div></div>
    </div>

    <div class="section">
      <div class="sectionTitle">Sitewide Lighthouse Averages</div>
      <div class="scoreGrid">
        ${scoreMarkup('Performance', averages.performance, averages.pageCounts.performance)}
        ${scoreMarkup('Accessibility', averages.accessibility, averages.pageCounts.accessibility)}
        ${scoreMarkup('Best Practices', averages.bestPractices, averages.pageCounts.bestPractices)}
        ${scoreMarkup('SEO', averages.seo, averages.pageCounts.seo)}
      </div>
      <div class="note">Averages are calculated across unique pages with Lighthouse data. Screenshot evidence is intentionally excluded from this PDF.</div>
    </div>

    <div class="section">
      <div class="sectionTitle">Top Issue Families</div>
      <table>
        <thead>
          <tr>
            <th>Issue</th>
            <th>Count</th>
            <th>Category</th>
            <th>Severity</th>
            <th>Recommendation</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows(model.topIssues, (row) => `
            <tr>
              <td>${safeHtml(row.issue)}</td>
              <td>${safeHtml(row.count)}</td>
              <td>${safeHtml(row.category)}</td>
              <td>${safeHtml(row.severity)}</td>
              <td>${safeHtml(row.recommendation)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>

    <div class="section">
      <div class="sectionTitle">Top Failing Pages</div>
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Failing Runs</th>
            <th>Status</th>
            <th>Primary Reason</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows(model.failingPages, (row) => `
            <tr>
              <td>${safeHtml(row.url)}</td>
              <td>${safeHtml(row.failures)}</td>
              <td>${safeHtml(row.status)}</td>
              <td>${safeHtml(row.reason)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>

    <div class="footer">${safeHtml(brand.footerText || 'This PDF is a client-safe summary. Use the HTML report for interactive evidence and detailed diagnostics.')}</div>
  </div>
</body>
</html>`;
}

async function generatePdfReport(clientName) {
  const safeClientName = validateClientId(clientName);
  const packageRoot = path.join(__dirname, '..');
  const runRoot = resolveRunRoot(process.env, packageRoot);
  const reportsDir = resolveClientReportsDir(runRoot, safeClientName);
  const resultsPath = path.join(reportsDir, 'results.csv');
  const summaryPath = path.join(reportsDir, 'site_summary.csv');
  const runMetaPath = path.join(reportsDir, 'run_meta.json');
  const outputPath = path.join(reportsDir, 'QA_Report.pdf');

  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Missing results.csv at ${resultsPath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Missing site_summary.csv at ${summaryPath}`);
  }

  const results = parseCSV(fs.readFileSync(resultsPath, 'utf8'));
  const summaryRows = parseCSV(fs.readFileSync(summaryPath, 'utf8'));
  let runMeta = {};
  if (fs.existsSync(runMetaPath)) {
    try {
      runMeta = JSON.parse(fs.readFileSync(runMetaPath, 'utf8'));
    } catch (error) {
      console.warn(`[pdf-report] Invalid run_meta.json at ${runMetaPath}; using safe defaults. ${String(error.message || error)}`);
      runMeta = {};
    }
  }
  const model = buildPdfReportModel(
    safeClientName,
    results,
    summaryRows,
    runMeta,
    String(process.env.REPORT_CLIENT_LABEL || '').trim()
  );
  model.branding = buildPdfBranding();
  const html = renderPdfHtml(model);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '16mm',
        right: '12mm',
        bottom: '16mm',
        left: '12mm'
      }
    });
  } catch (error) {
    throw new Error(`PDF generation failed. Ensure Playwright Chromium is installed. ${String(error.message || error)}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return outputPath;
}

if (require.main === module) {
  const clientName = process.argv[2];
  if (!clientName) {
    console.error('Usage: node reporting/generate-pdf-report.js <clientname>');
    process.exit(1);
  }

  generatePdfReport(clientName)
    .then((outputPath) => {
      console.log(`PDF report saved to ${outputPath}`);
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = {
  buildPdfBranding,
  buildPdfReportModel,
  generatePdfReport,
  parseCSV,
  renderPdfHtml
};
