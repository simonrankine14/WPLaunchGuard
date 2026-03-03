const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEmbeddedFormSelector,
  detectEmbeddedFormProvider,
  isLikelyContactUrl,
  isLikelyEmbeddedFormFrame
} = require('../scripts/lib/form-detection');

test('isLikelyContactUrl identifies contact-intent URLs', () => {
  assert.equal(isLikelyContactUrl('https://example.com/contact-us/'), true);
  assert.equal(isLikelyContactUrl('https://example.com/get-in-touch'), true);
  assert.equal(isLikelyContactUrl('https://example.com/blog/post-1'), false);
});

test('embedded form frame detection recognizes common providers', () => {
  assert.equal(isLikelyEmbeddedFormFrame('https://forms.hsforms.com/embed/v3/form/abc'), true);
  assert.equal(detectEmbeddedFormProvider('https://forms.hsforms.com/embed/v3/form/abc'), 'HubSpot');
  assert.equal(isLikelyEmbeddedFormFrame('https://calendly.com/mlt/book-call'), true);
  assert.equal(detectEmbeddedFormProvider('https://calendly.com/mlt/book-call'), 'Calendly');
  assert.equal(isLikelyEmbeddedFormFrame('https://www.youtube.com/embed/xyz'), false);
});

test('embedded selector prefers iframe name then host', () => {
  assert.equal(
    buildEmbeddedFormSelector('https://forms.hsforms.com/embed/v3/form/abc', 'hs-form-frame'),
    'iframe[name="hs-form-frame"]'
  );
  assert.equal(
    buildEmbeddedFormSelector('https://forms.hsforms.com/embed/v3/form/abc', ''),
    'iframe[src*="forms.hsforms.com"]'
  );
});
