ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS context_mode TEXT DEFAULT 'isolated';
