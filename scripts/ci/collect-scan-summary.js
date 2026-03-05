#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeKey(value, fallback = 'unknown') {
  const str = String(value || '').trim().toLowerCase();
  return str || fallback;
}

function countBy(items, keyResolver) {
  const out = {};
  for (const item of items) {
    const key = keyResolver(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function topObjectEntries(obj, limit) {
  return Object.entries(obj || {})
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, limit)
    .reduce((acc, [k, v]) => {
      acc[k] = Number(v || 0);
      return acc;
    }, {});
}

function fileExists(relativePath, reportDir) {
  const fullPath = path.join(reportDir, relativePath);
  return fs.existsSync(fullPath);
}

function safeListFiles(dirPath, matcher) {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).filter((name) => matcher(name));
  } catch {
    return [];
  }
}

function collectEvidenceCounts(reportDir) {
  const screenshotsDir = path.join(reportDir, 'screenshots');
  const lighthouseDir = path.join(reportDir, 'lighthouse');

  const screenshots = safeListFiles(screenshotsDir, (name) => /\.png$/i.test(name));
  const lighthouseHtml = safeListFiles(lighthouseDir, (name) => /\.lighthouse\.html$/i.test(name));
  const lighthouseJson = safeListFiles(lighthouseDir, (name) => /\.lighthouse\.json$/i.test(name));

  return {
    screenshots_count: screenshots.length,
    lighthouse_html_count: lighthouseHtml.length,
    lighthouse_json_count: lighthouseJson.length
  };
}

function buildArtifactPresence(clientName, reportDir) {
  const latestZip = `share-${clientName}-latest.zip`;
  return {
    qa_html_index: fileExists(path.join('qa_html', 'index.html'), reportDir),
    issues_json: fileExists('issues.json', reportDir),
    run_meta_json: fileExists('run_meta.json', reportDir),
    site_summary_csv: fileExists('site_summary.csv', reportDir),
    url_summary_csv: fileExists('url_summary.csv', reportDir),
    qa_report_xlsx: fileExists('QA_Report.xlsx', reportDir),
    share_zip_latest: fileExists(latestZip, reportDir)
  };
}

function collectSummary(reportDir, clientName) {
  const runMetaPath = path.join(reportDir, 'run_meta.json');
  const issuesPath = path.join(reportDir, 'issues.json');

  const runMeta = safeReadJson(runMetaPath) || {};
  const issuesJson = safeReadJson(issuesPath) || {};
  const issues = Array.isArray(issuesJson.issues) ? issuesJson.issues : [];

  const severityCounts = countBy(issues, (issue) => normalizeKey(issue.Severity));
  const categoryCounts = countBy(issues, (issue) => normalizeKey(issue.Category));

  const issueSamples = issues.slice(0, 20).map((issue) => ({
    category: String(issue.Category || ''),
    severity: String(issue.Severity || ''),
    title: String(issue.Title || ''),
    url: String(issue.URL || '')
  }));
  const evidenceCounts = collectEvidenceCounts(reportDir);

  return {
    generated_at: new Date().toISOString(),
    client: clientName,
    report_generated_at: String(issuesJson.generatedAt || runMeta.generatedAt || ''),
    run_state: String(runMeta.state || ''),
    run: runMeta.run || {},
    run_counts: runMeta.counts || {},
    issues_total: Number(issuesJson?.totals?.issues || issues.length || 0),
    issue_summary_total: Number(issuesJson?.totals?.summary || 0),
    issue_severity_counts: severityCounts,
    issue_category_top: topObjectEntries(categoryCounts, 8),
    issues_sample: issueSamples,
    evidence: evidenceCounts,
    report_artifacts_present: buildArtifactPresence(clientName, reportDir)
  };
}

function main() {
  const reportDir = process.argv[2];
  const clientName = process.argv[3] || 'client';
  if (!reportDir) {
    process.stderr.write('Usage: node scripts/ci/collect-scan-summary.js <reportDir> <clientName>\n');
    process.exit(1);
  }

  const summary = collectSummary(reportDir, clientName);
  process.stdout.write(JSON.stringify(summary));
}

main();
