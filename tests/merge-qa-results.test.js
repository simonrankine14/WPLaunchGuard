const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

function parseCsv(content) {
  const lines = content.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const parseLine = (line) => {
    const out = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      const n = line[i + 1];
      if (c === '"') {
        if (inQuotes && n === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === ',' && !inQuotes) {
        out.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    out.push(current);
    return out;
  };

  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? '';
    });
    return row;
  });
}

test('merge outputs consistent effective issues and summary', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-merge-'));
  const client = 'mergeclient';
  const shardDir = path.join(tmpRoot, 'reports', client, '.tmp', 'shards');
  fs.mkdirSync(shardDir, { recursive: true });

  const shardPayload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runStartedAt: 'run-1',
    client,
    projectName: 'chrome-desktop-1920',
    workerIndex: 0,
    pid: process.pid,
    totalInputUrls: 2,
    results: [
      { url: 'https://example.com/a', status: 'FAIL', browser: 'chromium', device: 'desktop', viewport: '1920x1080' },
      { url: 'https://example.com/b', status: 'FAIL', browser: 'chromium', device: 'desktop', viewport: '1920x1080' }
    ],
    issues: [
      {
        Category: 'accessibility',
        Severity: 'major',
        Title: 'Frames must have an accessible name',
        Description: '',
        Element: '.widget iframe',
        Recommendation: 'Fix frame title',
        URL: 'https://example.com/a',
        _source: 'axe'
      },
      {
        Category: 'accessibility',
        Severity: 'major',
        Title: 'Frames must have an accessible name',
        Description: '',
        Element: '.widget iframe',
        Recommendation: 'Fix frame title',
        URL: 'https://example.com/b',
        _source: 'axe'
      },
      {
        Category: 'functionality',
        Severity: 'major',
        Title: 'Broken Link',
        Description: '',
        Element: 'https://example.com/missing',
        Recommendation: 'Fix link',
        URL: 'https://example.com/a',
        _source: 'links'
      }
    ],
    blockedSamples: []
  };

  fs.writeFileSync(path.join(shardDir, 's1.json'), JSON.stringify(shardPayload), 'utf8');

  const script = path.join(process.cwd(), 'scripts', 'merge-qa-results.js');
  const run = spawnSync(process.execPath, [script, client], {
    env: {
      ...process.env,
      BASELINE_ROOT: tmpRoot,
      RUN_STARTED_AT: 'run-1',
      QA_WORKERS: ''
    }
  });
  assert.equal(run.status, 0, run.stderr && run.stderr.toString());

  const reportsDir = path.join(tmpRoot, 'reports', client);
  const issuesJson = JSON.parse(fs.readFileSync(path.join(reportsDir, 'issues.json'), 'utf8'));
  const summaryRows = parseCsv(fs.readFileSync(path.join(reportsDir, 'site_summary.csv'), 'utf8'));
  const runMeta = JSON.parse(fs.readFileSync(path.join(reportsDir, 'run_meta.json'), 'utf8'));

  assert.equal(runMeta.run.workers, null);
  assert.equal(issuesJson.summary.length, summaryRows.length);
  assert.equal(summaryRows.some((r) => r.Issue === 'Frames must have an accessible name'), false);
  assert.equal(summaryRows.some((r) => r.Issue === 'Broken Link'), true);
  assert.ok(summaryRows[0].CanonicalKey !== undefined);
  assert.ok(summaryRows[0].Actionability !== undefined);
  assert.ok(summaryRows[0].Ownership !== undefined);
  assert.ok(summaryRows[0].JourneyScope !== undefined);
});
