/**
 * Per-agent model selection — adds `model` columns to `agent_groups` and
 * `sessions`, mirroring the `agent_provider` precedence ladder.
 *
 * Resolution order: sessions.model → agent_groups.model →
 * container.json.model → SDK default (whatever the provider decides, e.g.
 * Claude Code SDK picks its built-in default; Codex falls back to
 * CODEX_MODEL env / built-in default).
 *
 * Nullable; empty means "inherit downstream." Model strings pass through
 * opaquely (we don't validate here), so SDK conventions like
 * `sonnet[1m]` / `opus[1m]` Just Work.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'agent-model',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN model TEXT`);
    db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`);
  },
};
