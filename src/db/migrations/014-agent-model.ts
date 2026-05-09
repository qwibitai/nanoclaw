/**
 * Per-agent-group model override for the active provider.
 *
 * Resolution at spawn time: agent_groups.model → CODEX_MODEL/ANTHROPIC_MODEL
 * env → provider's hardcoded default. Nullable so existing groups stay on
 * env/default behaviour until set explicitly.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'agent-model',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN model TEXT`);
  },
};
