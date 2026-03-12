const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveClientReportsDir, resolveRunRoot, validateClientId } = require('../scripts/lib/safe-paths');
const { safeHtml } = require('../scripts/lib/html-utils');
const { parseCSV } = require('../scripts/lib/csv-utils');

function readLogoBase64(customPath) {
  const candidates = customPath
    ? [customPath]
    : [
        path.join(__dirname, 'assets', 'logo.png'),
        path.join(__dirname, 'assets', 'logo.jpg'),
        path.join(__dirname, 'assets', 'logo.jpeg'),
        path.join(__dirname, 'assets', 'logo.svg')
      ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      const ext = path.extname(candidate).replace('.', '') || 'png';
      const data = fs.readFileSync(candidate).toString('base64');
      return `data:image/${ext};base64,${data}`;
    }
  }
  return '';
}

function relLink(fromDir, runRoot, maybeRelativePath) {
  if (!maybeRelativePath) return '';
  const absolute = path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(runRoot, maybeRelativePath);
  if (!fs.existsSync(absolute)) return '';
  return path.relative(fromDir, absolute).split(path.sep).join('/');
}

function buildSummary(rows) {
  const total = rows.length;
  const passed = rows.filter((r) => r.status === 'PASS').length;
  const blanks = rows.filter((r) => r.status === 'BLANK').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length + blanks;
  const diffVals = rows
    .map((r) => Number(r.diffPercent || 0))
    .filter((v) => Number.isFinite(v));
  const avgDiff = diffVals.length ? diffVals.reduce((a, b) => a + b, 0) / diffVals.length : 0;
  const byProject = rows.reduce((acc, row) => {
    acc[row.project] = acc[row.project] || { pass: 0, fail: 0, total: 0 };
    acc[row.project].total += 1;
    if (row.status === 'PASS') acc[row.project].pass += 1;
    if (row.status === 'FAIL') acc[row.project].fail += 1;
    return acc;
  }, {});
  const worst = [...rows]
    .filter((r) => Number.isFinite(Number(r.diffPercent || 0)))
    .sort((a, b) => Number(b.diffPercent) - Number(a.diffPercent))
    .slice(0, 8);
  return { total, passed, failed, blanks, avgDiff, byProject, worst };
}

function renderHTML({ client, summary, rows, logoDataUri }) {
  const json = JSON.stringify(rows).replace(/<\/script/gi, '<\\/script');
  const projects = Object.keys(summary.byProject);
  const today = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Visual Regression · ${safeHtml(client)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: #f6f7fb;
      --panel: #eef2fb;
      --card: #ffffff;
      --text: #111827;
      --muted: #4b5563;
      --pass: #16a34a;
      --fail: #dc2626;
      --warn: #f59e0b;
      --accent: #2563eb;
      --border: #e5e7eb;
      --shadow: 0 10px 35px rgba(15, 23, 42, 0.12);
      --radius: 14px;
      --font: 'Barlow', 'Helvetica Neue', 'Segoe UI', sans-serif;
      --mono: 'SFMono-Regular','Consolas','Liberation Mono', monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 18% 18%, rgba(37,99,235,0.12), transparent 22%), var(--bg);
      color: var(--text);
      font-family: var(--font);
      padding: 32px;
      line-height: 1.6;
    }
    header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    header img.logo { height: 44px; }
    h1 { margin: 0; font-size: 26px; letter-spacing: 0.2px; }
    .muted { color: var(--muted); font-size: 14px; }
    .intro {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      margin-bottom: 18px;
      box-shadow: var(--shadow);
    }
    .legend { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .tile {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      box-shadow: var(--shadow);
    }
    .tile h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .tile .value { font-size: 28px; font-weight: 700; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 12px;
      border: 1px solid var(--border);
      background: #f8fafc;
      color: var(--muted);
    }
    .pill.pass { color: var(--pass); background: #ecfdf3; border-color: #bbf7d0; }
    .pill.fail { color: var(--fail); background: #fef2f2; border-color: #fecaca; }
    .pill.warn { color: var(--warn); background: #fffbeb; border-color: #fde68a; }
    .filters {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin: 12px 0 18px;
    }
    .filters select, .filters input {
      background: #fff;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 9px 12px;
      min-width: 160px;
      font-size: 14px;
      box-shadow: var(--shadow);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
    }
    .card header {
      padding: 14px 16px 8px;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .url { font-weight: 600; font-size: 14px; word-break: break-all; }
    .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); }
    .imgs figure { margin: 0; background: #f3f4f6; position: relative; }
    .imgs img { width: 100%; display: block; }
    .imgs figcaption {
      position: absolute;
      left: 8px; bottom: 8px;
      background: rgba(255,255,255,0.88);
      padding: 4px 8px;
      border-radius: 8px;
      font-size: 11px;
      color: #111827;
      border: 1px solid #e5e7eb;
    }
    .empty { padding: 40px 0; text-align: center; color: var(--muted); }
    .project-badge { padding: 4px 8px; border-radius: 8px; background: #eef2fb; color: #1f2937; font-size: 12px; border: 1px solid var(--border); }
    .footer { margin-top: 24px; color: var(--muted); font-size: 12px; text-align: right; }
    @media (max-width: 960px) { body { padding: 18px; } .imgs { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="Logo" />` : ''}
    <div>
      <h1>Visual Regression · ${safeHtml(client)}</h1>
      <div class="muted">Generated ${safeHtml(today)}</div>
    </div>
  </header>

  <div class="intro">
    <strong>How to read this:</strong> Each card shows the baseline (old), current (new), and the pixel diff. <span class="pill pass">PASS</span> means the change stayed below your threshold; <span class="pill fail">FAIL</span> means it exceeded it; <span class="pill warn">blank</span> means the page didn’t render even after retry. Diff % is the share of pixels that changed; confidence reflects masking (dynamic elements). Use the filters below to zero in on pages or devices.
    <div class="legend">Tip: Click the images to open full size in your browser tabs.</div>
  </div>

  <div class="summary-grid">
    <div class="tile"><h3>Comparisons</h3><div class="value">${summary.total}</div></div>
    <div class="tile"><h3>Pass</h3><div class="value" style="color: var(--pass)">${summary.passed}</div></div>
    <div class="tile"><h3>Fail</h3><div class="value" style="color: var(--fail)">${summary.failed}</div></div>
    <div class="tile"><h3>Blanks</h3><div class="value" style="color: var(--warn)">${summary.blanks}</div></div>
    <div class="tile"><h3>Avg Diff %</h3><div class="value" style="color: var(--accent)">${summary.avgDiff.toFixed(3)}</div></div>
  </div>

  <div class="filters">
    <select id="statusFilter">
      <option value="all">Status: All</option>
      <option value="FAIL">Status: Fail only</option>
      <option value="PASS">Status: Pass only</option>
      <option value="BLANK">Status: Blank only</option>
    </select>
    <select id="projectFilter">
      <option value="all">Project: All</option>
      ${projects.map((p) => `<option value="${safeHtml(p)}">${safeHtml(p)}</option>`).join('')}
    </select>
    <input id="searchBox" type="search" placeholder="Filter by URL..." />
    <select id="sortFilter">
      <option value="diff-desc">Sort: Diff % ↓</option>
      <option value="diff-asc">Sort: Diff % ↑</option>
      <option value="url-asc">Sort: URL A→Z</option>
    </select>
  </div>

  <div id="cards" class="grid"></div>
  <div id="empty" class="empty" style="display:none;">No matches for current filters.</div>

  <div class="footer">Images are linked relatively; open in a new tab for full resolution.</div>

  <script>
    const data = JSON.parse(${JSON.stringify(json)});

    const statusEl = document.getElementById('statusFilter');
    const projectEl = document.getElementById('projectFilter');
    const searchEl = document.getElementById('searchBox');
    const sortEl = document.getElementById('sortFilter');
    const cardsEl = document.getElementById('cards');
    const emptyEl = document.getElementById('empty');

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function safeAssetUrl(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      if (/^(javascript|data|vbscript):/i.test(raw)) return '';
      return raw;
    }

    function badge(text, cls) {
      return '<span class="pill ' + escapeHtml(cls) + '">' + escapeHtml(text) + '</span>';
    }

    function render() {
      const status = statusEl.value;
      const project = projectEl.value;
      const term = searchEl.value.trim().toLowerCase();
      const sort = sortEl.value;

      let rows = data.slice();
      rows = rows.filter((r) => r.status && r.status !== 'BASELINE');
      if (status !== 'all') rows = rows.filter((r) => r.status === status);
      if (project !== 'all') rows = rows.filter((r) => r.project === project);
      if (term) rows = rows.filter((r) => String(r.url || '').toLowerCase().includes(term));

      rows.sort((a, b) => {
        const diffA = Number(a.diffPercent || 0);
        const diffB = Number(b.diffPercent || 0);
        if (sort === 'diff-desc') return diffB - diffA;
        if (sort === 'diff-asc') return diffA - diffB;
        return String(a.url || '').localeCompare(String(b.url || ''));
      });

      cardsEl.innerHTML = rows
        .map((r) => {
          const statusClass = r.status === 'FAIL' || r.status === 'BLANK' ? 'fail' : 'pass';
          const diff = Number(r.diffPercent || 0).toFixed(3);
          const notePill = r.note ? '<span class="pill warn">' + escapeHtml(r.note) + '</span>' : '';
          const img = (src, label) => {
            const safeSrc = safeAssetUrl(src);
            const escapedLabel = escapeHtml(label);
            if (!safeSrc) {
              return '<figure><figcaption>' + escapedLabel + ' missing</figcaption></figure>';
            }
            const escapedSrc = escapeHtml(safeSrc);
            return '<figure><a href="' + escapedSrc + '" target="_blank" rel="noreferrer"><img src="' + escapedSrc + '" loading="lazy" alt="' + escapedLabel + '"></a><figcaption>' + escapedLabel + '</figcaption></figure>';
          };
          return '<article class="card">' +
            '<header>' +
              '<div class="meta">' +
                badge(r.status, statusClass) +
                '<span class="pill warn">Diff ' + diff + '%</span>' +
                (r.confidenceScore ? '<span class="pill">Conf ' + Number(r.confidenceScore).toFixed(1) + '</span>' : '') +
                '<span class="project-badge">' + escapeHtml(r.project) + '</span>' +
                notePill +
              '</div>' +
              '<div class="url">' + escapeHtml(r.url) + '</div>' +
            '</header>' +
            '<div class="imgs">' +
              img(r.baselinePath, 'Baseline') +
              img(r.currentPath, 'Current') +
              img(r.diffPath, 'Diff') +
            '</div>' +
          '</article>';
        })
        .join('');

      emptyEl.style.display = rows.length ? 'none' : 'block';
    }

    statusEl.addEventListener('change', render);
    projectEl.addEventListener('change', render);
    sortEl.addEventListener('change', render);
    searchEl.addEventListener('input', render);
    render();
  </script>
</body>
</html>`;
}

function main() {
  const args = process.argv.slice(2);
  const clientArg = args.find((a) => !a.startsWith('--'));
  if (!clientArg) {
    console.error('Usage: node reporting/generate-visual-dashboard.js <client> [--logo=/abs/logo.png]');
    process.exit(1);
  }

  let client = '';
  try {
    client = validateClientId(clientArg);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const logoFlag = args.find((a) => a.startsWith('--logo='));
  const logoPath = logoFlag ? logoFlag.replace('--logo=', '') : '';
  const noOpen = args.includes('--no-open');

  const packageRoot = path.join(__dirname, '..');
  const runRoot = resolveRunRoot(process.env, packageRoot);
  const reportsDir = resolveClientReportsDir(runRoot, client, 'visual');
  const csvPath = path.join(reportsDir, 'visual_results.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`Missing visual_results.csv at ${csvPath}`);
    process.exit(1);
  }

  const rowsRaw = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const rows = rowsRaw
    .filter((r) => r.status && r.status !== 'BASELINE')
    .map((r) => ({
      url: r.url,
      project: r.project,
      status: r.status,
      diffPercent: r.diffPercent || '',
      confidenceScore: r.confidenceScore || '',
      baselinePath: relLink(reportsDir, runRoot, r.baselinePath),
      currentPath: relLink(reportsDir, runRoot, r.currentPath),
      diffPath: relLink(reportsDir, runRoot, r.diffPath),
      note: r.note || ''
    }));

  const summary = buildSummary(rows);
  const logoDataUri = readLogoBase64(logoPath);

  const html = renderHTML({ client, summary, rows, logoDataUri });
  const outputPath = path.join(reportsDir, 'visual_dashboard.html');
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Visual dashboard saved to ${outputPath}`);

  if (!noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    const result = spawnSync(opener, [outputPath], { stdio: 'ignore', shell: process.platform === 'win32' });
    if (result.error) {
      console.warn('Could not auto-open dashboard. You can open it manually in a browser.');
    }
  }
}

main();
