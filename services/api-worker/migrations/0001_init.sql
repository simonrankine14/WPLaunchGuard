PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_status TEXT NOT NULL DEFAULT 'trial',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  scans_limit INTEGER NOT NULL,
  sites_limit INTEGER NOT NULL,
  whitelabel INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  wp_version TEXT,
  php_version TEXT,
  plugin_version TEXT,
  timezone TEXT,
  token_hash TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  scans_used INTEGER NOT NULL DEFAULT 0,
  active_sites INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, period_key),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS site_branding (
  site_id TEXT PRIMARY KEY,
  brand_name TEXT,
  logo_url TEXT,
  primary_color TEXT,
  accent_color TEXT,
  footer_text TEXT,
  hide_baseline_branding INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  status TEXT NOT NULL,
  profile TEXT NOT NULL,
  form_mode TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  sitemap_url TEXT,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS scan_issues (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scan_id) REFERENCES scans(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_issues_scan_id ON scan_issues(scan_id);
CREATE INDEX IF NOT EXISTS idx_scans_site_id ON scans(site_id);

CREATE TABLE IF NOT EXISTS scan_artifacts (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  signed_url_expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scan_id) REFERENCES scans(id)
);

CREATE INDEX IF NOT EXISTS idx_scan_artifacts_scan_id ON scan_artifacts(scan_id);
