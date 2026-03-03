function safeUrlParts(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return {
      host: String(parsed.hostname || '').toLowerCase(),
      path: String(parsed.pathname || '').toLowerCase(),
      href: String(parsed.href || '').toLowerCase()
    };
  } catch {
    const value = String(rawUrl || '').toLowerCase();
    return { host: value, path: value, href: value };
  }
}

function isLikelyContactUrl(rawUrl) {
  const { path, href } = safeUrlParts(rawUrl);
  const target = `${path} ${href}`;
  return /(\/|^)(contact|contact-us|get-in-touch|enquiry|inquiry|book|consult|quote|support)(\/|$)/i.test(target);
}

function detectEmbeddedFormProvider(frameUrl, frameName = '') {
  const { host, href } = safeUrlParts(frameUrl);
  const target = `${host} ${href} ${String(frameName || '').toLowerCase()}`;

  if (/hubspot|hsforms|hbspt/i.test(target)) return 'HubSpot';
  if (/typeform/i.test(target)) return 'Typeform';
  if (/jotform/i.test(target)) return 'Jotform';
  if (/calendly/i.test(target)) return 'Calendly';
  if (/airtable/i.test(target)) return 'Airtable';
  if (/formstack/i.test(target)) return 'Formstack';
  if (/formsite/i.test(target)) return 'Formsite';
  if (/google\.com\/forms|docs\.google\.com\/forms/i.test(target)) return 'Google Forms';
  if (/gravityforms|gform/i.test(target)) return 'Gravity Forms';
  if (/wpforms/i.test(target)) return 'WPForms';
  if (/forminator/i.test(target)) return 'Forminator';
  if (/ninja-forms|nf-form/i.test(target)) return 'Ninja Forms';
  if (/wpcf7|contact-form-7/i.test(target)) return 'Contact Form 7';
  return '';
}

function isLikelyEmbeddedFormFrame(frameUrl, frameName = '') {
  return Boolean(detectEmbeddedFormProvider(frameUrl, frameName));
}

function buildEmbeddedFormSelector(frameUrl, frameName = '') {
  const trimmedName = String(frameName || '').trim();
  if (trimmedName) return `iframe[name="${trimmedName}"]`;

  const { host } = safeUrlParts(frameUrl);
  if (host) return `iframe[src*="${host}"]`;
  return 'iframe';
}

module.exports = {
  buildEmbeddedFormSelector,
  detectEmbeddedFormProvider,
  isLikelyContactUrl,
  isLikelyEmbeddedFormFrame
};
