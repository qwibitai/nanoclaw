-- Rename the old text result column and add a new JSON result column.
-- Existing rows keep their legacy data in result_legacy; new rows use result_json.
ALTER TABLE task_run_logs RENAME COLUMN result TO result_legacy;
ALTER TABLE task_run_logs ADD COLUMN result_json TEXT;
