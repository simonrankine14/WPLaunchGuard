const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { resolveClientReportsDir, resolveRunRoot, validateClientId } = require('../scripts/lib/safe-paths');
const { parseCSV } = require('../scripts/lib/csv-utils');

function sanitizeSpreadsheetValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/^[\t\r\n ]*[=+\-@]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

function sanitizeRowObject(row) {
  const output = {};
  Object.entries(row || {}).forEach(([key, value]) => {
    output[key] = typeof value === 'string' ? sanitizeSpreadsheetValue(value) : value;
  });
  return output;
}

async function generate(clientName) {
  const safeClientName = validateClientId(clientName);
  const packageRoot = path.join(__dirname, '..');
  const runRoot = resolveRunRoot(process.env, packageRoot);
  const reportsDir = resolveClientReportsDir(runRoot, safeClientName);
  const resultsPath = path.join(reportsDir, 'results.csv');
  const summaryPath = path.join(reportsDir, 'site_summary.csv');
  const outputPath = path.join(reportsDir, 'QA_Report.xlsx');

  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Missing results.csv at ${resultsPath}`);
  }

  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Missing site_summary.csv at ${summaryPath}`);
  }

  const results = parseCSV(fs.readFileSync(resultsPath, 'utf8'));
  const summary = parseCSV(fs.readFileSync(summaryPath, 'utf8'));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WordPress QA Suite';
  workbook.created = new Date();

  const dashboard = workbook.addWorksheet('Dashboard');
  const globalIssues = workbook.addWorksheet('Global Issues');
  const failedPages = workbook.addWorksheet('Failed Pages');
  const evidence = workbook.addWorksheet('Evidence');

  const totalUrls = new Set(results.map((row) => row.url)).size;
  const totalRuns = results.length;
  const failed = results.filter((row) => row.status === 'FAIL');
  const passed = results.filter((row) => row.status === 'PASS');
  const blocked = results.filter((row) => row.status === 'BLOCKED');
  const errored = results.filter((row) => row.status === 'ERROR');

  const lighthouseIssues = results.filter((row) => {
    const perf = Number(row.lighthousePerformance || 0);
    const seo = Number(row.lighthouseSEO || 0);
    const bp = Number(row.lighthouseBestPractices || 0);
    const acc = Number(row.lighthouseAccessibility || 0);
    return (perf && perf < 60) || (seo && seo < 70) || (bp && bp < 70) || (acc && acc < 80);
  });

  const failuresByBrowser = {};
  failed.forEach((row) => {
    const key = row.browser || 'unknown';
    failuresByBrowser[key] = (failuresByBrowser[key] || 0) + 1;
  });

  dashboard.columns = [
    { header: 'Metric', key: 'metric', width: 35 },
    { header: 'Value', key: 'value', width: 25 }
  ];

  dashboard.addRows([
    { metric: 'Client', value: safeClientName },
    { metric: 'Pages Passed', value: passed.length },
    { metric: 'Pages Failed', value: failed.length },
    { metric: 'Pages Blocked (Could Not Load)', value: blocked.length },
    { metric: 'Pages Error (Runner/Check Error)', value: errored.length },
    { metric: 'Browsers With Failures', value: Object.keys(failuresByBrowser).length },
    { metric: 'Global Issues (Summary Rows)', value: summary.length },
    {
      metric: 'Lighthouse Template Issues Detected',
      value: lighthouseIssues.length > 0 ? `${lighthouseIssues.length} pages` : 'none'
    },
    { metric: 'Total URLs Tested', value: totalUrls },
    { metric: 'Total Runs (URL x Browser)', value: totalRuns }
  ]);

  // Top systemic issues (simple heuristic from site summary)
  const topSystemic = summary
    .slice()
    .filter((row) => String(row.Global || '').toLowerCase() === 'yes')
    .sort((a, b) => Number(b.Count || 0) - Number(a.Count || 0))
    .slice(0, 3);

  if (topSystemic.length > 0) {
    dashboard.addRow({ metric: '', value: '' });
    dashboard.addRow({ metric: 'Top Systemic Issues', value: '' });
    topSystemic.forEach((row) => {
      dashboard.addRow({
        metric: sanitizeSpreadsheetValue(row.Issue),
        value: row.Count
      });
    });
  }

  dashboard.addRow({ metric: '', value: '' });
  dashboard.addRow({ metric: 'Failures by Browser', value: '' });
  Object.entries(failuresByBrowser).forEach(([browser, count]) => {
    dashboard.addRow({ metric: sanitizeSpreadsheetValue(browser), value: count });
  });

  dashboard.getColumn('value').eachCell((cell) => {
    if (typeof cell.value === 'number') {
      cell.numFmt = '0';
    }
  });

  dashboard.getRow(1).font = { bold: true, size: 14 };
  dashboard.getRow(2).font = { bold: true, size: 12 };
  dashboard.getRow(3).font = { bold: true, size: 12 };

  dashboard.addConditionalFormatting({
    ref: `B2:B3`,
    rules: [
      {
        type: 'expression',
        formulae: ['B2>=0'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'C6EFCE' } } }
      },
      {
        type: 'expression',
        formulae: ['B3>0'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC7CE' } } }
      }
    ]
  });

  globalIssues.columns = [
    { header: 'Issue', key: 'Issue', width: 40 },
    { header: 'Count', key: 'Count', width: 12 },
    { header: 'Severity', key: 'Severity', width: 12 },
    { header: 'Category', key: 'Category', width: 14 },
    { header: 'Example', key: 'Example', width: 60 },
    { header: 'ExampleURL', key: 'ExampleURL', width: 40 },
    { header: 'Recommendation', key: 'Recommendation', width: 60 },
    { header: 'Global', key: 'Global', width: 10 }
  ];
  summary.forEach((row) => globalIssues.addRow(row));
  globalIssues.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      if (typeof cell.value === 'string') {
        cell.value = sanitizeSpreadsheetValue(cell.value);
      }
    });
  });

  globalIssues.addConditionalFormatting({
    ref: `C2:C${summary.length + 1}`,
    rules: [
      {
        type: 'expression',
        formulae: ['C2=\"critical\"'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC7CE' } } }
      },
      {
        type: 'expression',
        formulae: ['C2=\"major\"'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFEB9C' } } }
      },
      {
        type: 'expression',
        formulae: ['C2=\"minor\"'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'E7E6E6' } } }
      }
    ]
  });

  failedPages.columns = [
    { header: 'URL', key: 'url', width: 45 },
    { header: 'Browser', key: 'browser', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Reason', key: 'reason', width: 45 },
    { header: 'Screenshot', key: 'screenshotPath', width: 45 }
  ];
  const failedOrBlocked = results.filter((row) => row.status === 'FAIL' || row.status === 'BLOCKED' || row.status === 'ERROR');
  failedOrBlocked.forEach((row) => {
    const record = failedPages.addRow(sanitizeRowObject({
      ...row,
      reason: row.status === 'BLOCKED' ? (row.blockedReason || row.error || '') : (row.failReasons || row.error || '')
    }));
    const screenshotCell = record.getCell('screenshotPath');
    if (row.screenshotPath) {
      const first = row.screenshotPath.split(' | ')[0];
      screenshotCell.value = { text: 'Open Screenshot', hyperlink: first };
    }
  });

  evidence.columns = [
    { header: 'URL', key: 'url', width: 45 },
    { header: 'Browser', key: 'browser', width: 16 },
    { header: 'Lighthouse HTML', key: 'lighthouseReportHtml', width: 45 },
    { header: 'Lighthouse JSON', key: 'lighthouseReportJson', width: 45 },
    { header: 'Screenshot', key: 'screenshotPath', width: 45 }
  ];
  results
    .filter((row) => row.lighthouseReportHtml || row.screenshotPath)
    .forEach((row) => evidence.addRow(sanitizeRowObject(row)));

  await workbook.xlsx.writeFile(outputPath);
  console.log(`Report saved to ${outputPath}`);
}

const clientName = process.argv[2] || 'default';

generate(clientName).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
