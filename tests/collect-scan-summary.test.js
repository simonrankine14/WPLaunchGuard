const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('collect-scan-summary prefers deduped summary totals for issues_total', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wplg-summary-'));
  try {
    const reportDir = path.join(tmpRoot, 'reports', 'summaryclient');
    fs.mkdirSync(reportDir, { recursive: true });

    fs.writeFileSync(
      path.join(reportDir, 'issues.json'),
      JSON.stringify(
        {
          generatedAt: '2026-03-05T00:00:00.000Z',
          totals: {
            issues: 9152,
            summary: 309
          },
          issues: [
            { Category: 'functionality', Severity: 'major', Title: 'Console Error', URL: 'https://example.com/' }
          ]
        },
        null,
        2
      ),
      'utf8'
    );

    fs.writeFileSync(
      path.join(reportDir, 'run_meta.json'),
      JSON.stringify(
        {
          state: 'partial',
          counts: {
            inputUrls: 64,
            uniqueUrls: 62,
            issueRows: 309,
            issueRowsRaw: 9152,
            summaryRows: 309
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const script = path.join(process.cwd(), 'scripts', 'ci', 'collect-scan-summary.js');
    const run = spawnSync(process.execPath, [script, reportDir, 'summaryclient']);
    assert.equal(run.status, 0, run.stderr && run.stderr.toString());

    const payload = JSON.parse(run.stdout.toString('utf8'));
    assert.equal(payload.issues_total, 309);
    assert.equal(payload.issue_rows_total, 9152);
    assert.equal(payload.issue_summary_total, 309);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
