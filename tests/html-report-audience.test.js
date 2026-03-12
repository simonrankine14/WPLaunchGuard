const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('html report includes audience toggle and default audience wiring', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-html-'));
  try {
    const client = 'audienceclient';
    const reportsDir = path.join(tmpRoot, 'reports', client);
    fs.mkdirSync(reportsDir, { recursive: true });

    fs.writeFileSync(
      path.join(reportsDir, 'results.csv'),
      [
        'url,status,browser,device,viewport,failReasons,screenshotPath,lighthouseReportHtml,lighthouseReportJson',
        'https://example.com/,FAIL,chromium,desktop,1920x1080,page errors,,,'
      ].join('\n'),
      'utf8'
    );

  fs.writeFileSync(
    path.join(reportsDir, 'site_summary.csv'),
    [
      'Issue,Count,Example,Category,Severity,ExampleURL,Recommendation,Global,CanonicalKey,Actionability,Ownership,JourneyScope',
      'Page Runtime Error,1,TypeError,functionality,critical,https://example.com/,Fix error,no,console|page runtime error|typeerror|url,actionable,first_party,url'
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
            Category: 'functionality',
            Severity: 'critical',
            Title: 'Page Runtime Error',
            Description: 'Runtime issue',
            Element: 'TypeError',
            Recommendation: 'Fix',
            URL: 'https://example.com/',
            _source: 'page',
            canonicalKey: 'console|page runtime error|typeerror|url',
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
        run: { quick: false, full: false, projects: ['chrome-desktop-1920'], workers: null, interrupted: false, playwrightExitCode: 1 },
        counts: { inputUrls: 1, resultRows: 1, uniqueUrls: 1, issueRows: 1, summaryRows: 1, blockedSamples: 0 }
      },
      null,
      2
    ),
    'utf8'
  );

    const script = path.join(process.cwd(), 'reporting', 'generate-html-report.js');
    const run = spawnSync(process.execPath, [script, client], {
      env: {
        ...process.env,
        BASELINE_ROOT: tmpRoot,
        NO_AUTO_OPEN: 'true',
        REPORT_AUDIENCE_DEFAULT: 'developer'
      }
    });
    assert.equal(run.status, 0, run.stderr && run.stderr.toString());

    const htmlPath = path.join(reportsDir, 'qa_html', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('id="audienceToggle"'));
    assert.ok(html.includes('id="audienceToggleSticky"'));
    assert.ok(html.includes('id="audienceModeNote"'));
    assert.ok(html.includes('id="audienceHero"'));
    assert.ok(html.includes('id="audienceHeadPill"'));
    assert.ok(html.includes('data-audience-toggle="1"'));
    assert.ok(html.includes('Switch to Developer View'));
    assert.ok(html.includes('window.__baselineToggleAudience'));
    assert.ok(html.includes('"defaultAudience":"developer"'));
    assert.ok(html.includes('function readStoredAudience()'));
    assert.ok(html.includes('function renderAudienceHero()'));
    assert.ok(html.includes('function buildIssueFamilies('));
    assert.ok(html.includes('issueFamilyAccordion'));
    assert.ok(html.includes("btn.setAttribute('aria-pressed'"));
    assert.ok(html.includes("btn.setAttribute('data-audience-current'"));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
