const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSelectors, isBlankImage, DEFAULT_MASK_SELECTORS } = require('../scripts/lib/visual-helpers');

function writePng(filePath, pixels) {
  const png = new PNG({ width: 4, height: 4 });
  pixels.forEach((p, idx) => {
    const base = idx * 4;
    png.data[base] = p[0];
    png.data[base + 1] = p[1];
    png.data[base + 2] = p[2];
    png.data[base + 3] = p[3];
  });
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-helpers-'));

test('sanitizeSelectors removes html/body/head and keeps others', () => {
  const input = ['body.cookie', '.chat-widget', 'html', 'div.header'];
  const { sanitized, warnings } = sanitizeSelectors(input, []);
  assert(sanitized.includes('.chat-widget'));
  assert(sanitized.includes('div.header'));
  assert(!sanitized.includes('html'));
  assert(!sanitized.includes('body.cookie'));
  assert(warnings.length >= 1);
});

test('sanitizeSelectors keeps default masks but no html/body', () => {
  const { sanitized } = sanitizeSelectors(DEFAULT_MASK_SELECTORS, []);
  assert(!sanitized.some((s) => /^\\s*(html|body|head)/i.test(s)));
});

test('isBlankImage detects white image', () => {
  const file = path.join(tmp, 'blank.png');
  writePng(
    file,
    Array(16).fill([255, 255, 255, 255])
  );
  const res = isBlankImage(file);
  assert.equal(res.blank, true);
});

test('isBlankImage detects non-white image', () => {
  const file = path.join(tmp, 'nonblank.png');
  const pixels = Array(16).fill([255, 255, 255, 255]);
  pixels[0] = [10, 10, 10, 255];
  writePng(file, pixels);
  const res = isBlankImage(file);
  assert.equal(res.blank, false);
});
