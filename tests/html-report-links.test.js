const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('html report wires token-safe asset links and page-failures navigation', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-html-links-'));
  const client = 'linkclient';
  const reportsDir = path.join(tmpRoot, 'reports', client);
  fs.mkdirSync(path.join(reportsDir, 'lighthouse'), { recursive: true });
  fs.mkdirSync(path.join(reportsDir, 'screenshots'), { recursive: true });

  fs.writeFileSync(
    path.join(reportsDir, 'results.csv'),
    [
      'url,status,browser,device,viewport,failReasons,screenshotPath,lighthouseReportHtml,lighthouseReportJson',
      `https://example.com/,FAIL,chromium,desktop,1920x1080,page errors,${path.join(reportsDir, 'screenshots', 'issue-1.png')},${path.join(reportsDir, 'lighthouse', 'index.html')},`
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(reportsDir, 'site_summary.csv'),
    [
      'Issue,Count,Example,Category,Severity,ExampleURL,Recommendation,Global,CanonicalKey,Actionability,Ownership,JourneyScope',
      'Missing Alt Text,1,img without alt,accessibility,major,https://example.com/,Add alt text,no,axe|missing alt text|img|url,actionable,first_party,url'
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    path.join(reportsDir, 'issues.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        client,
        issues: [
          {
            Category: 'accessibility',
            Severity: 'major',
            Title: 'Missing Alt Text',
            Description: 'Image has no alt text',
            Element: '<img>',
            Recommendation: 'Add alt text',
            URL: 'https://example.com/',
            screenshotPath: path.join(reportsDir, 'screenshots', 'issue-1.png'),
            canonicalKey: 'axe|missing alt text|img|url',
            actionability: 'actionable',
            ownership: 'first_party',
            journeyScope: 'url'
          }
        ],
        summary: []
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    path.join(reportsDir, 'run_meta.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        client,
        state: 'complete',
        run: {
          quick: false,
          full: false,
          projects: ['chrome-desktop-1920'],
          workers: null,
          interrupted: false,
          playwrightExitCode: 1
        },
        counts: { inputUrls: 1, resultRows: 1, uniqueUrls: 1, issueRows: 1, summaryRows: 1, blockedSamples: 0 }
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(path.join(reportsDir, 'QA_Report.xlsx'), 'placeholder', 'utf8');
  fs.writeFileSync(path.join(reportsDir, 'QA_Report.pdf'), 'placeholder', 'utf8');

  const script = path.join(process.cwd(), 'reporting', 'generate-html-report.js');
  const run = spawnSync(process.execPath, [script, client], {
    env: {
      ...process.env,
      BASELINE_ROOT: tmpRoot,
      NO_AUTO_OPEN: 'true',
      REPORT_CLIENT_LABEL: 'Example Site'
    }
  });
  assert.equal(run.status, 0, run.stderr && run.stderr.toString());

  const htmlPath = path.join(reportsDir, 'qa_html', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(html.includes('id="exportCsvBtn"'));
  assert.ok(html.includes('id="exportCsvBtnSticky"'));
  assert.ok(html.includes('id="openPdfBtn"'));
  assert.ok(html.includes('id="openPdfBtnSticky"'));
  assert.ok(html.includes('id="openExcelBtn"'));
  assert.ok(html.includes('id="openExcelBtnSticky"'));
  assert.ok(html.includes('id="goToPageFailuresBtn"'));
  assert.ok(html.includes('function withReportToken(urlValue)'));
  assert.ok(html.includes('/^https?:\\/\\//i.test(href)'));
  assert.ok(html.includes('wireStaticAssetButtons()'));
  assert.ok(html.includes("rawInitialHash === 'page-failures'"));
  assert.ok(html.includes("activateTab('pages')"));
  assert.ok(html.includes('"clientLabel":"Example Site"'));
  assert.ok(html.includes('Client: Example Site'));
});
