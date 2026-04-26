/**
 * Step: migrate-db
 *
 * Seed v2.db with the essentials derived from v1's `registered_groups`:
 *   - agent_groups: one per v1 folder the user selected
 *   - messaging_groups: one per distinct (channel_type, platform_id) pair
 *   - messaging_group_agents: the wiring between them, with engage fields
 *     backfilled from v1's trigger_pattern / requires_trigger
 *
 * Does NOT seed users, user_roles, or agent_group_members. v1 has no ground
 * truth for them — the /migrate-from-v1 skill interviews the user for the
 * owner and seeds those tables.
 *
 * Idempotent: re-running skips any (folder) agent_group, (channel, platform_id)
 * messaging_group, and (mg, ag) wiring that already exist. Safe to re-run
 * after a partial failure.
 *
 * Expects `--selection <mode>` where mode is 'all' | 'wired-only'. The
 * orchestrator asks the user via clack and passes the result.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { initDb } from '../../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { log } from '../../src/log.js';
import { emitStatus } from '../status.js';
import {
  fetchBotGuilds,
  generateId,
  inferChannelType,
  readHandoff,
  recordStep,
  triggerToEngage,
  v1PathsFor,
  v2PlatformId,
  writeHandoff,
} from './shared.js';

interface V1Group {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  channel_name: string | null;
}

interface DbArgs {
  selection: 'all' | 'wired-only';
}

function parseArgs(args: string[]): DbArgs {
  let selection: 'all' | 'wired-only' = 'wired-only';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--selection') {
      const v = args[++i];
      if (v === 'all' || v === 'wired-only') selection = v;
    }
  }
  return { selection };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const h = readHandoff();

  if (!h.v1_path) {
    recordStep('migrate-db', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_DB', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  const validate = h.steps['migrate-validate'];
  if (validate && validate.status === 'failed') {
    recordStep('migrate-db', {
      status: 'skipped',
      fields: { REASON: 'validate-failed' },
      notes: ['DB shape did not validate; skipping DB migration.'],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_DB', { STATUS: 'skipped', REASON: 'validate_failed' });
    return;
  }

  const paths = v1PathsFor(h.v1_path);
  let v1Db: Database.Database;
  try {
    v1Db = new Database(paths.db, { readonly: true, fileMustExist: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordStep('migrate-db', {
      status: 'failed',
      fields: { REASON: 'v1-db-open-failed' },
      notes: [message],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_DB', { STATUS: 'failed', REASON: 'v1_db_open_failed', ERROR: message });
    return;
  }

  const v1Groups = v1Db
    .prepare(
      'SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main, channel_name FROM registered_groups',
    )
    .all() as V1Group[];
  v1Db.close();

  // Filter by selection mode. "wired-only" keeps rows where we can confidently
  // say which channel they belong to — either `channel_name` is set, or the
  // JID prefix resolves to a known channel type.
  const selected: V1Group[] = [];
  const detectedChannels = new Map<string, { source: 'channel_name' | 'jid_prefix'; count: number }>();

  for (const g of v1Groups) {
    const channelType = inferChannelType(g.jid, g.channel_name);
    const source: 'channel_name' | 'jid_prefix' = g.channel_name?.trim() ? 'channel_name' : 'jid_prefix';
    if (!channelType) {
      // Can't infer — skip in both modes; the skill raises it with the user.
      continue;
    }
    if (parsed.selection === 'wired-only' && source === 'jid_prefix' && !channelType) {
      continue;
    }
    selected.push(g);
    const entry = detectedChannels.get(channelType) ?? { source, count: 0 };
    entry.count += 1;
    // Prefer explicit channel_name as the source if any row had it.
    if (source === 'channel_name') entry.source = 'channel_name';
    detectedChannels.set(channelType, entry);
  }

  h.group_selection = {
    mode: parsed.selection,
    selected_folders: selected.map((g) => g.folder),
    total_v1_groups: v1Groups.length,
    wired_v1_groups: selected.length,
  };
  h.detected_channels = [...detectedChannels.entries()].map(([channel_type, info]) => ({
    channel_type,
    source: info.source,
    group_count: info.count,
  }));
  writeHandoff(h);

  // For channels where v2's platform_id includes a component v1 didn't record
  // (Discord's guild id), fetch the bot's guilds up-front. If the bot is in
  // a single guild we can splice that id into every platform_id; otherwise
  // fall back to the v1-format id (v2's channel-registration flow will repair
  // on first message). Done ONCE per channel_type, not per-row, so this is
  // cheap regardless of group count.
  const v1EnvText = fs.existsSync(paths.env) ? fs.readFileSync(paths.env, 'utf-8') : '';
  const v1EnvMap = new Map<string, string>();
  for (const line of v1EnvText.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    v1EnvMap.set(t.slice(0, eq).trim(), t.slice(eq + 1));
  }
  const singleGuildByChannel = new Map<string, string>();
  for (const channelType of detectedChannels.keys()) {
    const info = await fetchBotGuilds(channelType, (k) => v1EnvMap.get(k));
    if (info && info.guildIds.length === 1) {
      singleGuildByChannel.set(channelType, info.guildIds[0]);
    }
  }

  // Initialize v2.db (creates schema if not present — runMigrations is no-op
  // when the schema is already current, so this is safe on a live v2 install).
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const v2Path = path.join(DATA_DIR, 'v2.db');
  const v2Db = initDb(v2Path);
  runMigrations(v2Db);

  let agentGroupsCreated = 0;
  let agentGroupsReused = 0;
  let messagingGroupsCreated = 0;
  let messagingGroupsReused = 0;
  let wiringsCreated = 0;
  let wiringsReused = 0;
  let skipped = 0;
  const followups: string[] = [];

  for (const g of selected) {
    const channelType = inferChannelType(g.jid, g.channel_name);
    if (!channelType) {
      skipped += 1;
      continue;
    }

    const guildId = singleGuildByChannel.get(channelType);
    const platformId = v2PlatformId(channelType, g.jid, { guildId });
    const createdAt = new Date().toISOString();

    try {
      // agent_group — one per folder
      let ag = getAgentGroupByFolder(g.folder);
      if (!ag) {
        createAgentGroup({
          id: generateId('ag'),
          name: g.name || g.folder,
          folder: g.folder,
          agent_provider: null,
          created_at: createdAt,
        });
        ag = getAgentGroupByFolder(g.folder)!;
        agentGroupsCreated += 1;
      } else {
        agentGroupsReused += 1;
      }

      // messaging_group — one per (channel_type, platform_id)
      let mg = getMessagingGroupByPlatform(channelType, platformId);
      if (!mg) {
        createMessagingGroup({
          id: generateId('mg'),
          channel_type: channelType,
          platform_id: platformId,
          name: g.name || null,
          is_group: 1, // v1 didn't distinguish; default to group (safe for routing)
          unknown_sender_policy: 'strict', // skill's interview flips this if v1 was "public"
          created_at: createdAt,
        });
        mg = getMessagingGroupByPlatform(channelType, platformId)!;
        messagingGroupsCreated += 1;
      } else {
        messagingGroupsReused += 1;
      }

      // messaging_group_agents — wire them if not already wired
      const existingWiring = getMessagingGroupAgentByPair(mg.id, ag.id);
      if (!existingWiring) {
        const engage = triggerToEngage({
          trigger_pattern: g.trigger_pattern,
          requires_trigger: g.requires_trigger,
        });
        createMessagingGroupAgent({
          id: generateId('mga'),
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: engage.engage_mode,
          engage_pattern: engage.engage_pattern,
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: createdAt,
        });
        wiringsCreated += 1;
      } else {
        wiringsReused += 1;
      }

      if (g.is_main === 1) {
        followups.push(
          `Folder "${g.folder}" was the v1 main group (is_main=1). v2 has no is_main flag — the /migrate-from-v1 skill should grant this folder's channel to the owner user when it runs.`,
        );
      }
    } catch (err) {
      skipped += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to seed v1 group', { folder: g.folder, err: message });
      followups.push(`Folder "${g.folder}" failed to seed: ${message}`);
    }
  }

  v2Db.close();

  const partial = skipped > 0;
  const handoffAfter = readHandoff();
  handoffAfter.followups = [...new Set([...handoffAfter.followups, ...followups])];
  writeHandoff(handoffAfter);

  recordStep('migrate-db', {
    status: partial ? 'partial' : 'success',
    fields: {
      SELECTION: parsed.selection,
      V1_GROUPS_TOTAL: v1Groups.length,
      SELECTED: selected.length,
      AGENT_GROUPS_CREATED: agentGroupsCreated,
      AGENT_GROUPS_REUSED: agentGroupsReused,
      MESSAGING_GROUPS_CREATED: messagingGroupsCreated,
      MESSAGING_GROUPS_REUSED: messagingGroupsReused,
      WIRINGS_CREATED: wiringsCreated,
      WIRINGS_REUSED: wiringsReused,
      SKIPPED: skipped,
      CHANNELS: [...detectedChannels.keys()].join(','),
    },
    notes: followups,
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_DB', {
    STATUS: partial ? 'partial' : 'success',
    SELECTION: parsed.selection,
    V1_GROUPS_TOTAL: String(v1Groups.length),
    SELECTED: String(selected.length),
    AGENT_GROUPS_CREATED: String(agentGroupsCreated),
    MESSAGING_GROUPS_CREATED: String(messagingGroupsCreated),
    WIRINGS_CREATED: String(wiringsCreated),
    SKIPPED: String(skipped),
    CHANNELS: [...detectedChannels.keys()].join(',') || 'none',
  });
}
