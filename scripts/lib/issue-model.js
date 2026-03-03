const URL_PATTERN = /https?:\/\/[^\s)"]+/g;

const KNOWN_VENDOR_PATTERNS = [
  { label: 'cookie-consent', pattern: /cookieyes|cky-|cookie consent|consent/i },
  { label: 'maps-embed', pattern: /googleapis\.com\/maps|maps\.google|mapbox/i },
  { label: 'video-embed', pattern: /youtube|vimeo|wistia/i },
  { label: 'chat-widget', pattern: /intercom|tawk|drift|zendesk|freshchat|livechat/i },
  { label: 'analytics-tag', pattern: /googletagmanager|google-analytics|gtag|hotjar|clarity/i },
  { label: 'social-widget', pattern: /linkedin|facebook|twitter|x\.com|instagram/i },
  { label: 'recaptcha', pattern: /recaptcha|grecaptcha/i },
  { label: 'yoshki-widget', pattern: /yoshki/i }
];

function safeParseUrl(input) {
  try {
    return new URL(String(input || '').trim());
  } catch {
    return null;
  }
}

function normalizeElement(element) {
  if (!element) return '';
  let output = String(element).replace(/\s+/g, ' ').trim();
  output = output.replace(URL_PATTERN, (match) => {
    const parsed = safeParseUrl(match);
    if (!parsed) return match;
    return `${parsed.origin}${parsed.pathname}`;
  });
  return output;
}

function deriveCategoryGroup(issue) {
  const source = String(issue._source || '').toLowerCase();
  const category = String(issue.Category || '').toLowerCase();

  if (source === 'console' || source === 'page' || source === 'pageerror') return 'console';
  if (category === 'accessibility') return 'accessibility';
  if (category === 'seo') return 'seo';
  if (category === 'performance') return 'performance';
  if (source === 'forms' || category === 'forms') return 'forms';
  return 'structure';
}

function deriveJourneyScope(issue) {
  const raw = String(issue.journeyScope || '').toLowerCase();
  if (raw === 'global' || raw === 'template' || raw === 'url') return raw;
  if (issue.templateKey) return 'template';
  if (issue.URL) return 'url';
  return 'global';
}

function detectVendorLabel(text) {
  const haystack = String(text || '').toLowerCase();
  const match = KNOWN_VENDOR_PATTERNS.find((item) => item.pattern.test(haystack));
  return match ? match.label : '';
}

function deriveOwnership(issue) {
  const provided = String(issue.ownership || '').toLowerCase();
  if (provided === 'first_party' || provided === 'third_party' || provided === 'unknown') {
    return provided;
  }

  const source = String(issue._source || '').toLowerCase();
  if (source === 'forms' || source === 'layout' || source === 'structure' || source === 'mobile' || source === 'seo') {
    return 'first_party';
  }

  const vendorLabel = detectVendorLabel([issue.Title, issue.Description, issue.Element, issue.resourceUrl].join(' '));
  if (vendorLabel) return 'third_party';

  if (source === 'page' || source === 'pageerror') return 'first_party';

  const resourceUrl = safeParseUrl(issue.resourceUrl);
  const pageUrl = safeParseUrl(issue.URL);
  if (resourceUrl && pageUrl) {
    return resourceUrl.origin === pageUrl.origin ? 'first_party' : 'third_party';
  }
  if (source === 'axe') return 'first_party';
  return 'unknown';
}

function normalizeRuntimeCause(input) {
  let text = normalizeElement(input).toLowerCase();
  text = text.replace(/["'`].*?["'`]/g, 'str');
  text = text.replace(/\b\d+\b/g, 'n');
  text = text.replace(/\$[a-z0-9_]+/g, '$var');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 180);
}

function normalizeCause(issue) {
  if (issue.normalizedCause) return String(issue.normalizedCause);

  const title = String(issue.Title || '').toLowerCase();
  const sourceElement = issue.Element || issue.resourceUrl || issue.Title || '';
  const vendorLabel = detectVendorLabel([issue.Title, issue.Description, issue.Element, issue.resourceUrl].join(' '));
  if (vendorLabel) return `vendor:${vendorLabel}`;

  if (title.includes('image missing loading="lazy"')) return 'image-lazy';
  if (title.includes('button hover state missing')) return 'hover-state';
  if (title.includes('internal link opens new tab')) return 'internal-link-target';
  if (title.includes('external link missing target="_blank"')) return 'external-link-target';
  if (title.includes('page runtime error')) return normalizeRuntimeCause(sourceElement);
  if (title.includes('form validation issue') || title.includes('form submission failed')) return 'form-path-failure';
  if (title.includes('form elements must have labels')) return 'form-label-missing';

  let text = normalizeElement(sourceElement).toLowerCase();
  text = text.replace(/#[a-z0-9_-]{4,}/g, '#id');
  text = text.replace(/\.[a-z0-9_-]*\d+[a-z0-9_-]*/g, '.class');
  text = text.replace(/\b\d+\b/g, 'n');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 180) || 'unspecified';
}

function deriveActionability(issue) {
  const provided = String(issue.actionability || '').toLowerCase();
  if (provided === 'blocker' || provided === 'actionable' || provided === 'warning' || provided === 'info') {
    return provided;
  }

  const title = String(issue.Title || '').toLowerCase();
  const severity = String(issue.Severity || '').toLowerCase();
  const ownership = deriveOwnership(issue);

  if (issue.isEnvironment || title.includes('page blocked')) return 'warning';
  if (title.includes('form submission failed') || title.includes('broken link')) return 'blocker';
  if (title.includes('form validation issue') || title.includes('page runtime error')) {
    if (ownership === 'first_party') return severity === 'critical' ? 'blocker' : 'actionable';
    return 'warning';
  }

  if (severity === 'critical' && ownership === 'first_party') return 'blocker';
  if (severity === 'critical' || severity === 'major') return 'actionable';
  if (severity === 'minor') return 'warning';
  return 'info';
}

function buildCanonicalKey(issue) {
  const categoryGroup = deriveCategoryGroup(issue);
  const title = String(issue.Title || '').toLowerCase().trim() || 'issue';
  const normalizedCause = normalizeCause(issue);
  const journeyScope = deriveJourneyScope(issue);
  return [categoryGroup, title, normalizedCause, journeyScope].join('|');
}

function normalizeIssueEntry(entry) {
  const base = {
    Category: entry.Category || '',
    Severity: entry.Severity || '',
    Title: entry.Title || '',
    Description: entry.Description || '',
    Element: entry.Element || '',
    WCAG: entry.WCAG || '',
    Recommendation: entry.Recommendation || '',
    URL: entry.URL || '',
    _source: entry._source || '',
    resourceUrl: entry.resourceUrl || '',
    httpStatus: entry.httpStatus || '',
    assetType: entry.assetType || '',
    isEnvironment: Boolean(entry.isEnvironment),
    screenshotPath: entry.screenshotPath || '',
    templateKey: entry.templateKey || ''
  };

  const normalizedCause = normalizeCause(base);
  const ownership = deriveOwnership(base);
  const journeyScope = deriveJourneyScope(base);
  const actionability = deriveActionability({ ...base, ownership });
  const categoryGroup = deriveCategoryGroup(base);
  const canonicalKey = entry.canonicalKey || buildCanonicalKey({ ...base, normalizedCause, journeyScope });

  return {
    ...base,
    ownership,
    actionability,
    journeyScope,
    categoryGroup,
    normalizedCause,
    canonicalKey
  };
}

function buildIssueSummary(issueRows, totalUrls) {
  const summary = new Map();
  issueRows.forEach((raw) => {
    const normalized = normalizeIssueEntry(raw);
    const key = normalized.canonicalKey;
    const existing = summary.get(key);
    if (existing) {
      if (normalized.URL) {
        existing.urls.add(normalized.URL);
        existing.Count = existing.urls.size;
      }
      return;
    }
    summary.set(key, {
      ...normalized,
      Count: normalized.URL ? 1 : 0,
      ExampleURL: normalized.URL || '',
      urls: new Set(normalized.URL ? [normalized.URL] : [])
    });
  });

  const universe = Number(totalUrls || 0);
  summary.forEach((item) => {
    item.Global = universe > 0 && item.Count / universe >= 0.7 ? 'yes' : 'no';
  });
  return summary;
}

module.exports = {
  buildCanonicalKey,
  buildIssueSummary,
  deriveActionability,
  deriveCategoryGroup,
  deriveJourneyScope,
  deriveOwnership,
  normalizeCause,
  normalizeElement,
  normalizeIssueEntry
};
