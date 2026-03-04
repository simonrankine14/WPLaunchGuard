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

function buildClientName(scanId) {
  const compact = String(scanId || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `scan${compact.slice(0, 12) || 'run'}`;
}

function mapProfileToQaProfile(scanProfile) {
  const value = String(scanProfile || '').toLowerCase();
  return value === 'engineering-deep' ? 'engineering-deep' : 'client-safe';
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

function getPlanDefaults() {
  return [
    { id: 'starter', scans_limit: 30, sites_limit: 10, whitelabel: 1 },
    { id: 'growth', scans_limit: 120, sites_limit: 50, whitelabel: 1 },
    { id: 'agency', scans_limit: 350, sites_limit: 200, whitelabel: 1 }
  ];
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

async function getSiteById(env, siteId) {
  return env.DB.prepare('SELECT * FROM sites WHERE id = ?').bind(siteId).first();
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
  const planId = body.plan_id || String(env.DEFAULT_PLAN || 'starter');
  const siteToken = crypto.randomUUID().replace(/-/g, '');
  const createdAt = nowIso();

  await ensurePlansSeeded(env);

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

  return json({
    site_id: siteId,
    tenant_id: tenantId,
    plan_id: planId,
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

  const formMode = ['dry-run', 'live'].includes(String(body.form_mode || '').toLowerCase())
    ? String(body.form_mode).toLowerCase()
    : 'dry-run';

  const scanId = crypto.randomUUID();
  const createdAt = nowIso();
  const payload = {
    scan_id: scanId,
    site_id: body.site_id,
    profile: body.profile || 'full_qa_no_visual',
    form_mode: formMode,
    trigger: body.trigger || 'manual',
    sitemap_url: body.sitemap_url || '',
    created_at: createdAt
  };

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

  await incrementUsageForSite(env, payload.site_id, createdAt);

  if (env.SCAN_QUEUE) {
    await env.SCAN_QUEUE.send(payload);
  }

  return json(
    {
      scan_id: scanId,
      status: env.SCAN_QUEUE ? 'queued' : 'queued_local',
      created_at: createdAt
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

  return json({
    scan: row,
    issue_totals: issueTotals.results || []
  });
}

async function listSiteScans(request, env, siteId, limitValue) {
  const authorized = await authorizeSiteRequest(request, env, siteId);
  if (!authorized) {
    return unauthorized();
  }

  const limit = Math.max(1, Math.min(50, Number(limitValue || 10) || 10));
  const result = await env.DB.prepare(
    [
      'SELECT id, site_id, status, profile, form_mode, trigger_type, created_at, updated_at, completed_at',
      'FROM scans WHERE site_id = ? ORDER BY created_at DESC LIMIT ?'
    ].join(' ')
  )
    .bind(siteId, limit)
    .all();

  return json({ scans: result.results || [] });
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
  const usage = await env.DB.prepare('SELECT * FROM usage_counters WHERE tenant_id = ? AND period_key = ?')
    .bind(site.tenant_id, periodKey)
    .first();

  const defaultPlan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?')
    .bind(String(env.DEFAULT_PLAN || 'starter'))
    .first();

  return json({
    period_key: periodKey,
    scans_used: Number(usage?.scans_used || 0),
    scans_limit: Number(defaultPlan?.scans_limit || 30),
    sites_limit: Number(defaultPlan?.sites_limit || 10)
  });
}

function mergeSummary(existingSummaryRaw, patch) {
  const base = safeParseJson(existingSummaryRaw);
  const baseObject = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  return { ...baseObject, ...patch };
}

async function dispatchScanToGitHub(env, scan, site) {
  const config = getGitHubDispatchConfig(env);
  if (!config.owner || !config.repo || !config.workflow || !config.ref || !config.token) {
    throw new Error('missing_github_dispatch_config');
  }

  const callbackPath = '/v1/internal/scan-callback';
  const callbackUrl = config.publicApiBase ? `${config.publicApiBase.replace(/\/+$/, '')}${callbackPath}` : '';

  const payload = {
    ref: config.ref,
    inputs: {
      scan_id: String(scan.id),
      site_id: String(scan.site_id || ''),
      client_name: buildClientName(scan.id),
      profile: mapProfileToQaProfile(scan.profile),
      single_url: String(site.site_url || ''),
      sitemap_url: String(scan.sitemap_url || ''),
      form_mode: String(scan.form_mode || 'dry-run'),
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
    client_name: payload.inputs.client_name,
    profile: payload.inputs.profile,
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

    if (request.method === 'POST' && pathname === '/v1/internal/scan-callback') {
      return handleScanCallback(request, env);
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

    return notFound();
  },

  async queue(batch, env) {
    if (!env.DB) return;
    await queueConsumer(batch, env);
  }
};
