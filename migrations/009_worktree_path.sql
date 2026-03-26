-- Add worktree_path to dispatch_slots for per-dispatch git worktree isolation.
-- Each parallel dispatch creates an isolated git worktree; the path is recorded
-- here so it can be cleaned up on slot free or startup reconciliation.
ALTER TABLE dispatch_slots ADD COLUMN IF NOT EXISTS worktree_path TEXT;
