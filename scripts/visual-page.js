#!/usr/bin/env node
const path = require('path');
const { spawnSync } = require('child_process');

function getFlag(prefix, args) {
  const entry = args.find((arg) => arg.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : '';
}

function requireUrl(value, label) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('');
    return url.toString();
  } catch (err) {
    console.error(`Invalid ${label} URL: ${value}`);
    process.exit(1);
  }
}

function slugFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.replace(/[^a-zA-Z0-9]+/g, '-');
    const pathPart = url.pathname
      .replace(/\/+$/, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const combined = [host, pathPart].filter(Boolean).join('-').replace(/^-+|-+$/g, '');
    const trimmed = combined.slice(0, 60) || 'single-page';
    const safe = /^[A-Za-z0-9]/.test(trimmed) ? trimmed : `page-${trimmed}`;
    return safe.length < 2 ? `${safe}-1` : safe;
  } catch (err) {
    return 'single-page';
  }
}

function runStep(label, args) {
  console.log(`\n--- ${label} ---`);
  const result = spawnSync('node', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Step "${label}" failed (exit ${result.status || 1}).`);
    process.exit(result.status || 1);
  }
}

const args = process.argv.slice(2);

const baseline = requireUrl(getFlag('--baseline=', args), 'baseline');
const target = requireUrl(getFlag('--target=', args), 'target');

const label = getFlag('--label=', args) || slugFromUrl(target);

const passthroughPrefixes = [
  '--projects=',
  '--diff-threshold=',
  '--auth-user=',
  '--auth-pass=',
  '--base-auth-user=',
  '--base-auth-pass=',
  '--target-auth-user=',
  '--target-auth-pass=',
  '--mask=',
  '--hide=',
  '--wait-for=',
  '--scroll-wait-ms=',
  '--headless=',
  '--no-cookie-accept'
];

const passthroughFlags = args.filter((arg) => ['--no-default-masks', '--no-cookie-accept'].includes(arg));

const passthrough = [
  ...args.filter((arg) => passthroughPrefixes.some((p) => arg.startsWith(p))),
  ...passthroughFlags
];

const runnerPath = path.join(__dirname, 'visual-runner.js');

const baseArgs = [
  runnerPath,
  label,
  '--mode=baseline',
  `--single-baseline=${baseline}`,
  `--single-target=${target}`,
  `--single=${target}`,
  ...passthrough
];

const compareArgs = [
  runnerPath,
  label,
  '--mode=compare',
  `--single-baseline=${baseline}`,
  `--single-target=${target}`,
  `--single=${target}`,
  ...passthrough
];

const summaryScript = path.join(__dirname, '..', 'reporting', 'generate-visual-summary.js');
const summaryArgs = [summaryScript, label];

console.log('Single-page visual regression');
console.log(`Baseline: ${baseline}`);
console.log(`Target  : ${target}`);
console.log(`Label   : ${label}`);

runStep('capture baseline', baseArgs);
runStep('compare', compareArgs);

const summaryResult = spawnSync('node', summaryArgs, { stdio: 'inherit' });
if (summaryResult.status !== 0) {
  console.warn('Summary generation skipped or failed; see logs above.');
}

console.log('\nDone. Check reports/' + label + '/visual for baseline/current/diff PNGs and visual_summary.md.');
