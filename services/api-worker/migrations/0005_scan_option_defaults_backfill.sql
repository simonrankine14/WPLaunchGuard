-- 0005_scan_option_defaults_backfill.sql
-- Backfill nullable scan option/context columns introduced in 0003 and
-- enforce write-time defaults via trigger for legacy insert paths.

UPDATE scans
SET options_json = '{"evidence_enabled":true,"lighthouse_enabled":true,"quick_scan_enabled":false,"responsive_enabled":false,"viewport_preset":"desktop"}'
WHERE options_json IS NULL OR TRIM(options_json) = '';

UPDATE scans
SET source_context_json = '{}'
WHERE source_context_json IS NULL OR TRIM(source_context_json) = '';

CREATE TRIGGER IF NOT EXISTS trg_scans_fill_json_defaults_after_insert
AFTER INSERT ON scans
FOR EACH ROW
WHEN NEW.options_json IS NULL
   OR TRIM(NEW.options_json) = ''
   OR NEW.source_context_json IS NULL
   OR TRIM(NEW.source_context_json) = ''
BEGIN
  UPDATE scans
  SET options_json = CASE
      WHEN NEW.options_json IS NULL OR TRIM(NEW.options_json) = ''
        THEN '{"evidence_enabled":true,"lighthouse_enabled":true,"quick_scan_enabled":false,"responsive_enabled":false,"viewport_preset":"desktop"}'
      ELSE NEW.options_json
    END,
    source_context_json = CASE
      WHEN NEW.source_context_json IS NULL OR TRIM(NEW.source_context_json) = ''
        THEN '{}'
      ELSE NEW.source_context_json
    END
  WHERE id = NEW.id;
END;
