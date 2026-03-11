const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveClientReportsDir, resolveRunRoot, validateClientId } = require('./lib/safe-paths');

const args = process.argv.slice(2);
const clientArg = args.find((arg) => !arg.startsWith('--'));

if (!clientArg) {
  console.error('Usage: npm run qa:share -- <clientname>');
  process.exit(1);
}

let clientName = '';
try {
  clientName = validateClientId(clientArg);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const packageRoot = path.join(__dirname, '..');
const runRoot = resolveRunRoot(process.env, packageRoot);
const reportsDir = resolveClientReportsDir(runRoot, clientName);
const htmlPath = path.join(reportsDir, 'qa_html', 'index.html');

if (!fs.existsSync(reportsDir)) {
  console.error(`Missing reports directory at ${reportsDir}. Run QA first.`);
  process.exit(1);
}

if (!fs.existsSync(htmlPath)) {
  const htmlReportScript = path.join(packageRoot, 'reporting', 'generate-html-report.js');
  const gen = spawnSync('node', [htmlReportScript, clientName], {
    cwd: runRoot,
    stdio: 'inherit',
    env: { ...process.env, NO_AUTO_OPEN: 'true', BASELINE_ROOT: runRoot }
  });
  if (gen.status !== 0 || !fs.existsSync(htmlPath)) {
    console.error('Failed to generate HTML report.');
    process.exit(1);
  }
}

const entries = [
  'qa_html',
  'screenshots',
  'lighthouse',
  'results.csv',
  'url_summary.csv',
  'issues.json',
  'site_summary.csv',
  'run_meta.json',
  'QA_Report.xlsx',
  'QA_Report.pdf',
  'blocked_samples.json'
].filter((p) => fs.existsSync(path.join(reportsDir, p)));

if (entries.length === 0) {
  console.error('No report assets found to share.');
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const zipName = `share-${clientName}-${timestamp}.zip`;
const zipPath = path.join(reportsDir, zipName);
const latestName = `share-${clientName}-latest.zip`;
const latestPath = path.join(reportsDir, latestName);

const zip = spawnSync('zip', ['-r', zipName, ...entries], {
  cwd: reportsDir,
  stdio: 'inherit'
});

if (zip.error) {
  console.error('zip command not available. Install zip or create a manual archive from the reports folder.');
  process.exit(1);
}

if (zip.status !== 0) {
  console.error('Failed to create zip.');
  process.exit(1);
}

console.log(`Shareable report created: ${zipPath}`);

try {
  fs.copyFileSync(zipPath, latestPath);
  console.log(`Latest shareable report: ${latestPath}`);
} catch {
  // ignore copy errors
}
