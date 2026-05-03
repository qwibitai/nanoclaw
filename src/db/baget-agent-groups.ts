/**
 * Baget-specific lookups + mutations on agent_groups. Lives in its own file
 * (not folded into agent-groups.ts) so the upstream rebase surface stays
 * small — non-Baget installs never touch these helpers.
 *
 * The functions here are the only callsites that read/write the
 * `user_id` / `company_id` / `archived_at` columns added in migration 014.
 */
import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

/**
 * Look up the Baget agent_group for a given (userId, companyId). Returns
 * undefined when the founder hasn't been provisioned yet — the admin
 * server uses this to decide between INSERT and refresh-prompt-only.
 *
 * Includes archived rows on purpose: a re-pair by the same founder after
 * a previous DELETE should resurrect the soft-deleted row (clear
 * archived_at, mint a fresh token) rather than create a stranded second
 * row with the same (userId, companyId) — which the partial UNIQUE
 * index would reject anyway.
 */
export function getBagetAgentGroup(userId: string, companyId: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE user_id = ? AND company_id = ?').get(userId, companyId) as
    | AgentGroup
    | undefined;
}

/**
 * Create a Baget-provisioned agent_group. Throws on a duplicate
 * (userId, companyId) — the caller (admin server) catches it and falls
 * back to the refresh path.
 */
export function createBagetAgentGroup(group: {
  id: string;
  name: string;
  folder: string;
  user_id: string;
  company_id: string;
  agent_provider?: string | null;
  baget_team_members: string;
  created_at: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups
         (id, name, folder, agent_provider, user_id, company_id, baget_team_members, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @user_id, @company_id, @baget_team_members, @created_at)`,
    )
    .run({
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider ?? null,
      user_id: group.user_id,
      company_id: group.company_id,
      baget_team_members: group.baget_team_members,
      created_at: group.created_at,
    });
}

/**
 * Update the per-founder team-name JSON on an existing row. Called by
 * the admin server's refresh-prompt route when the founder renames a
 * team member.
 */
export function updateBagetTeamMembers(id: string, teamMembersJson: string): void {
  getDb().prepare('UPDATE agent_groups SET baget_team_members = ? WHERE id = ?').run(teamMembersJson, id);
}

/** Fetch by id — central DB returns the row even when archived. */
export function getBagetAgentGroupById(id: string): import('../types.js').AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as
    | import('../types.js').AgentGroup
    | undefined;
}

/**
 * Soft-delete: stamp `archived_at`. Does NOT cascade to messaging_groups
 * or sessions — message history is preserved deliberately. The admin
 * DELETE endpoint follows up with `unbindBagetMessagingGroups` to drop
 * the chat→agent wiring so future inbound messages on the bound chat
 * fall through the router's no-agent path.
 */
export function archiveBagetAgentGroup(id: string, archivedAt: string): void {
  getDb().prepare('UPDATE agent_groups SET archived_at = ? WHERE id = ?').run(archivedAt, id);
}

/** Clear `archived_at` — used by re-provision-after-archive. */
export function unarchiveBagetAgentGroup(id: string): void {
  getDb().prepare('UPDATE agent_groups SET archived_at = NULL WHERE id = ?').run(id);
}

/**
 * Drop every `messaging_group_agents` row that wires a chat to this
 * agent_group, AND stamp `messaging_groups.denied_at` on every chat
 * this disconnect ORPHANS (i.e. no other agent is wired to it after
 * the unbind). Used by `DELETE /baget/agent-groups/:groupId` so
 * post-archive DMs from the founder's chat fall through the router's
 * no-agent fast-drop path instead of waking the (newly-archived)
 * runner OR escalating to the channel-request gate, which would build
 * an owner-approval card and re-create the binding behind the
 * founder's back.
 *
 * Why both columns:
 *
 *   - **DELETE on messaging_group_agents** drops the wiring so non-DM
 *     traffic (group chats with `agentCount === 0` and `!isMention`)
 *     silently drops at router.ts line 192.
 *
 *   - **UPDATE on messaging_groups.denied_at** is what handles the DM
 *     case (`isMention === true` for 1:1 founder DMs). Without the
 *     stamp, router.ts line 213 hands the message to
 *     `channelRequestGate` which, on owner approval, would
 *     `createMessagingGroupAgent(...)` — silently re-pairing the
 *     supposedly-disconnected channel.
 *
 * Why "orphans only" (NOT EXISTS clause):
 *
 *   The schema permits a chat to be wired to multiple agent_groups
 *   (UNIQUE is on the (mg, ag) pair, not on the chat). In Baget today
 *   that's a 1:1 invariant in practice (one founder = one agent_group
 *   per (user, company)), but if it ever becomes 1:N — or if a
 *   non-Baget operator wires up a shared chat — stamping `denied_at`
 *   on a chat that still has another wiring would silently mute the
 *   OTHER agent's traffic at router.ts line 194 with no UI breadcrumb.
 *   Restricting the UPDATE to chats this disconnect actually orphans
 *   keeps the deny semantically tied to "no agent serves this chat
 *   anymore."
 *
 * Idempotent on `denied_at` — only stamps rows that aren't already
 * denied, so calling this twice doesn't overwrite the original deny
 * timestamp. The original timestamp is forensically useful (when did
 * this chat first go dark) — overwriting it on re-disconnect would
 * erase that audit signal for no benefit.
 *
 * The two statements are issued sequentially, but every production
 * caller wraps this in a `getDb().transaction(...)` (see
 * `handleDelete` / `handleDeleteByTuple` in baget-admin-server.ts), so
 * a crash mid-helper rolls both back atomically. The UPDATE MUST run
 * before the DELETE — once the wiring rows are gone, the
 * `messaging_group_agents` subquery has nothing to match against.
 *
 * `deniedAt` must be an ISO-8601 string (caller decides — we don't
 * read the clock here so tests stay deterministic).
 *
 * Returns counts for both writes. Either can be 0:
 *   - `unbound: 0` → founder never completed pairing
 *   - `denied: 0` → all of this agent's chats were either already
 *     denied OR are still wired to another agent (so this disconnect
 *     didn't orphan them)
 */
export function unbindMessagingGroupsForAgent(
  agentGroupId: string,
  deniedAt: string,
): { unbound: number; denied: number } {
  const db = getDb();
  // Stamp denied_at FIRST — once we delete the wiring rows, the IN
  // subquery has nothing to join against and would silently no-op.
  // The NOT EXISTS clause restricts the stamp to chats THIS disconnect
  // orphans (see jsdoc "Why 'orphans only'").
  const denyRes = db
    .prepare(
      `UPDATE messaging_groups
          SET denied_at = ?
        WHERE denied_at IS NULL
          AND id IN (
            SELECT messaging_group_id
              FROM messaging_group_agents
             WHERE agent_group_id = ?
          )
          AND NOT EXISTS (
            SELECT 1
              FROM messaging_group_agents other
             WHERE other.messaging_group_id = messaging_groups.id
               AND other.agent_group_id <> ?
          )`,
    )
    .run(deniedAt, agentGroupId, agentGroupId);
  const unbindRes = db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(agentGroupId);
  return { unbound: unbindRes.changes, denied: denyRes.changes };
}

/**
 * Count the chat→agent bindings for this group. Used by the
 * `GET /baget/agent-groups/by-tuple` status endpoint to tell the
 * dashboard whether the founder has completed `/start` on Telegram
 * (binding count > 0) vs the row exists but no chat is bound yet
 * (count == 0 — provisioned but not paired).
 *
 * `messaging_group_agents` is the upstream table that wires platform
 * chats to agent_groups; the Baget Telegram adapter inserts a row
 * into it when the founder taps the deep link and consumes the
 * pairing token. Existence of any row → "paired" from the dashboard's
 * perspective.
 */
export function countMessagingGroupBindings(agentGroupId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id = ?')
    .get(agentGroupId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * First bound platform_chat_id for an agent_group, if any. The
 * dashboard widget uses this to render the deep-link button as
 * `t.me/<bot>` (open the existing chat) rather than the pairing
 * deep-link with token. Returns null when nothing is bound.
 *
 * Filters to platform='telegram' since that's the only channel
 * shipped today; widen the WHERE when Slack/WhatsApp adapters land.
 */
export function firstBoundChatId(agentGroupId: string): string | null {
  const TELEGRAM_PLATFORM_PREFIX = 'baget-telegram:';
  const row = getDb()
    .prepare(
      `SELECT mg.platform_id
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.agent_group_id = ?
          AND mg.channel_type = 'baget-telegram'
        ORDER BY mga.created_at ASC
        LIMIT 1`,
    )
    .get(agentGroupId) as { platform_id: string } | undefined;
  if (!row?.platform_id) return null;
  return row.platform_id.startsWith(TELEGRAM_PLATFORM_PREFIX)
    ? row.platform_id.slice(TELEGRAM_PLATFORM_PREFIX.length)
    : row.platform_id;
}

/**
 * Baget founder Telegram chats are 1:1 DMs. Once a founder chat is
 * explicitly paired, it must bypass the generic unknown-sender approval
 * flow even if the founder messaged the shared bot before tapping the deep
 * link. This reconciles any already-bound Baget Telegram chats back to the
 * founder-DM shape: direct/public, never denied, and wired with
 * sender_scope='all' plus ignored_message_policy='drop'.
 */
export function normalizeBoundBagetTelegramFounderChannels(): number {
  const messagingGroupResult = getDb()
    .prepare(
      `UPDATE messaging_groups
        SET unknown_sender_policy = 'public',
            is_group = 0,
            denied_at = NULL
      WHERE id IN (
        SELECT DISTINCT mg.id
          FROM messaging_groups mg
          JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
          JOIN agent_groups ag ON ag.id = mga.agent_group_id
         WHERE mg.channel_type = 'baget-telegram'
           AND ag.company_id IS NOT NULL
      )
        AND (
          unknown_sender_policy <> 'public'
          OR is_group <> 0
          OR denied_at IS NOT NULL
        )`,
    )
    .run();
  const wiringResult = getDb()
    .prepare(
      `UPDATE messaging_group_agents
          SET engage_mode = 'pattern',
              engage_pattern = '.',
              sender_scope = 'all',
              ignored_message_policy = 'drop',
              session_mode = 'shared',
              priority = 0
        WHERE id IN (
          SELECT DISTINCT mga.id
            FROM messaging_group_agents mga
            JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
            JOIN agent_groups ag ON ag.id = mga.agent_group_id
           WHERE mg.channel_type = 'baget-telegram'
             AND ag.company_id IS NOT NULL
        )
          AND (
            engage_mode <> 'pattern'
            OR COALESCE(engage_pattern, '') <> '.'
            OR sender_scope <> 'all'
            OR ignored_message_policy <> 'drop'
            OR session_mode <> 'shared'
            OR priority <> 0
          )`,
    )
    .run();
  return messagingGroupResult.changes + wiringResult.changes;
}
