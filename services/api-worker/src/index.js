function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function unauthorized() {
  return json({ error: 'unauthorized' }, 401);
}

function badRequest(message) {
  return json({ error: message }, 400);
}

function notFound() {
  return json({ error: 'not_found' }, 404);
}

function nowIso() {
  return new Date().toISOString();
}

function getDefaultPlanId(env) {
  return String(env.DEFAULT_PLAN || 'starter').trim() || 'starter';
}

function getStripeConfig(env) {
  return {
    secretKey: String(env.STRIPE_SECRET_KEY || '').trim(),
    webhookSecret: String(env.STRIPE_WEBHOOK_SECRET || '').trim(),
    priceIds: {
      starter: String(env.STRIPE_PRICE_ID_STARTER || '').trim(),
      growth: String(env.STRIPE_PRICE_ID_GROWTH || '').trim(),
      agency: String(env.STRIPE_PRICE_ID_AGENCY || '').trim()
    }
  };
}

function getStripePriceIdForPlan(env, planId) {
  const config = getStripeConfig(env);
  const key = String(planId || '').trim().toLowerCase();
  return String(config.priceIds[key] || '').trim();
}

function getPlanIdFromStripePriceId(env, stripePriceId) {
  const target = String(stripePriceId || '').trim();
  if (!target) return '';

  const config = getStripeConfig(env);
  const entries = Object.entries(config.priceIds);
  for (const [planId, priceId] of entries) {
    if (String(priceId || '').trim() === target) {
      return planId;
    }
  }

  return '';
}

function parseStripeSignatureHeader(headerValue) {
  const result = { timestamp: 0, v1: [] };
  const segments = String(headerValue || '')
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const [rawKey, rawValue] = segment.split('=');
    const key = String(rawKey || '').trim();
    const value = String(rawValue || '').trim();
    if (!key || !value) continue;
    if (key === 't') {
      result.timestamp = Number(value || 0);
    } else if (key === 'v1') {
      result.v1.push(value);
    }
  }

  return result;
}

function byteArrayToHex(bytes) {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (!a || !b || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function signStripePayload(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return byteArrayToHex(new Uint8Array(signature));
}

async function verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed.timestamp || parsed.v1.length === 0 || !webhookSecret) {
    return false;
  }

  const toleranceSeconds = 300;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return false;
  }

  const payloadToSign = `${parsed.timestamp}.${rawBody}`;
  const expected = await signStripePayload(webhookSecret, payloadToSign);
  return parsed.v1.some((candidate) => timingSafeEqual(expected, candidate));
}

function unixSecondsToIso(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function mapStripeSubscriptionStatus(status, eventType) {
  const normalized = String(status || '').trim().toLowerCase();
  if (eventType === 'customer.subscription.deleted') {
    return 'cancelled';
  }
  if (normalized === 'active') return 'active';
  if (normalized === 'trialing') return 'trial';
  if (normalized === 'past_due' || normalized === 'unpaid') return 'past_due';
  if (normalized === 'canceled') return 'cancelled';
  return 'inactive';
}

function normalizeNullableString(value) {
  if (value === null) return null;
  const normalized = String(value || '').trim();
  return normalized || null;
}

function hasOwnProperty(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function isMissingScanOptionColumnError(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return message.includes('no such column') && (
    message.includes('target_url') ||
    message.includes('options_json') ||
    message.includes('source_context_json')
  );
}

function getConfiguredAdminToken(env) {
  return String(env.API_ADMIN_TOKEN || '').trim();
}

function hasValidAdminAuth(request, env) {
  const configured = getConfiguredAdminToken(env);
  if (!configured) return false;
  const auth = String(request.headers.get('authorization') || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  const token = auth.slice(7).trim();
  return token === configured;
}

function extractSiteToken(request) {
  const headerToken = String(request.headers.get('x-launchguard-site-token') || '').trim();
  if (headerToken) return headerToken;

  const fallbackHeader = String(request.headers.get('x-site-token') || '').trim();
  if (fallbackHeader) return fallbackHeader;

  const auth = String(request.headers.get('authorization') || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return '';
}

function extractCallbackToken(request) {
  const headerToken = String(request.headers.get('x-scan-callback-token') || '').trim();
  if (headerToken) return headerToken;

  const auth = String(request.headers.get('authorization') || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return '';
}

function isTerminalScanStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

function slugifyClientId(value, fallback = 'site') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function deriveClientSlugFromSite(site) {
  const siteIdSuffix = String(site?.id || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 8);
  const fallbackBase = siteIdSuffix ? `site-${siteIdSuffix}` : 'site';

  try {
    const siteUrl = String(site?.site_url || '').trim();
    if (!siteUrl) return fallbackBase;
    const hostname = new URL(siteUrl).hostname.replace(/^www\./i, '');
    const hostSlug = slugifyClientId(hostname, fallbackBase);
    return siteIdSuffix ? `${hostSlug}-${siteIdSuffix}`.slice(0, 64) : hostSlug.slice(0, 64);
  } catch {
    return fallbackBase;
  }
}

function deriveClientLabel(site, tenantName = '') {
  const tenantLabel = String(tenantName || '').trim();
  if (tenantLabel) return tenantLabel;
  const siteUrl = String(site?.site_url || '').trim();
  if (!siteUrl) return 'Site';
  try {
    const parsed = new URL(siteUrl);
    return parsed.origin;
  } catch {
    return siteUrl;
  }
}

function mapProfileToQaProfile(scanProfile) {
  const value = String(scanProfile || '').toLowerCase();
  return value === 'engineering-deep' ? 'engineering-deep' : 'client-safe';
}

const DEFAULT_SCAN_OPTIONS = Object.freeze({
  evidence_enabled: true,
  lighthouse_enabled: true,
  quick_scan_enabled: false,
  responsive_enabled: false,
  viewport_preset: 'desktop'
});

function normalizeBooleanFlag(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeViewportPreset(value, fallback = 'desktop') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['desktop', 'mobile', 'both'].includes(normalized) ? normalized : fallback;
}

function normalizeScanOptions(rawOptions, fallbackOptions = DEFAULT_SCAN_OPTIONS) {
  const source = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? rawOptions : {};
  const fallback = fallbackOptions && typeof fallbackOptions === 'object' ? fallbackOptions : DEFAULT_SCAN_OPTIONS;

  const normalized = {
    evidence_enabled: normalizeBooleanFlag(source.evidence_enabled, normalizeBooleanFlag(fallback.evidence_enabled, true)),
    lighthouse_enabled: normalizeBooleanFlag(source.lighthouse_enabled, normalizeBooleanFlag(fallback.lighthouse_enabled, true)),
    quick_scan_enabled: normalizeBooleanFlag(source.quick_scan_enabled, normalizeBooleanFlag(fallback.quick_scan_enabled, false)),
    responsive_enabled: normalizeBooleanFlag(source.responsive_enabled, normalizeBooleanFlag(fallback.responsive_enabled, false)),
    viewport_preset: normalizeViewportPreset(source.viewport_preset, normalizeViewportPreset(fallback.viewport_preset, 'desktop'))
  };

  if (!normalized.responsive_enabled) {
    normalized.viewport_preset = 'desktop';
  }

  return normalized;
}

function normalizeTargetUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeSourceContext(rawSourceContext) {
  if (!rawSourceContext || typeof rawSourceContext !== 'object' || Array.isArray(rawSourceContext)) {
    return null;
  }

  const source = ['dashboard', 'metabox'].includes(String(rawSourceContext.source || '').trim().toLowerCase())
    ? String(rawSourceContext.source).trim().toLowerCase()
    : '';
  const postId = Number(rawSourceContext.post_id || 0);
  const postType = String(rawSourceContext.post_type || '').trim().toLowerCase();

  const normalized = {
    source,
    post_id: Number.isFinite(postId) && postId > 0 ? Math.floor(postId) : null,
    post_type: postType || null
  };

  if (!normalized.source && !normalized.post_id && !normalized.post_type) {
    return null;
  }

  return normalized;
}

function formatWorkflowBooleanInput(value) {
  return normalizeBooleanFlag(value, false) ? 'true' : 'false';
}

function getGitHubDispatchConfig(env) {
  const owner = String(env.GITHUB_OWNER || '').trim();
  const repo = String(env.GITHUB_REPO || '').trim();
  const workflow = String(env.GITHUB_WORKFLOW_FILE || 'launchguard-scan.yml').trim();
  const ref = String(env.GITHUB_REF || 'main').trim();
  const token = String(env.GITHUB_DISPATCH_TOKEN || '').trim();
  const publicApiBase = String(env.PUBLIC_API_BASE || '').trim();

  return { owner, repo, workflow, ref, token, publicApiBase };
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function safeParseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseSummaryObject(rawSummary) {
  const parsed = safeParseJson(rawSummary);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

function deriveIssueTotalsFromSummary(summary) {
  const candidates = [
    summary.issue_severity_counts,
    summary.severity_counts
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const rows = Object.entries(candidate)
      .map(([severity, count]) => ({
        severity: String(severity),
        count: Number(count || 0)
      }))
      .filter((row) => row.severity && Number.isFinite(row.count) && row.count > 0);
    if (rows.length > 0) return rows;
  }

  return [];
}

function enrichScanRow(row) {
  const summary = parseSummaryObject(row.summary_json);
  const scanOptions = normalizeScanOptions(safeParseJson(row.options_json), DEFAULT_SCAN_OPTIONS);
  const sourceContext = normalizeSourceContext(safeParseJson(row.source_context_json));
  const targetUrl = normalizeTargetUrl(row.target_url);
  return {
    ...row,
    target_url: targetUrl,
    scan_options: scanOptions,
    source_context: sourceContext,
    summary
  };
}

function getPlanDefaults() {
  return [
    { id: 'starter', scans_limit: 30, sites_limit: 10, whitelabel: 1 },
    { id: 'growth', scans_limit: 120, sites_limit: 50, whitelabel: 1 },
    { id: 'agency', scans_limit: 350, sites_limit: 200, whitelabel: 1 }
  ];
}

let billingSchemaReady = false;

async function ensureBillingSchema(env) {
  if (billingSchemaReady) return;

  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_billing'"
  ).first();
  if (!table?.name) {
    throw new Error('billing_schema_missing:apply_d1_migrations');
  }

  billingSchemaReady = true;
}

async function ensurePlansSeeded(env) {
  const existing = await env.DB.prepare('SELECT COUNT(*) AS count FROM plans').first();
  if (Number(existing?.count || 0) > 0) {
    return;
  }

  const defaults = getPlanDefaults();
  for (const plan of defaults) {
    await env.DB.prepare(
      'INSERT INTO plans (id, scans_limit, sites_limit, whitelabel, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(plan.id, plan.scans_limit, plan.sites_limit, plan.whitelabel, nowIso())
      .run();
  }
}

async function getPlanById(env, planId) {
  return env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first();
}

async function getAllPlans(env) {
  const rows = await env.DB.prepare('SELECT * FROM plans ORDER BY scans_limit ASC').all();
  return rows.results || [];
}

async function ensureTenantBillingRow(env, tenantId, preferredPlanId = '') {
  await ensurePlansSeeded(env);
  await ensureBillingSchema(env);

  const now = nowIso();
  const defaultPlanId = getDefaultPlanId(env);
  const requestedPlanId = String(preferredPlanId || '').trim();
  const fallbackPlanId = defaultPlanId;
  let validatedPreferredPlanId = '';

  let seedPlanId = fallbackPlanId;
  if (requestedPlanId) {
    const requestedPlan = await getPlanById(env, requestedPlanId);
    if (requestedPlan) {
      seedPlanId = requestedPlanId;
      validatedPreferredPlanId = requestedPlanId;
    }
  }

  await env.DB.prepare(
    [
      'INSERT INTO tenant_billing (tenant_id, plan_id, billing_status, created_at, updated_at)',
      'VALUES (?, ?, ?, ?, ?)',
      'ON CONFLICT(tenant_id) DO NOTHING'
    ].join(' ')
  )
    .bind(tenantId, seedPlanId, 'trial', now, now)
    .run();

  const existing = await env.DB.prepare('SELECT * FROM tenant_billing WHERE tenant_id = ?').bind(tenantId).first();
  if (!existing) return null;

  if (validatedPreferredPlanId && validatedPreferredPlanId !== String(existing.plan_id || '').trim()) {
    await env.DB.prepare('UPDATE tenant_billing SET plan_id = ?, updated_at = ? WHERE tenant_id = ?')
      .bind(validatedPreferredPlanId, nowIso(), tenantId)
      .run();
  }

  return env.DB.prepare('SELECT * FROM tenant_billing WHERE tenant_id = ?').bind(tenantId).first();
}

async function getTenantBillingRow(env, tenantId) {
  await ensureBillingSchema(env);
  return env.DB.prepare('SELECT * FROM tenant_billing WHERE tenant_id = ?').bind(tenantId).first();
}

async function updateTenantBilling(env, tenantId, patch = {}) {
  const existing = (await ensureTenantBillingRow(env, tenantId, patch.plan_id || '')) || {};
  const defaultPlanId = getDefaultPlanId(env);
  const merged = {
    plan_id: hasOwnProperty(patch, 'plan_id')
      ? (String(patch.plan_id || '').trim() || existing.plan_id || defaultPlanId)
      : (String(existing.plan_id || '').trim() || defaultPlanId),
    billing_status: hasOwnProperty(patch, 'billing_status')
      ? (String(patch.billing_status || '').trim() || existing.billing_status || 'trial')
      : (String(existing.billing_status || '').trim() || 'trial'),
    stripe_customer_id: hasOwnProperty(patch, 'stripe_customer_id')
      ? normalizeNullableString(patch.stripe_customer_id)
      : normalizeNullableString(existing.stripe_customer_id),
    stripe_subscription_id: hasOwnProperty(patch, 'stripe_subscription_id')
      ? normalizeNullableString(patch.stripe_subscription_id)
      : normalizeNullableString(existing.stripe_subscription_id),
    stripe_price_id: hasOwnProperty(patch, 'stripe_price_id')
      ? normalizeNullableString(patch.stripe_price_id)
      : normalizeNullableString(existing.stripe_price_id),
    current_period_end: hasOwnProperty(patch, 'current_period_end')
      ? normalizeNullableString(patch.current_period_end)
      : normalizeNullableString(existing.current_period_end),
    checkout_session_id: hasOwnProperty(patch, 'checkout_session_id')
      ? normalizeNullableString(patch.checkout_session_id)
      : normalizeNullableString(existing.checkout_session_id),
    updated_at: nowIso()
  };

  await env.DB.prepare(
    [
      'UPDATE tenant_billing SET',
      'plan_id = ?,',
      'billing_status = ?,',
      'stripe_customer_id = ?,',
      'stripe_subscription_id = ?,',
      'stripe_price_id = ?,',
      'current_period_end = ?,',
      'checkout_session_id = ?,',
      'updated_at = ?',
      'WHERE tenant_id = ?'
    ].join(' ')
  )
    .bind(
      merged.plan_id,
      merged.billing_status,
      merged.stripe_customer_id,
      merged.stripe_subscription_id,
      merged.stripe_price_id,
      merged.current_period_end,
      merged.checkout_session_id,
      merged.updated_at,
      tenantId
    )
    .run();

  await env.DB.prepare('UPDATE tenants SET billing_status = ? WHERE id = ?')
    .bind(merged.billing_status, tenantId)
    .run();

  return getTenantBillingRow(env, tenantId);
}

async function resolveTenantIdForStripeEvent(env, explicitTenantId, customerId, subscriptionId) {
  const preferred = String(explicitTenantId || '').trim();
  if (preferred) return preferred;

  const subscription = String(subscriptionId || '').trim();
  if (subscription) {
    const match = await env.DB.prepare('SELECT tenant_id FROM tenant_billing WHERE stripe_subscription_id = ?')
      .bind(subscription)
      .first();
    if (match?.tenant_id) return String(match.tenant_id);
  }

  const customer = String(customerId || '').trim();
  if (customer) {
    const match = await env.DB.prepare('SELECT tenant_id FROM tenant_billing WHERE stripe_customer_id = ?')
      .bind(customer)
      .first();
    if (match?.tenant_id) return String(match.tenant_id);
  }

  return '';
}

async function getUsageForTenantPeriod(env, tenantId, periodKey) {
  return env.DB.prepare('SELECT * FROM usage_counters WHERE tenant_id = ? AND period_key = ?')
    .bind(tenantId, periodKey)
    .first();
}

async function getTenantUsageContext(env, tenantId, periodKey) {
  const billing = await ensureTenantBillingRow(env, tenantId);
  const planId = String(billing?.plan_id || getDefaultPlanId(env)).trim() || getDefaultPlanId(env);
  const plan = (await getPlanById(env, planId)) || (await getPlanById(env, getDefaultPlanId(env)));
  const usage = await getUsageForTenantPeriod(env, tenantId, periodKey);
  return { billing, plan, usage };
}

function buildPlansPayload(env, plans) {
  return plans.map((plan) => ({
    id: plan.id,
    scans_limit: Number(plan.scans_limit || 0),
    sites_limit: Number(plan.sites_limit || 0),
    whitelabel: Number(plan.whitelabel || 0),
    stripe_price_configured: Boolean(getStripePriceIdForPlan(env, plan.id))
  }));
}

async function getSiteById(env, siteId) {
  return env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(siteId).first();
}

async function getTenantById(env, tenantId) {
  if (!tenantId) return null;
  return env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tenantId).first();
}

async function authorizeSiteRequest(request, env, siteId) {
  if (hasValidAdminAuth(request, env)) {
    return true;
  }

  const siteToken = extractSiteToken(request);
  if (!siteToken || !siteId) {
    return false;
  }

  const site = await getSiteById(env, siteId);
  if (!site || !site.token_hash) {
    return false;
  }

  return String(site.token_hash) === siteToken;
}

async function registerSite(request, env) {
  const body = await parseJson(request);
  if (!body || !body.site_url) {
    return badRequest('site_url is required');
  }

  const siteId = crypto.randomUUID();
  const tenantId = body.tenant_id || 'default-tenant';
  const requestedPlanId = String(body.plan_id || '').trim();
  const siteToken = crypto.randomUUID().replace(/-/g, '');
  const createdAt = nowIso();

  await ensurePlansSeeded(env);
  await ensureBillingSchema(env);

  const planId = (() => {
    if (requestedPlanId) return requestedPlanId;
    return getDefaultPlanId(env);
  })();

  await env.DB.prepare(
    'INSERT INTO tenants (id, name, billing_status, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
  )
    .bind(tenantId, body.tenant_name || 'Default Tenant', 'trial', createdAt)
    .run();

  await env.DB.prepare(
    [
      'INSERT INTO sites (id, tenant_id, site_url, wp_version, php_version, plugin_version, timezone, token_hash, created_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ].join(' ')
  )
    .bind(
      siteId,
      tenantId,
      body.site_url,
      body.wp_version || '',
      body.php_version || '',
      body.plugin_version || '',
      body.timezone || 'UTC',
      siteToken,
      createdAt
    )
    .run();

  await env.DB.prepare(
    [
      'INSERT INTO usage_counters (tenant_id, period_key, scans_used, active_sites, updated_at)',
      'VALUES (?, ?, 0, 1, ?)',
      'ON CONFLICT(tenant_id, period_key) DO UPDATE SET',
      'active_sites = MAX(active_sites, 1), updated_at = excluded.updated_at'
    ].join(' ')
  )
    .bind(tenantId, createdAt.slice(0, 7), createdAt)
    .run();

  const billing = await ensureTenantBillingRow(env, tenantId, planId);

  return json({
    site_id: siteId,
    tenant_id: tenantId,
    plan_id: String(billing?.plan_id || planId),
    billing_status: String(billing?.billing_status || 'trial'),
    site_token: siteToken,
    created_at: createdAt
  });
}

async function incrementUsageForSite(env, siteId, createdAt) {
  const site = await env.DB.prepare('SELECT tenant_id FROM sites WHERE id = ?').bind(siteId).first();
  if (!site || !site.tenant_id) {
    return;
  }

  const periodKey = createdAt.slice(0, 7);
  await env.DB.prepare(
    [
      'INSERT INTO usage_counters (tenant_id, period_key, scans_used, active_sites, updated_at)',
      'VALUES (?, ?, 0, 1, ?)',
      'ON CONFLICT(tenant_id, period_key) DO NOTHING'
    ].join(' ')
  )
    .bind(site.tenant_id, periodKey, createdAt)
    .run();

  await env.DB.prepare(
    'UPDATE usage_counters SET scans_used = scans_used + 1, updated_at = ? WHERE tenant_id = ? AND period_key = ?'
  )
    .bind(createdAt, site.tenant_id, periodKey)
    .run();
}

async function createScan(request, env) {
  const body = await parseJson(request);
  if (!body || !body.site_id) {
    return badRequest('site_id is required');
  }

  const site = await getSiteById(env, body.site_id);
  if (!site) {
    return badRequest('unknown site_id');
  }

  const authorized = await authorizeSiteRequest(request, env, body.site_id);
  if (!authorized) {
    return unauthorized();
  }

  const periodKey = nowIso().slice(0, 7);
  const usageContext = await getTenantUsageContext(env, site.tenant_id, periodKey);
  const scansUsed = Number(usageContext.usage?.scans_used || 0);
  const scansLimit = Number(usageContext.plan?.scans_limit || 0);
  if (scansLimit > 0 && scansUsed >= scansLimit) {
    return json(
      {
        error: 'scan_limit_reached',
        period_key: periodKey,
        scans_used: scansUsed,
        scans_limit: scansLimit,
        plan_id: String(usageContext.billing?.plan_id || getDefaultPlanId(env))
      },
      402
    );
  }

  const formMode = ['dry-run', 'live'].includes(String(body.form_mode || '').toLowerCase())
    ? String(body.form_mode).toLowerCase()
    : 'dry-run';
  const hasTargetUrl = hasOwnProperty(body, 'target_url');
  const targetUrl = normalizeTargetUrl(body.target_url);
  if (hasTargetUrl && String(body.target_url || '').trim() && !targetUrl) {
    return badRequest('target_url must be a valid http(s) URL');
  }
  const hasScanOptions = hasOwnProperty(body, 'scan_options');
  const scanOptions = normalizeScanOptions(hasScanOptions ? body.scan_options : null, DEFAULT_SCAN_OPTIONS);
  const sourceContext = normalizeSourceContext(body.source_context);

  const scanId = crypto.randomUUID();
  const createdAt = nowIso();
  const payload = {
    scan_id: scanId,
    site_id: body.site_id,
    profile: body.profile || 'full_qa_no_visual',
    form_mode: formMode,
    trigger: body.trigger || 'manual',
    sitemap_url: body.sitemap_url || '',
    target_url: targetUrl,
    scan_options: scanOptions,
    source_context: sourceContext,
    created_at: createdAt
  };

  try {
    await env.DB.prepare(
      [
        'INSERT INTO scans (id, site_id, status, profile, form_mode, trigger_type, sitemap_url, target_url, options_json, source_context_json, created_at, updated_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ].join(' ')
    )
      .bind(
        payload.scan_id,
        payload.site_id,
        'queued',
        payload.profile,
        payload.form_mode,
        payload.trigger,
        payload.sitemap_url,
        payload.target_url || null,
        hasScanOptions ? JSON.stringify(scanOptions) : null,
        sourceContext ? JSON.stringify(sourceContext) : null,
        createdAt,
        createdAt
      )
      .run();
  } catch (error) {
    if (!isMissingScanOptionColumnError(error)) {
      throw error;
    }

    await env.DB.prepare(
      [
        'INSERT INTO scans (id, site_id, status, profile, form_mode, trigger_type, sitemap_url, created_at, updated_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ].join(' ')
    )
      .bind(
        payload.scan_id,
        payload.site_id,
        'queued',
        payload.profile,
        payload.form_mode,
        payload.trigger,
        payload.sitemap_url,
        createdAt,
        createdAt
      )
      .run();
  }

  await incrementUsageForSite(env, payload.site_id, createdAt);

  if (env.SCAN_QUEUE) {
    await env.SCAN_QUEUE.send(payload);
  }

  return json(
    {
      scan_id: scanId,
      status: env.SCAN_QUEUE ? 'queued' : 'queued_local',
      created_at: createdAt,
      target_url: payload.target_url || '',
      scan_options: scanOptions,
      source_context: sourceContext
    },
    202
  );
}

async function getScan(request, scanId, env) {
  const row = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(scanId).first();
  if (!row) {
    return notFound();
  }

  const authorized = await authorizeSiteRequest(request, env, row.site_id);
  if (!authorized) {
    return unauthorized();
  }

  const issueTotals = await env.DB.prepare(
    'SELECT severity, COUNT(*) AS count FROM scan_issues WHERE scan_id = ? GROUP BY severity'
  )
    .bind(scanId)
    .all();

  const enrichedScan = enrichScanRow(row);
  const dbIssueTotals = issueTotals.results || [];
  const derivedIssueTotals = deriveIssueTotalsFromSummary(enrichedScan.summary || {});

  return json({
    scan: enrichedScan,
    issue_totals: dbIssueTotals.length > 0 ? dbIssueTotals : derivedIssueTotals
  });
}

async function listSiteScans(request, env, siteId, limitValue) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const limit = Math.max(1, Math.min(50, Number(limitValue || 10) || 10));
  let result;
  try {
    result = await env.DB.prepare(
      [
        'SELECT id, site_id, status, profile, form_mode, trigger_type, sitemap_url, target_url, options_json, source_context_json, created_at, updated_at, completed_at, summary_json',
        'FROM scans WHERE site_id = ? ORDER BY created_at DESC LIMIT ?'
      ].join(' ')
    )
      .bind(siteId, limit)
      .all();
  } catch (error) {
    if (!isMissingScanOptionColumnError(error)) {
      throw error;
    }

    result = await env.DB.prepare(
      [
        'SELECT id, site_id, status, profile, form_mode, trigger_type, sitemap_url, created_at, updated_at, completed_at, summary_json',
        'FROM scans WHERE site_id = ? ORDER BY created_at DESC LIMIT ?'
      ].join(' ')
    )
      .bind(siteId, limit)
      .all();
  }

  const scans = (result.results || []).map(enrichScanRow);
  return json({ scans });
}

async function getBranding(request, env, siteId) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const branding = await env.DB.prepare('SELECT * FROM site_branding WHERE site_id = ?').bind(siteId).first();
  if (!branding) {
    return json({
      branding: {
        site_id: siteId,
        brand_name: '',
        logo_url: '',
        primary_color: '#1f2937',
        accent_color: '#22c55e',
        footer_text: '',
        hide_launchguard_branding: 0,
        updated_at: ''
      }
    });
  }
  return json({ branding });
}

async function upsertBranding(request, env, siteId) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const body = await parseJson(request);
  if (!body) {
    return badRequest('invalid JSON body');
  }

  const updatedAt = nowIso();
  await env.DB.prepare(
    [
      'INSERT INTO site_branding (site_id, brand_name, logo_url, primary_color, accent_color, footer_text, hide_launchguard_branding, updated_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(site_id) DO UPDATE SET',
      'brand_name = excluded.brand_name,',
      'logo_url = excluded.logo_url,',
      'primary_color = excluded.primary_color,',
      'accent_color = excluded.accent_color,',
      'footer_text = excluded.footer_text,',
      'hide_launchguard_branding = excluded.hide_launchguard_branding,',
      'updated_at = excluded.updated_at'
    ].join(' ')
  )
    .bind(
      siteId,
      body.brand_name || '',
      body.logo_url || '',
      body.primary_color || '#1f2937',
      body.accent_color || '#22c55e',
      body.footer_text || '',
      body.hide_launchguard_branding ? 1 : 0,
      updatedAt
    )
    .run();

  const branding = await env.DB.prepare('SELECT * FROM site_branding WHERE site_id = ?').bind(siteId).first();
  return json({ branding });
}

async function getPlanLimits(request, env, siteId) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const site = await env.DB.prepare('SELECT tenant_id FROM sites WHERE id = ?').bind(siteId).first();
  if (!site) return notFound();

  const periodKey = nowIso().slice(0, 7);
  const usageContext = await getTenantUsageContext(env, site.tenant_id, periodKey);

  return json({
    period_key: periodKey,
    scans_used: Number(usageContext.usage?.scans_used || 0),
    scans_limit: Number(usageContext.plan?.scans_limit || 30),
    sites_limit: Number(usageContext.plan?.sites_limit || 10),
    plan_id: String(usageContext.billing?.plan_id || getDefaultPlanId(env)),
    billing_status: String(usageContext.billing?.billing_status || 'trial'),
    whitelabel: Number(usageContext.plan?.whitelabel || 0)
  });
}

async function stripeApiRequest(env, path, params) {
  const config = getStripeConfig(env);
  if (!config.secretKey) {
    throw new Error('stripe_secret_missing');
  }

  const response = await fetch(`https://api.stripe.com/v1/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'wplaunchguard-worker'
    },
    body: params.toString()
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(payload?.error?.message || `stripe_request_failed_${response.status}`);
    throw new Error(message);
  }
  return payload;
}

function extractSuccessUrl(body) {
  const candidate = String(body?.success_url || '').trim();
  return /^https?:\/\//i.test(candidate) ? candidate : '';
}

function extractCancelUrl(body) {
  const candidate = String(body?.cancel_url || '').trim();
  return /^https?:\/\//i.test(candidate) ? candidate : '';
}

async function createCheckoutSession(request, env, siteId) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const site = await getSiteById(env, siteId);
  if (!site) return notFound();

  const body = await parseJson(request);
  if (!body) return badRequest('invalid JSON body');

  const requestedPlanId = String(body.plan_id || '').trim().toLowerCase();
  if (!requestedPlanId) {
    return badRequest('plan_id is required');
  }

  const plan = await getPlanById(env, requestedPlanId);
  if (!plan) {
    return badRequest('unknown plan_id');
  }

  const successUrl = extractSuccessUrl(body);
  const cancelUrl = extractCancelUrl(body);
  if (!successUrl || !cancelUrl) {
    return badRequest('success_url and cancel_url are required');
  }

  const stripePriceId = getStripePriceIdForPlan(env, requestedPlanId);
  if (!stripePriceId) {
    return json({ error: 'stripe_price_not_configured', plan_id: requestedPlanId }, 503);
  }

  const stripeConfig = getStripeConfig(env);
  if (!stripeConfig.secretKey) {
    return json({ error: 'stripe_not_configured' }, 503);
  }

  const billing = await ensureTenantBillingRow(env, site.tenant_id, requestedPlanId);
  if (!billing) {
    return json({ error: 'billing_record_unavailable' }, 500);
  }

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', stripePriceId);
  params.set('line_items[0][quantity]', '1');
  params.set('allow_promotion_codes', 'true');
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('client_reference_id', String(site.tenant_id));
  params.set('metadata[tenant_id]', String(site.tenant_id));
  params.set('metadata[site_id]', String(site.id));
  params.set('metadata[plan_id]', requestedPlanId);
  params.set('subscription_data[metadata][tenant_id]', String(site.tenant_id));
  params.set('subscription_data[metadata][site_id]', String(site.id));
  params.set('subscription_data[metadata][plan_id]', requestedPlanId);

  if (billing.stripe_customer_id) {
    params.set('customer', String(billing.stripe_customer_id));
  }

  let session;
  try {
    session = await stripeApiRequest(env, 'checkout/sessions', params);
  } catch (error) {
    return json(
      {
        error: 'stripe_checkout_failed',
        message: String(error && error.message ? error.message : error)
      },
      502
    );
  }

  await updateTenantBilling(env, site.tenant_id, {
    plan_id: requestedPlanId,
    checkout_session_id: String(session.id || ''),
    stripe_customer_id: session.customer || undefined
  });

  return json({
    checkout_session_id: String(session.id || ''),
    checkout_url: String(session.url || ''),
    plan_id: requestedPlanId
  });
}

async function getBillingOverview(request, env, siteId) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const site = await getSiteById(env, siteId);
  if (!site) return notFound();

  const billing = await ensureTenantBillingRow(env, site.tenant_id);
  const plans = buildPlansPayload(env, await getAllPlans(env));
  const currentPlan = (await getPlanById(env, String(billing?.plan_id || getDefaultPlanId(env)))) || null;

  return json({
    billing: {
      tenant_id: String(site.tenant_id),
      plan_id: String(billing?.plan_id || getDefaultPlanId(env)),
      billing_status: String(billing?.billing_status || 'trial'),
      current_period_end: String(billing?.current_period_end || ''),
      has_customer: Boolean(billing?.stripe_customer_id),
      has_subscription: Boolean(billing?.stripe_subscription_id)
    },
    current_plan: currentPlan
      ? {
          id: currentPlan.id,
          scans_limit: Number(currentPlan.scans_limit || 0),
          sites_limit: Number(currentPlan.sites_limit || 0),
          whitelabel: Number(currentPlan.whitelabel || 0)
        }
      : null,
    plans
  });
}

async function handleStripeCheckoutSessionCompleted(env, eventObject) {
  const metadata = (eventObject && eventObject.metadata) || {};
  const tenantId = await resolveTenantIdForStripeEvent(
    env,
    metadata.tenant_id || eventObject.client_reference_id,
    eventObject.customer,
    eventObject.subscription
  );
  if (!tenantId) {
    return;
  }

  const planId = String(metadata.plan_id || '').trim().toLowerCase();
  await updateTenantBilling(env, tenantId, {
    plan_id: planId || undefined,
    billing_status: 'active',
    stripe_customer_id: eventObject.customer || undefined,
    stripe_subscription_id: eventObject.subscription || undefined,
    checkout_session_id: eventObject.id || undefined
  });
}

async function handleStripeSubscriptionEvent(env, eventType, eventObject) {
  const metadata = (eventObject && eventObject.metadata) || {};
  const stripePriceId = String(eventObject?.items?.data?.[0]?.price?.id || '').trim();
  const planFromPrice = getPlanIdFromStripePriceId(env, stripePriceId);
  const planId = String(metadata.plan_id || planFromPrice || '').trim().toLowerCase();
  const tenantId = await resolveTenantIdForStripeEvent(
    env,
    metadata.tenant_id,
    eventObject.customer,
    eventObject.id
  );
  if (!tenantId) {
    return;
  }

  await updateTenantBilling(env, tenantId, {
    plan_id: planId || undefined,
    billing_status: mapStripeSubscriptionStatus(eventObject.status, eventType),
    stripe_customer_id: eventObject.customer || undefined,
    stripe_subscription_id: eventObject.id || undefined,
    stripe_price_id: stripePriceId || undefined,
    current_period_end: unixSecondsToIso(eventObject.current_period_end) || null
  });
}

async function handleStripeInvoicePaymentFailed(env, eventObject) {
  const tenantId = await resolveTenantIdForStripeEvent(
    env,
    '',
    eventObject.customer,
    eventObject.subscription
  );
  if (!tenantId) {
    return;
  }

  await updateTenantBilling(env, tenantId, {
    billing_status: 'past_due'
  });
}

async function handleStripeWebhook(request, env) {
  await ensureBillingSchema(env);
  const stripeConfig = getStripeConfig(env);
  if (!stripeConfig.webhookSecret) {
    return json({ error: 'stripe_webhook_not_configured' }, 503);
  }

  const signature = String(request.headers.get('stripe-signature') || '').trim();
  const rawBody = await request.text();
  if (!signature) {
    return unauthorized();
  }

  const verified = await verifyStripeWebhookSignature(rawBody, signature, stripeConfig.webhookSecret);
  if (!verified) {
    return unauthorized();
  }

  const event = safeParseJson(rawBody);
  if (!event || typeof event !== 'object') {
    return badRequest('invalid stripe webhook payload');
  }

  const eventType = String(event.type || '').trim();
  const eventObject = event?.data?.object || {};

  if (eventType === 'checkout.session.completed') {
    await handleStripeCheckoutSessionCompleted(env, eventObject);
  }

  if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(eventType)) {
    await handleStripeSubscriptionEvent(env, eventType, eventObject);
  }

  if (eventType === 'invoice.payment_failed') {
    await handleStripeInvoicePaymentFailed(env, eventObject);
  }

  return json({ ok: true, received: true, event_type: eventType });
}

function mergeSummary(existingSummaryRaw, patch) {
  const base = safeParseJson(existingSummaryRaw);
  const baseObject = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  return { ...baseObject, ...patch };
}

function getPublicApiBase(env) {
  return String(env.PUBLIC_API_BASE || '').trim().replace(/\/+$/, '');
}

function buildScanReportIndexUrl(env, scanId, token) {
  const base = getPublicApiBase(env);
  if (!base || !scanId || !token) return '';
  return `${base}/v1/reports/${encodeURIComponent(scanId)}/qa_html/index.html?t=${encodeURIComponent(token)}`;
}

function normalizeReportAssetPath(rawPath) {
  const decoded = decodeURIComponent(String(rawPath || '').trim());
  const parts = decoded
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (parts.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) {
    return '';
  }

  return parts.join('/');
}

function extractReportRequest(pathname) {
  const prefix = '/v1/reports/';
  if (!pathname.startsWith(prefix)) {
    return { scanId: '', assetPath: '' };
  }

  const remainder = pathname.slice(prefix.length);
  const parts = remainder.split('/').filter(Boolean);
  if (parts.length < 2) {
    return { scanId: '', assetPath: '' };
  }

  const scanId = parts.shift() || '';
  const assetPath = parts.join('/');
  return {
    scanId: String(scanId).trim(),
    assetPath: normalizeReportAssetPath(assetPath)
  };
}

function contentTypeForReportAsset(assetPath) {
  const value = String(assetPath || '').toLowerCase();
  if (value.endsWith('.html')) return 'text/html; charset=utf-8';
  if (value.endsWith('.json')) return 'application/json; charset=utf-8';
  if (value.endsWith('.csv')) return 'text/csv; charset=utf-8';
  if (value.endsWith('.tsv')) return 'text/tab-separated-values; charset=utf-8';
  if (value.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (value.endsWith('.png')) return 'image/png';
  if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg';
  if (value.endsWith('.webp')) return 'image/webp';
  if (value.endsWith('.svg')) return 'image/svg+xml';
  if (value.endsWith('.txt') || value.endsWith('.log') || value.endsWith('.md')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function getScanReportAsset(request, env, scanId, assetPath, url) {
  if (!env.ARTIFACTS_BUCKET) {
    return json({ error: 'report_storage_missing' }, 503);
  }

  if (!scanId || !assetPath) {
    return notFound();
  }

  const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(scanId).first();
  if (!scan) {
    return notFound();
  }

  const summary = parseSummaryObject(scan.summary_json);
  const expectedToken = String(summary.report_public_token || '').trim();
  const providedToken = String(url.searchParams.get('t') || '').trim();
  if (!expectedToken || !providedToken || expectedToken !== providedToken) {
    return unauthorized();
  }

  const prefix = String(summary.report_r2_prefix || '').trim().replace(/\/+$/, '');
  if (!prefix) {
    return notFound();
  }

  const objectKey = `${prefix}/${assetPath}`;
  const reportObject = await env.ARTIFACTS_BUCKET.get(objectKey);
  if (!reportObject) {
    return notFound();
  }

  const headers = new Headers();
  headers.set('content-type', contentTypeForReportAsset(assetPath));
  headers.set('cache-control', 'private, max-age=60');
  headers.set('x-robots-tag', 'noindex, nofollow');

  if (reportObject.httpEtag) {
    headers.set('etag', reportObject.httpEtag);
  }

  return new Response(reportObject.body, { status: 200, headers });
}

async function dispatchScanToGitHub(env, scan, site) {
  const config = getGitHubDispatchConfig(env);
  if (!config.owner || !config.repo || !config.workflow || !config.ref || !config.token) {
    throw new Error('missing_github_dispatch_config');
  }

  const callbackPath = '/v1/internal/scan-callback';
  const callbackUrl = config.publicApiBase ? `${config.publicApiBase.replace(/\/+$/, '')}${callbackPath}` : '';
  const scanOptions = normalizeScanOptions(safeParseJson(scan.options_json), DEFAULT_SCAN_OPTIONS);
  const scanTargetUrl = normalizeTargetUrl(scan.target_url);
  const siteUrl = normalizeTargetUrl(site.site_url);
  const tenant = await getTenantById(env, site.tenant_id);
  const clientName = deriveClientSlugFromSite(site);
  const clientLabel = deriveClientLabel(site, tenant?.name || '');

  const payload = {
    ref: config.ref,
    inputs: {
      scan_id: String(scan.id),
      site_id: String(scan.site_id || ''),
      client_name: clientName,
      client_label: clientLabel,
      profile: mapProfileToQaProfile(scan.profile),
      single_url: scanTargetUrl || siteUrl || '',
      site_url: siteUrl,
      target_url: scanTargetUrl,
      sitemap_url: String(scan.sitemap_url || ''),
      form_mode: String(scan.form_mode || 'dry-run'),
      evidence_enabled: formatWorkflowBooleanInput(scanOptions.evidence_enabled),
      lighthouse_enabled: formatWorkflowBooleanInput(scanOptions.lighthouse_enabled),
      quick_scan_enabled: formatWorkflowBooleanInput(scanOptions.quick_scan_enabled),
      responsive_enabled: formatWorkflowBooleanInput(scanOptions.responsive_enabled),
      viewport_preset: normalizeViewportPreset(scanOptions.viewport_preset, 'desktop'),
      callback_url: callbackUrl
    }
  };

  const endpoint = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${config.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'wplaunchguard-worker',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`github_dispatch_failed:${response.status}:${errorBody.slice(0, 500)}`);
  }

  return {
    dispatched_at: nowIso(),
    repository: `${config.owner}/${config.repo}`,
    workflow: config.workflow,
    ref: config.ref,
    client_name: clientName,
    client_label: clientLabel,
    profile: payload.inputs.profile,
    site_url: payload.inputs.site_url,
    target_url: scanTargetUrl,
    scan_options: scanOptions,
    callback_url: callbackUrl
  };
}

async function queueConsumer(batch, env) {
  const timestamp = nowIso();

  for (const message of batch.messages) {
    const payload = message.body || {};
    const scanId = String(payload.scan_id || '').trim();

    if (!scanId) {
      message.ack();
      continue;
    }

    const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(scanId).first();
    if (!scan) {
      message.ack();
      continue;
    }

    const site = await getSiteById(env, scan.site_id);
    if (!site) {
      await env.DB.prepare('UPDATE scans SET status = ?, updated_at = ?, completed_at = ?, summary_json = ? WHERE id = ?')
        .bind('failed', timestamp, timestamp, JSON.stringify({ error: 'site_not_found_for_scan' }), scanId)
        .run();
      message.ack();
      continue;
    }

    await env.DB.prepare('UPDATE scans SET status = ?, updated_at = ? WHERE id = ?').bind('running', timestamp, scanId).run();

    try {
      const dispatchMeta = await dispatchScanToGitHub(env, scan, site);
      const merged = mergeSummary(scan.summary_json, {
        dispatch: dispatchMeta,
        queue_message_id: String(message.id || '')
      });

      await env.DB.prepare('UPDATE scans SET status = ?, updated_at = ?, summary_json = ? WHERE id = ?')
        .bind('dispatched', nowIso(), JSON.stringify(merged), scanId)
        .run();
    } catch (error) {
      const merged = mergeSummary(scan.summary_json, {
        dispatch_error: String(error && error.message ? error.message : error),
        failed_at: nowIso()
      });
      await env.DB.prepare('UPDATE scans SET status = ?, updated_at = ?, completed_at = ?, summary_json = ? WHERE id = ?')
        .bind('failed', nowIso(), nowIso(), JSON.stringify(merged), scanId)
        .run();
    }

    message.ack();
  }
}

async function handleScanCallback(request, env) {
  const expectedToken = String(env.SCAN_CALLBACK_TOKEN || '').trim();
  if (!expectedToken) {
    return json({ error: 'callback_not_configured' }, 503);
  }

  const providedToken = extractCallbackToken(request);
  if (!providedToken || providedToken !== expectedToken) {
    return unauthorized();
  }

  const body = await parseJson(request);
  if (!body || !body.scan_id || !body.status) {
    return badRequest('scan_id and status are required');
  }

  const scanId = String(body.scan_id).trim();
  const status = String(body.status).trim().toLowerCase();
  if (!['running', 'dispatched', 'completed', 'failed', 'cancelled'].includes(status)) {
    return badRequest('invalid status');
  }

  const existing = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(scanId).first();
  if (!existing) {
    return notFound();
  }

  const summaryPatch = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const summary = mergeSummary(existing.summary_json, {
    callback_received_at: nowIso(),
    callback_status: status,
    ...summaryPatch
  });

  const r2Prefix = String(summary.report_r2_prefix || '').trim().replace(/\/+$/, '');
  if (r2Prefix) {
    const reportToken = String(summary.report_public_token || '').trim() || crypto.randomUUID().replace(/-/g, '');
    summary.report_public_token = reportToken;
    summary.report_r2_prefix = r2Prefix;
    summary.report_index_url = buildScanReportIndexUrl(env, scanId, reportToken);
  }

  const completedAt = isTerminalScanStatus(status) ? nowIso() : existing.completed_at;
  await env.DB.prepare('UPDATE scans SET status = ?, updated_at = ?, completed_at = ?, summary_json = ? WHERE id = ?')
    .bind(status, nowIso(), completedAt || null, JSON.stringify(summary), scanId)
    .run();

  return json({ ok: true, scan_id: scanId, status });
}

function extractSiteIdFromPath(pathname, suffix) {
  if (!pathname.startsWith('/v1/sites/') || !pathname.endsWith(suffix)) {
    return '';
  }
  return pathname.replace('/v1/sites/', '').replace(suffix, '').trim();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'GET' && pathname === '/health') {
      return json({ ok: true, service: 'launchguard-api', time: nowIso() });
    }

    if (!env.DB) {
      return json({ error: 'DB binding missing' }, 500);
    }

    if (request.method === 'POST' && pathname === '/v1/stripe/webhook') {
      return handleStripeWebhook(request, env);
    }

    if (request.method === 'POST' && pathname === '/v1/internal/scan-callback') {
      return handleScanCallback(request, env);
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/reports/')) {
      const reportRequest = extractReportRequest(pathname);
      if (!reportRequest.scanId || !reportRequest.assetPath) {
        return notFound();
      }
      return getScanReportAsset(request, env, reportRequest.scanId, reportRequest.assetPath, url);
    }

    if (request.method === 'POST' && pathname === '/v1/sites/register') {
      return registerSite(request, env);
    }

    if (request.method === 'POST' && pathname === '/v1/scans') {
      return createScan(request, env);
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/scans/')) {
      const scanId = pathname.replace('/v1/scans/', '').trim();
      if (!scanId) return notFound();
      return getScan(request, scanId, env);
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/sites/') && pathname.endsWith('/scans')) {
      const siteId = extractSiteIdFromPath(pathname, '/scans');
      if (!siteId) return notFound();
      return listSiteScans(request, env, siteId, url.searchParams.get('limit'));
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/sites/') && pathname.endsWith('/branding')) {
      const siteId = extractSiteIdFromPath(pathname, '/branding');
      if (!siteId) return notFound();
      return getBranding(request, env, siteId);
    }

    if (request.method === 'PUT' && pathname.startsWith('/v1/sites/') && pathname.endsWith('/branding')) {
      const siteId = extractSiteIdFromPath(pathname, '/branding');
      if (!siteId) return notFound();
      return upsertBranding(request, env, siteId);
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/sites/') && pathname.endsWith('/limits')) {
      const siteId = extractSiteIdFromPath(pathname, '/limits');
      if (!siteId) return notFound();
      return getPlanLimits(request, env, siteId);
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/sites/') && pathname.endsWith('/billing')) {
      const siteId = extractSiteIdFromPath(pathname, '/billing');
      if (!siteId) return notFound();
      return getBillingOverview(request, env, siteId);
    }

    if (request.method === 'POST' && pathname.startsWith('/v1/sites/') && pathname.endsWith('/billing/checkout-session')) {
      const siteId = extractSiteIdFromPath(pathname, '/billing/checkout-session');
      if (!siteId) return notFound();
      return createCheckoutSession(request, env, siteId);
    }

    return notFound();
  },

  async queue(batch, env) {
    if (!env.DB) return;
    await queueConsumer(batch, env);
  }
};
