const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/compare-images.js <baseline.png> <current.png> [diff.png]');
  process.exit(1);
}

const baselinePath = path.resolve(args[0]);
const currentPath = path.resolve(args[1]);
const diffPath = args[2] ? path.resolve(args[2]) : path.join(process.cwd(), 'reports', 'diff.png');

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function writePng(filePath, png) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

const baseline = readPng(baselinePath);
const current = readPng(currentPath);

const width = Math.max(baseline.width, current.width);
const height = Math.max(baseline.height, current.height);

const baselinePadded = new PNG({ width, height, fill: true });
const currentPadded = new PNG({ width, height, fill: true });

PNG.bitblt(baseline, baselinePadded, 0, 0, baseline.width, baseline.height, 0, 0);
PNG.bitblt(current, currentPadded, 0, 0, current.width, current.height, 0, 0);

const diff = new PNG({ width, height });
const diffPixels = pixelmatch(
  baselinePadded.data,
  currentPadded.data,
  diff.data,
  width,
  height,
  { threshold: 0.1, includeAA: true }
);

writePng(diffPath, diff);
const totalPixels = width * height;
const diffPercent = totalPixels ? (diffPixels / totalPixels) * 100 : 0;

console.log(`Diff saved to ${diffPath}`);
console.log(`Diff percent: ${diffPercent.toFixed(3)}%`);
