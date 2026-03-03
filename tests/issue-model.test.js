const test = require('node:test');
const assert = require('node:assert/strict');
const { buildIssueSummary, normalizeIssueEntry } = require('../scripts/lib/issue-model');

test('normalizeIssueEntry adds canonical/actionability/ownership/journeyScope', () => {
  const issue = normalizeIssueEntry({
    Category: 'functionality',
    Severity: 'critical',
    Title: 'Page Runtime Error',
    Element: 'TypeError: Cannot read properties of undefined',
    URL: 'https://example.com/contact/',
    _source: 'page'
  });

  assert.ok(issue.canonicalKey);
  assert.equal(issue.journeyScope, 'url');
  assert.equal(issue.ownership, 'first_party');
  assert.equal(issue.actionability, 'blocker');
});

test('normalizeIssueEntry downgrades third-party runtime actionability', () => {
  const issue = normalizeIssueEntry({
    Category: 'functionality',
    Severity: 'critical',
    Title: 'Page Runtime Error',
    Element: "undefined is not an object (evaluating '$canvas[0].getContext') cookieyes",
    URL: 'https://example.com/',
    _source: 'page'
  });

  assert.equal(issue.ownership, 'third_party');
  assert.equal(issue.actionability, 'warning');
});

test('buildIssueSummary dedupes selector variants under canonical key', () => {
  const rows = [
    normalizeIssueEntry({
      Category: 'ux',
      Severity: 'minor',
      Title: 'Button Hover State Missing',
      Element: 'button.cky-btn.cky-btn-customize',
      URL: 'https://example.com/a',
      _source: 'ux'
    }),
    normalizeIssueEntry({
      Category: 'ux',
      Severity: 'minor',
      Title: 'Button Hover State Missing',
      Element: 'button.cky-btn.cky-btn-accept',
      URL: 'https://example.com/b',
      _source: 'ux'
    })
  ];

  const summary = buildIssueSummary(rows, 2);
  assert.equal(summary.size, 1);
  const only = Array.from(summary.values())[0];
  assert.equal(only.Count, 2);
  assert.equal(only.Global, 'yes');
});
