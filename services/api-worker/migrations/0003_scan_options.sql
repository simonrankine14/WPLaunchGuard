-- 0003_scan_options.sql
-- Add per-scan targeting/options fields with safe defaults.
ALTER TABLE scans ADD COLUMN target_url TEXT DEFAULT NULL;
ALTER TABLE scans ADD COLUMN options_json TEXT NOT NULL DEFAULT '{"evidence_enabled":true,"lighthouse_enabled":true,"quick_scan_enabled":false,"responsive_enabled":false,"viewport_preset":"desktop"}';
ALTER TABLE scans ADD COLUMN source_context_json TEXT NOT NULL DEFAULT '{}';
