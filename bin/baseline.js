#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveClientDataFile, validateClientId } = require('../scripts/lib/safe-paths');

const packageRoot = path.resolve(__dirname, '..');
const runRoot = process.cwd();

function binName() {
  return 'baseline';
}

function exitWithHelp(code = 1) {
  const name = binName();
  console.error(
    [
      `Usage:`,
      `  ${name} install-browsers`,
      `  ${name} init <clientname> [--url=https://example.com/]`,
      `  ${name} run <clientname> [--quick|--full|--projects=..|--sitemap=..|--sitemap-limit=..|--single=..|--auth-user=.. --auth-pass=..]`,
      `  ${name} html <clientname>`,
      `  ${name} pdf <clientname>`,
      `  ${name} report <clientname>`,
      `  ${name} share <clientname>`,
      ``,
      `Environment: QA_PROFILE=client-safe|engineering-deep (default: client-safe)`,
      `Environment: REPORT_AUDIENCE_DEFAULT=client|developer (default: client)`,
      `Environment: QA_ALLOW_GLOBAL_URL_FALLBACK=true (optional legacy fallback to data/urls.json)`,
      `Tip: run from a folder where you want \`reports/\` to be created.`
    ].join('\n')
  );
  process.exit(code);
}

function spawnNode(scriptPath, scriptArgs, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, BASELINE_ROOT: runRoot };
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    stdio: 'inherit',
    cwd: runRoot,
    env
  });
  process.exit(result.status ?? 1);
}

function spawnNpx(args) {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npxCmd, args, {
    stdio: 'inherit',
    cwd: packageRoot,
    env: { ...process.env }
  });
  process.exit(result.status ?? 1);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeClientFile(clientName, url) {
  const safeClientName = validateClientId(clientName);
  const outPath = resolveClientDataFile(runRoot, safeClientName);
  ensureDir(path.dirname(outPath));
  if (fs.existsSync(outPath)) {
    console.error(`Client file already exists: ${outPath}`);
    process.exit(1);
  }
  const payload = {
    urls: [url || 'https://example.com/']
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Created: ${outPath}`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) exitWithHelp(0);

const [command, ...rest] = argv;

if (command === 'install-browsers') {
  spawnNpx(['playwright', 'install']);
}

if (command === 'init') {
  let clientName = rest[0];
  if (!clientName) exitWithHelp(1);
  try {
    clientName = validateClientId(clientName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const urlFlag = rest.find((a) => a.startsWith('--url='));
  const url = urlFlag ? urlFlag.slice('--url='.length) : '';
  writeClientFile(clientName, url);
  process.exit(0);
}

if (command === 'run') {
  let clientName = rest[0];
  if (!clientName) exitWithHelp(1);
  try {
    clientName = validateClientId(clientName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  rest[0] = clientName;
  const runner = path.join(packageRoot, 'scripts', 'qa-runner.js');
  spawnNode(runner, rest, { CLIENT_NAME: clientName });
}

if (command === 'html') {
  let clientName = rest[0];
  if (!clientName) exitWithHelp(1);
  try {
    clientName = validateClientId(clientName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const script = path.join(packageRoot, 'reporting', 'generate-html-report.js');
  spawnNode(script, [clientName], {});
}

if (command === 'report') {
  let clientName = rest[0];
  if (!clientName) exitWithHelp(1);
  try {
    clientName = validateClientId(clientName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const script = path.join(packageRoot, 'reporting', 'generate-dashboard.js');
  spawnNode(script, [clientName], {});
}

if (command === 'pdf') {
  let clientName = rest[0];
  if (!clientName) exitWithHelp(1);
  try {
    clientName = validateClientId(clientName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const script = path.join(packageRoot, 'reporting', 'generate-pdf-report.js');
  spawnNode(script, [clientName], {});
}

if (command === 'share') {
  let clientName = rest[0];
  if (!clientName) exitWithHelp(1);
  try {
    clientName = validateClientId(clientName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const script = path.join(packageRoot, 'scripts', 'zip-report.js');
  spawnNode(script, [clientName], {});
}

// Back-compat: allow `baseline <clientname> [flags...]`.
if (!command.startsWith('-')) {
  let safeClientName = command;
  try {
    safeClientName = validateClientId(command);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const argsWithSafeClient = [safeClientName, ...argv.slice(1)];
  const runner = path.join(packageRoot, 'scripts', 'qa-runner.js');
  spawnNode(runner, argsWithSafeClient, { CLIENT_NAME: safeClientName });
}

exitWithHelp(1);
