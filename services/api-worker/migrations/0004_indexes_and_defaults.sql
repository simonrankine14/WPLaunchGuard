-- 0004_indexes_and_defaults.sql
-- CQ-013: Add missing indexes on foreign-key columns to avoid full-table scans
-- on the most common query patterns (tenant lookups, rate-limit checks, scans by status).

-- Sites are frequently filtered by tenant when listing or rate-limit checking.
CREATE INDEX IF NOT EXISTS idx_sites_tenant_id ON sites(tenant_id);

-- Hourly rate-limit query: scans WHERE site_id IN (...) AND created_at >= ?
-- A composite covering both columns avoids a separate sort + filter step.
CREATE INDEX IF NOT EXISTS idx_scans_site_created ON scans(site_id, created_at);

-- Concurrent-scan rate-limit query: scans WHERE site_id IN (...) AND status IN ('queued','running')
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);

-- Scan issues are also queried by URL for per-page breakdowns.
CREATE INDEX IF NOT EXISTS idx_scan_issues_url ON scan_issues(url);

-- SEC-015: Migration 0003 now sets explicit defaults for new installs.
-- This migration keeps compatibility for already-existing databases.
