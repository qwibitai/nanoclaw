# Migration: Multi-Bot Identity (`channel_type` Workaround → `bot_id`)

Local-only migration for the PR Factory NanoClaw instance at `/home/exedev/nanoclaw-pr-factory`.

## Problem

Three Discord bots (worker, supervisor, tester) share one Discord channel. The upstream schema identifies messaging groups by `(channel_type, platform_id)` — one bot per channel type. The current workaround registers each bot under a synthetic `channel_type` (`discord`, `discord-supervisor`, `discord-tester`), which works but:

- Conflates "what platform" with "which bot"
- Forces every routing/delivery code path to know about fake channel types
- Requires two local patches (channelName override, prefixed state adapter) that diverge from upstream

## Target State

All three bots register as `channel_type='discord'`. A new `bot_id` column on `messaging_groups` distinguishes them. The channel adapter registry supports multiple adapters per channel type, keyed by `(channel_type, bot_id)`.

## Pre-Migration Checklist

- [ ] Back up `data/v2.db`
- [ ] Back up all modified source files (`git stash` or snapshot)
- [ ] Stop the service: `systemctl --user stop nanoclaw-v2-6a5f643f`
- [ ] Note current bot tokens and their Discord user IDs (decode from tokens or check Discord dev portal)

## Steps

### 1. Extract Bot User IDs from Tokens

Discord bot tokens encode the bot's user ID as base64 in the first dot-separated segment. Add a utility to decode this.

**File:** `src/utils/discord-bot-id.ts` (new)

```typescript
export function botIdFromToken(token: string): string {
  const segment = token.split('.')[0];
  return Buffer.from(segment, 'base64').toString('utf8');
}
```

This runs at adapter registration time (every host startup). No API call needed.

### 2. Schema: Add `bot_id` to `messaging_groups`

**File:** `src/db/migrations/` — add next migration

```sql
ALTER TABLE messaging_groups ADD COLUMN bot_id TEXT;

-- Drop the old unique index and create the new one.
-- SQLite can't DROP CONSTRAINT, so we drop-and-recreate the index.
DROP INDEX IF EXISTS sqlite_autoindex_messaging_groups_1;
CREATE UNIQUE INDEX uq_messaging_groups_channel_platform_bot
  ON messaging_groups (channel_type, platform_id, bot_id);
```

Note: SQLite UNIQUE constraints created via `CREATE TABLE ... UNIQUE(...)` produce auto-indexes. We need to verify the auto-index name by inspecting the DB before writing the migration. If the auto-index can't be dropped, recreate the table.

**File:** `src/types.ts` — add `bot_id?: string | null` to `MessagingGroup` interface.

### 3. Channel Adapter Registry: Support Multiple Adapters per Channel Type

**File:** `src/channels/channel-registry.ts`

Current: `activeAdapters` is `Map<string, ChannelAdapter>` keyed by `channelType`.

Change to: `Map<string, ChannelAdapter>` keyed by `channelType:botId` (or just `channelType` for single-bot channels).

```
Lookup priority:
  1. getChannelAdapter('discord', 'bot123') → try key 'discord:bot123'
  2. Fall back to 'discord' (single-bot / legacy)
```

Specific changes:

- `registerChannelAdapter()` — accept optional `botId` parameter
- `getChannelAdapter(channelType, botId?)` — two-tier lookup as above
- `initChannelAdapters()` — store adapters with composite key when `adapter.botId` is set
- Add `botId?: string` to the `ChannelAdapter` interface in `src/channels/adapter.ts`
- `getActiveAdapters()` — unchanged (returns all values)

### 4. Discord Bot Registration: Use `bot_id` Instead of Synthetic Channel Types

**File:** `src/modules/pr-factory/discord-bots.ts`

Current: calls `registerChannelAdapter('discord-supervisor', ...)` and `registerChannelAdapter('discord-tester', ...)`.

Change: all three bots register as `registerChannelAdapter('discord', { ..., botId })`. The `botId` is extracted from the token via `botIdFromToken()`.

```typescript
registerChannelAdapter('discord', {
  botId: botIdFromToken(token),
  factory: () => {
    // ... same adapter creation, but no channelName override needed
    return createChatSdkBridge({ adapter, concurrency: 'concurrent', botToken: token, supportsThreads: true });
  },
});
```

The registry must accept multiple registrations for the same channel name (keyed by `name:botId`).

**File:** `src/channels/discord.ts`

Same change: extract `botId` from the primary bot token and pass it to `registerChannelAdapter`.

### 5. Chat SDK Bridge: Remove `channelName` Override

**File:** `src/channels/chat-sdk-bridge.ts`

Current: accepts optional `channelName` that overrides `adapter.name` as the `channelType`.

Change: remove the `channelName` parameter. The bridge always uses `adapter.name` as `channelType` (which will be `discord` for all three bots). Instead, set `botId` on the returned `ChannelAdapter` object.

The state adapter prefix (step 8) may still be needed — see that step.

### 6. Routing: Match on `bot_id`

**File:** `src/db/messaging-groups.ts`

Current lookups match on `(channel_type, platform_id)`:
- `getMessagingGroupByPlatform(channelType, platformId)` — line 34
- `getMessagingGroupWithAgentCount(channelType, platformId)` — line 53

Change: add optional `botId` parameter.

```
getMessagingGroupByPlatform(channelType, platformId, botId?)
  → WHERE channel_type = ? AND platform_id = ? AND (bot_id = ? OR (? IS NULL AND bot_id IS NULL))
```

Fallback behavior: if no row matches with the given `bot_id`, try again with `bot_id IS NULL`. This supports backwards compatibility for single-bot channels.

**File:** `src/router.ts`

`routeInbound()` calls `getMessagingGroupWithAgentCount(event.channelType, event.platformId)` at line 158. The event needs to carry `botId` so the router can pass it through. This comes from the Chat SDK bridge — each bridge instance knows its bot's ID.

Add `botId?: string` to the `InboundEvent` type in `src/channels/adapter.ts`. The Chat SDK bridge populates it from the adapter's `botId`.

### 7. Delivery: Resolve `bot_id` for Adapter Lookup

**File:** `src/index.ts` (delivery adapter bridge, lines 130-150)

Current: `getChannelAdapter(channelType)` — single key lookup.

Change: resolve `bot_id` from the messaging group, then look up with both.

```typescript
async deliver(channelType, platformId, threadId, kind, content, files) {
  // Resolve bot_id from the messaging group that owns this destination
  const mg = getMessagingGroupByPlatform(channelType, platformId);
  const botId = mg?.bot_id ?? undefined;
  const adapter = getChannelAdapter(channelType, botId);
  if (!adapter) { ... }
  return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
}
```

This avoids changing the outbound message schema or touching any container code. The host resolves `bot_id` at delivery time from the messaging group's `bot_id` column.

**Edge case:** the orchestrator's `writeOutboundDirect` in `orchestrator.ts` (line 141) writes `channelType: 'discord'` and `platformId: mg.platform_id`. Since there may be multiple messaging groups with `channel_type='discord'` and the same `platform_id` (one per bot), `getMessagingGroupByPlatform` needs to handle this. Two options:

- **Option A:** `getMessagingGroupByPlatform` returns the first match (the worker bot's row, since it's the one the orchestrator targets). The orchestrator writes test results to the worker's thread — delivery finds the worker bot's messaging group (with its `bot_id`) and delivers through the correct adapter. This works if we ensure the worker bot's messaging group is the one without a specific `bot_id` or is the first match.

- **Option B (preferred):** Add an optional `bot_id` to the `writeOutboundDirect` message shape. The orchestrator and handler can pass the target bot's ID explicitly. Delivery reads it from the message if present, falls back to messaging group lookup if not. This is more explicit and avoids ambiguity.

### 8. State Adapter: Simplify Prefix

**File:** `src/state-sqlite.ts`

Current: each bridge creates `new SqliteStateAdapter(channelType)` with a prefix like `discord-supervisor:`.

After migration, all three bots have `channel_type='discord'`. The prefix must still differentiate them to avoid thread lock collisions. Change the prefix source from `channelType` to `botId`:

```typescript
new SqliteStateAdapter(botId)  // e.g., prefix '123456789:'
```

This is a functionally equivalent change — we're just keying on bot ID instead of synthetic channel type. No migration of existing `chat_sdk_*` rows needed because the new prefixes will be different keys entirely, and old prefixed rows will simply never be looked up again (they'll sit inert).

### 9. PR Factory Handler: Use Real Channel Types

**File:** `src/modules/pr-factory/handler.ts`

Lines 145-149 create the supervisor's messaging group with `channel_type: 'discord-supervisor'`.

Change to:
```typescript
createMessagingGroup({
  id: svMgId,
  channel_type: 'discord',
  platform_id: platformId,
  bot_id: supervisorBotId,  // extracted from DISCORD_SUPERVISOR_BOT_TOKEN
  name: `PR #${pr.number} (supervisor)`,
  ...
});
```

The `supervisorBotId` needs to be available to the handler. Either:
- Import from the discord-bots module (which extracts it at registration time)
- Or read it from the adapter registry

Lines 115-116 create the worker's messaging group — add `bot_id: workerBotId`.

Lines 140-141 (orchestrator outbound writes with `channelType: 'discord'`) — add bot_id if using Option B from step 7.

### 10. Data Migration: Existing Messaging Groups

Migrate existing rows in `data/v2.db` from synthetic channel types to real types with `bot_id`.

```sql
-- Get bot IDs first (decode from tokens or check Discord dev portal)
-- Worker bot ID:     <WORKER_BOT_ID>
-- Supervisor bot ID: <SUPERVISOR_BOT_ID>
-- Tester bot ID:     <TESTER_BOT_ID>

-- Migrate supervisor messaging groups
UPDATE messaging_groups
   SET channel_type = 'discord',
       bot_id = '<SUPERVISOR_BOT_ID>'
 WHERE channel_type = 'discord-supervisor';

-- Migrate tester messaging groups (if any exist)
UPDATE messaging_groups
   SET channel_type = 'discord',
       bot_id = '<TESTER_BOT_ID>'
 WHERE channel_type = 'discord-tester';

-- Set bot_id on existing worker messaging groups
UPDATE messaging_groups
   SET bot_id = '<WORKER_BOT_ID>'
 WHERE channel_type = 'discord'
   AND bot_id IS NULL;
```

Also update any `messaging_group_agents`, `pending_questions`, `delivered`, or other tables that reference `channel_type` if they store the synthetic types. Check:

```sql
-- Audit: find all tables/columns that store channel_type values
SELECT * FROM pending_questions WHERE channel_type LIKE 'discord-%';
```

### 11. Session DB Outbound Messages

Existing `messages_out` rows in per-session `outbound.db` files contain `channel_type = 'discord-supervisor'` etc. These are already-delivered messages and won't be re-processed. No migration needed — they're historical.

New outbound messages from containers will have `channel_type = 'discord'` (the container's session knows its messaging group, which now has the real channel type). Delivery resolves `bot_id` from the messaging group at delivery time (step 7), so the container doesn't need to know about `bot_id` at all.

### 12. `createMessagingGroup()` — Accept `bot_id`

**File:** `src/db/messaging-groups.ts`

Update the INSERT statement (line 24) to include `bot_id`:

```sql
INSERT INTO messaging_groups (id, channel_type, platform_id, bot_id, name, is_group, unknown_sender_policy, created_at)
VALUES (@id, @channel_type, @platform_id, @bot_id, @name, @is_group, @unknown_sender_policy, @created_at)
```

Update `getMessagingGroupByPlatform` and `getMessagingGroupWithAgentCount` per step 6.

## Execution Order

1. Steps 1-2: utility + schema migration (foundation)
2. Steps 3, 5, 8: registry, bridge, state adapter (adapter layer)
3. Step 4: bot registration (uses new registry)
4. Steps 6, 12: routing + DB functions (uses new schema)
5. Step 7: delivery (uses new registry + DB functions)
6. Step 9: PR factory handler (uses everything above)
7. Step 10: data migration (run after all code changes, before starting service)
8. Build, start service, verify

## Verification

After starting the service:

1. Check logs for all three Discord bots connecting successfully
2. Verify `data/v2.db` messaging_groups all have `channel_type='discord'` with distinct `bot_id` values
3. Create a test PR to trigger the webhook — verify:
   - Worker bot creates thread and posts triage
   - Supervisor messaging group created with correct `bot_id`
   - @Supervisor mention in thread routes correctly
4. Check that existing PR threads still deliver messages through the correct bot

## Rollback

If something breaks:
1. Stop service
2. Restore `data/v2.db` from backup
3. `git checkout .` to revert source changes
4. Start service — back to synthetic channel types

---

## Implementation Log (2026-04-28)

All code changes from steps 1–9 and 12 are complete. Build passes, all 197 tests pass.

### New Files

| File | Purpose |
|------|---------|
| `src/utils/discord-bot-id.ts` | `botIdFromToken(token)` — extracts Discord bot user ID from a bot token (base64 decode of first dot-segment) |
| `src/db/migrations/014-bot-id.ts` | Adds `bot_id` column to `messaging_groups`, recreates table with `UNIQUE(channel_type, platform_id, bot_id)` + partial unique index for NULL `bot_id` (preserves old single-bot uniqueness) |

### Core Changes

| File | What Changed |
|------|-------------|
| `src/types.ts` | Added `bot_id?: string \| null` to `MessagingGroup` interface |
| `src/channels/adapter.ts` | Added `botId?: string` to `ChannelAdapter` and `InboundEvent` interfaces |
| `src/channels/channel-registry.ts` | Adapters keyed by `channelType:botId` composite; `getChannelAdapter(type, botId?)` does two-tier lookup (exact → fallback to type-only) |
| `src/channels/chat-sdk-bridge.ts` | Replaced `channelName` config with `botId`; state adapter prefixed by `botId` for per-bot isolation; bridge sets `botId` on returned adapter |
| `src/channels/discord.ts` | Extracts `botId` from `DISCORD_BOT_TOKEN` via `botIdFromToken()` and passes to bridge |
| `src/db/messaging-groups.ts` | `createMessagingGroup` includes `bot_id` in INSERT; `getMessagingGroupByPlatform` and `getMessagingGroupWithAgentCount` accept optional `botId` with fallback to `bot_id IS NULL` |
| `src/router.ts` | Passes `event.botId` to MG lookup; auto-created messaging groups get `bot_id` from event |
| `src/index.ts` | Sets `botId: adapter.botId` on inbound events; delivery adapter accepts and forwards `botId` |
| `src/delivery.ts` | Resolves `botId` from session's messaging group via `getMessagingGroup(session.messaging_group_id)`; passes to adapter lookup and permission check |
| `src/db/migrations/index.ts` | Registered `migration014` |

### PR Factory Changes

| File | What Changed |
|------|-------------|
| `src/modules/pr-factory/discord-bots.ts` | Registers supervisor/tester bots as `channel_type='discord'` with `botId` (no more synthetic channel types); exports `getBotId(role)` for other modules; also resolves worker bot ID at startup |
| `src/modules/pr-factory/handler.ts` | Creates worker and supervisor messaging groups with `bot_id` via `getBotId('worker')` / `getBotId('supervisor')` |
| `src/modules/pr-factory/supervisor.ts` | Creates supervisor MG with `channel_type='discord'` + `bot_id` instead of `channel_type='discord-supervisor'` |

### Remaining: Step 10 (Data Migration)

Existing rows in `data/v2.db` still have synthetic `channel_type` values. Before starting the service, run the data migration SQL with actual bot IDs decoded from tokens (or looked up in the Discord dev portal). See step 10 above.
