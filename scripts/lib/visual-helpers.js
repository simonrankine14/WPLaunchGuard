const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const DEFAULT_MASK_SELECTORS = [
  '.cookie-banner',
  '[data-cookie-consent]',
  '[id*="cookie-banner"]',
  '[class*="cookie-consent"]',
  '[class*="cookie-notice"]',
  '[class*="consent"]:not(body):not(html)',
  '[class*="chat-widget"]',
  '[class*="intercom"]',
  '[class*="drift"]',
  'iframe[src*="youtube"]',
  'iframe[src*="vimeo"]',
  '[class*="survey"]'
];

const COOKIE_SELECTORS = [
  'button[aria-label*="accept" i]',
  'button[aria-label*="agree" i]',
  'button:has-text("accept")',
  'button:has-text("agree")',
  'button:has-text("ok")',
  'text=Accept',
  'text=I Agree',
  'text=Got it'
];

function sanitizeSelectors(selectors, warnings) {
  const output = [];
  const warn = warnings || [];
  const broadRegex = /(^|\s|,)(html|body|head)(\b|\s|#|\.|\[|:|,)/i;
  for (const sel of selectors || []) {
    if (!sel || typeof sel !== 'string') continue;
    if (broadRegex.test(sel)) {
      warn.push(`Skipped mask selector because it targets html/body/head: "${sel}"`);
      continue;
    }
    output.push(sel);
  }
  return { sanitized: Array.from(new Set(output)), warnings: warn };
}

function isBlankImage(filePath, threshold = 0.95) {
  if (!fs.existsSync(filePath)) return { blank: true, ratio: 1 };
  const png = PNG.sync.read(fs.readFileSync(filePath));
  let blankPixels = 0;
  const total = png.width * png.height;
  const data = png.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const isTransparent = a === 0;
    const isWhite = r > 250 && g > 250 && b > 250;
    if (isTransparent || isWhite) blankPixels += 1;
  }
  const ratio = total ? blankPixels / total : 1;
  return { blank: ratio >= threshold, ratio };
}

function resolveBrowserExecutable(browserType) {
  try {
    const p = browserType.executablePath();
    return fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

module.exports = {
  DEFAULT_MASK_SELECTORS,
  COOKIE_SELECTORS,
  sanitizeSelectors,
  isBlankImage,
  resolveBrowserExecutable
};
