ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0;

-- Backfill: existing rows with folder = 'main' are the main group
UPDATE registered_groups SET is_main = 1 WHERE folder = 'main';
