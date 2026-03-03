const fs = require('fs');
const path = require('path');
const { resolveClientReportsDir, resolveRunRoot, validateClientId } = require('../scripts/lib/safe-paths');

function parseCSV(content) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(current);
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] ?? '';
    });
    return obj;
  });
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

function avg(nums) {
  if (!nums.length) return 0;
  return nums.reduce((sum, val) => sum + val, 0) / nums.length;
}

function writeMarkdown(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8');
}

function buildSummary(rows) {
  const compareRows = rows.filter((row) => row.status && row.status !== 'BASELINE');
  const total = compareRows.length;
  const failed = compareRows.filter((row) => row.status === 'FAIL');
  const blanks = compareRows.filter((row) => row.status === 'BLANK');
  const passed = compareRows.filter((row) => row.status === 'PASS');

  const diffPercents = compareRows
    .map((row) => Number(row.diffPercent || 0))
    .filter((val) => Number.isFinite(val));
  const confidenceScores = compareRows
    .map((row) => Number(row.confidenceScore || 0))
    .filter((val) => Number.isFinite(val));

  const byProject = groupBy(compareRows, (row) => row.project || 'unknown');
  const projectLines = Object.entries(byProject).map(([project, items]) => {
    const projectFails = items.filter((row) => row.status === 'FAIL').length;
    return `- ${project}: ${projectFails} fails out of ${items.length}`;
  });

  const worst = [...compareRows]
    .sort((a, b) => Number(b.diffPercent || 0) - Number(a.diffPercent || 0))
    .slice(0, 10)
    .map((row) => `- ${row.url} (${row.project}) — ${row.diffPercent}%`);

  return {
    total,
    failed: failed.length + blanks.length,
    blanks: blanks.length,
    passed: passed.length,
    avgDiff: avg(diffPercents).toFixed(3),
    avgConfidence: avg(confidenceScores).toFixed(1),
    projectLines,
    worst
  };
}

const clientArg = process.argv[2];
if (!clientArg) {
  console.error('Usage: node reporting/generate-visual-summary.js <client>');
  process.exit(1);
}

let client = '';
try {
  client = validateClientId(clientArg);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const packageRoot = path.join(__dirname, '..');
const runRoot = resolveRunRoot(process.env, packageRoot);
const reportsDir = resolveClientReportsDir(runRoot, client, 'visual');
const csvPath = path.join(reportsDir, 'visual_results.csv');
const outputPath = path.join(reportsDir, 'visual_summary.md');

if (!fs.existsSync(csvPath)) {
  console.error(`Missing visual_results.csv at ${csvPath}`);
  process.exit(1);
}

const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
const summary = buildSummary(rows);

const markdown = `# Visual Regression Summary\n\n` +
  `- Total comparisons: ${summary.total}\n` +
  `- Passed: ${summary.passed}\n` +
  `- Failed (incl. blanks): ${summary.failed}\n` +
  `- Blanks detected: ${summary.blanks}\n` +
  `- Avg diff %: ${summary.avgDiff}\n` +
  `- Avg confidence: ${summary.avgConfidence}\n\n` +
  `## Failures by project\n` +
  (summary.projectLines.length ? summary.projectLines.join('\n') : '- none') +
  `\n\n## Top 10 diff outliers\n` +
  (summary.worst.length ? summary.worst.join('\n') : '- none') +
  `\n`;

writeMarkdown(outputPath, markdown);
console.log(`Visual summary saved to ${outputPath}`);
