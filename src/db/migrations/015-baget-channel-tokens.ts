/**
 * Per-(user, company) channel-token storage for `RUNTIME=single-process`
 * mode (Baget on Railway).
 *
 * Architecture context:
 *   In `RUNTIME=docker` (upstream NanoClaw default), each founder's
 *   agent runs in its own Docker container and the OneCLI gateway
 *   proxies their outbound fetches, injecting `Authorization: Bearer
 *   <token>` from a central vault. The vault is the source of truth;
 *   no token ever lives in container env.
 *
 *   In `RUNTIME=single-process` (Baget on Railway), every founder's
 *   agent runs as a Bun sub-process of the same Node host — there's no
 *   per-container env isolation, no OneCLI gateway, and no proxy layer
 *   to inject headers transparently. The agent reads
 *   `process.env.BAGET_CHANNEL_TOKEN` directly (see
 *   container/agent-runner/src/mcp-tools/baget.ts), so the host's
 *   spawnSingleProcessRunner must INJECT that env at spawn time.
 *
 *   This table is the persistence layer for that injection. The host
 *   UPSERTs the bearer when baget.ai sends it via the create / bind
 *   admin endpoints, and SELECTs at every spawn to populate the child
 *   env. One row per agent_group (1:1 mapping to a (user, company)
 *   tuple — enforced by the partial UNIQUE index on agent_groups added
 *   in migration 014).
 *
 * Why ON DELETE CASCADE:
 *   `agent_groups` rows are normally soft-deleted (archived_at stamp,
 *   row stays), so CASCADE rarely fires in practice. But if the row IS
 *   ever hard-deleted (e.g. operator cleanup), we don't want orphan
 *   tokens that resurrect with the wrong identity if the agent_group_id
 *   is ever reused. CASCADE makes "drop the agent_group → drop its
 *   tokens" automatic. The admin DELETE handler also calls
 *   deleteChannelToken() explicitly so the token dies before the
 *   archive stamp lands — defense in depth.
 *
 * Why we store the token verbatim (not hashed):
 *   The host returns this value to the spawn env so the agent can use
 *   it as a bearer. A hash would defeat the use case (we can't put
 *   a SHA256 in an Authorization header). The same blast-radius
 *   reasoning applies as for any other host secret on Railway: if the
 *   container is compromised, all secrets in /app/data and process.env
 *   are exposed. The token rotates at every re-pair (UPSERT replaces),
 *   and baget.ai's side has its own revocation column on a separate
 *   `channel_tokens` table (see baget.ai's `apps/web/src/lib/channel-
 *   token.ts` for the resolver — verify the schema there before
 *   relying on it as the second-line revocation guarantee).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'baget-channel-tokens',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS baget_channel_tokens (
        agent_group_id   TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        token_value      TEXT NOT NULL,
        persisted_at     TEXT NOT NULL,
        rotated_from_at  TEXT
      );
    `);
  },
};
