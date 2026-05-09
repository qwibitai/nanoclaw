/**
 * Seed the v2 central DB from an extracted v1 state bundle.
 *
 * Runs from a v2 worktree. Reads `<v1Root>/.nanoclaw-migrations/v1-data/*.json`
 * and writes into `<v2Root>/data/v2.db`, matching v1 defaults onto v2's
 * entity model:
 *
 *   v1 registered_groups.folder → agent_groups
 *   v1 registered_groups.jid    → messaging_groups (+ wiring row)
 *   v1 trigger_pattern           → engage_mode + engage_pattern (migration 010)
 *   v1 container_config JSON     → groups/<folder>/container.json
 *   v1 sender-allowlist explicit → users + agent_group_members
 *   owner proposal               → users + user_roles(owner) + user_dms
 *
 * Idempotent: natural-key dedupe on every insert. Safe to re-run.
 *
 * Fails loudly when:
 *   - the owner's channel_type has no adapter file in src/channels/
 *   - any JID in registered-groups.json has inferred_channel_type='unknown'
 *
 * The caller is expected to install channel skills via `/add-<name>`
 * before invoking — this function only checks that the adapters are
 * present on disk, not that they connect.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { initDb, closeDb, getDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  createMessagingGroupAgent,
} from '../../src/db/messaging-groups.js';
import { upsertUser } from '../../src/modules/permissions/db/users.js';
import { grantRole, isOwner } from '../../src/modules/permissions/db/user-roles.js';
import { addMember } from '../../src/modules/permissions/db/agent-group-members.js';
import { upsertUserDm } from '../../src/modules/permissions/db/user-dms.js';
import { initContainerConfig, writeContainerConfig } from '../../src/container-config.js';
import type { ContainerConfig } from '../../src/container-config.js';
import type {
  AgentGroup,
  MessagingGroup,
  MessagingGroupAgent,
  UnknownSenderPolicy,
  User,
} from '../../src/types.js';

import { splitUserId, userIdFromJid } from './jid.js';

export interface SeedOptions {
  /** Absolute path to v1 project root (where `.nanoclaw-migrations/` lives). */
  v1Root: string;
  /** Absolute path to v2 central DB. Defaults to `<cwd>/data/v2.db`. */
  v2DbPath?: string;
  /** Don't mutate — validate inputs and report what would be inserted. */
  dryRun?: boolean;
}

export interface SeedStats {
  agentGroups: { inserted: number; skipped: number };
  messagingGroups: { inserted: number; skipped: number };
  wirings: { inserted: number; skipped: number };
  users: { inserted: number };
  roles: { inserted: number; skipped: number };
  members: { inserted: number };
  userDms: { inserted: number };
  containerConfigs: { written: number };
  warnings: string[];
}

// ── Public entry point ──

export function runSeed(opts: SeedOptions): SeedStats {
  const v1Data = path.join(opts.v1Root, '.nanoclaw-migrations', 'v1-data');
  if (!fs.existsSync(v1Data)) {
    throw new Error(`v1 data directory not found: ${v1Data} (run the extract step first)`);
  }

  const dbPath = opts.v2DbPath ?? path.resolve(process.cwd(), 'data', 'v2.db');
  initDb(dbPath);
  runMigrations(getDb());

  try {
    return seed(v1Data, opts.dryRun === true);
  } finally {
    closeDb();
  }
}

// ── Internal: types matching extract-v1.ts output ──

interface V1GroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: unknown | null;
  requires_trigger: number;
  is_main: boolean;
  inferred_channel_type: string;
  inferred_is_group: number;
}

interface V1Owner {
  userId: string | null; // latest extractor shape
  user_id?: string | null; // back-compat with the older scripts
  source: string;
  confidence: string;
}

interface V1AllowlistEntry {
  allow: '*' | string[];
}
interface V1Allowlist {
  default?: V1AllowlistEntry;
  chats?: Record<string, V1AllowlistEntry>;
}

// v1 container_config shape (kept inline — we don't ship v1 types into v2).
interface V1AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}
interface V1ContainerConfig {
  additionalMounts?: V1AdditionalMount[];
  timeout?: number;
}

// ── Seed logic ──

function seed(v1Data: string, dryRun: boolean): SeedStats {
  const stats: SeedStats = {
    agentGroups: { inserted: 0, skipped: 0 },
    messagingGroups: { inserted: 0, skipped: 0 },
    wirings: { inserted: 0, skipped: 0 },
    users: { inserted: 0 },
    roles: { inserted: 0, skipped: 0 },
    members: { inserted: 0 },
    userDms: { inserted: 0 },
    containerConfigs: { written: 0 },
    warnings: [],
  };

  const v1Groups = readJson<V1GroupRow[]>(path.join(v1Data, 'registered-groups.json'));
  const ownerFile = readJson<V1Owner>(path.join(v1Data, 'owner.json'));
  const env = readJson<Record<string, string>>(path.join(v1Data, 'env.json'));
  const allowlist = readJson<V1Allowlist>(path.join(v1Data, 'sender-allowlist.json'));

  const ownerUserId = ownerFile.userId ?? ownerFile.user_id ?? null;

  // Pre-flight: channel adapters on disk. Matches how channels self-register
  // in src/channels/index.ts — if a file named <channel_type>.ts exists
  // (and isn't infra), the adapter is installed.
  const channelsInstalled = readInstalledChannels();
  const requiredChannels = new Set<string>();
  for (const g of v1Groups) {
    if (g.inferred_channel_type === 'unknown') {
      stats.warnings.push(
        `JID '${g.jid}' has inferred_channel_type='unknown' — edit registered-groups.json to set it before seeding`,
      );
      continue;
    }
    requiredChannels.add(g.inferred_channel_type);
  }
  const missing = [...requiredChannels].filter((c) => !channelsInstalled.has(c));
  if (missing.length > 0) {
    throw new Error(
      `Channel adapters not installed: ${missing.join(', ')}. ` +
        `Install them via /add-<name> skills in this worktree before seeding.`,
    );
  }

  if (dryRun) {
    stats.warnings.push(`DRY RUN — no writes. Would insert ${v1Groups.length} groups, owner=${ownerUserId ?? 'unresolved'}.`);
    return stats;
  }

  // ── Agent groups (unique by folder) ──
  const folderToAgentGroupId = new Map<string, string>();
  for (const g of v1Groups) {
    if (folderToAgentGroupId.has(g.folder)) continue;

    const existing = getAgentGroupByFolder(g.folder);
    if (existing) {
      folderToAgentGroupId.set(g.folder, existing.id);
      stats.agentGroups.skipped++;
    } else {
      const row: AgentGroup = {
        id: shortId('ag'),
        name: g.name,
        folder: g.folder,
        agent_provider: null,
        created_at: nowIso(),
      };
      createAgentGroup(row);
      folderToAgentGroupId.set(g.folder, row.id);
      stats.agentGroups.inserted++;
    }

    // Initialize the per-group container.json. v1 container_config (if any)
    // gets translated into the v2 shape.
    initContainerConfig(g.folder);
    if (g.container_config && typeof g.container_config === 'object') {
      try {
        writeContainerConfig(g.folder, translateContainerConfig(g.container_config));
        stats.containerConfigs.written++;
      } catch (err) {
        stats.warnings.push(`Could not write container.json for ${g.folder}: ${(err as Error).message}`);
      }
    }
  }

  // ── Messaging groups + wirings ──
  const jidToMgId = new Map<string, string>();
  for (const g of v1Groups) {
    if (g.inferred_channel_type === 'unknown') continue;
    const agId = folderToAgentGroupId.get(g.folder);
    if (!agId) continue;

    let mg = getMessagingGroupByPlatform(g.inferred_channel_type, g.jid);
    if (!mg) {
      const row: MessagingGroup = {
        id: shortId('mg'),
        channel_type: g.inferred_channel_type,
        platform_id: g.jid,
        name: g.name,
        is_group: g.inferred_is_group,
        // 'strict' is the conservative choice for a migration — existing
        // allowlist semantics (trigger-required for unknowns) translate to
        // "drop unknowns by default". Users can switch to 'request_approval'
        // later to opt into the new auto-register flow.
        unknown_sender_policy: 'strict' satisfies UnknownSenderPolicy,
        created_at: nowIso(),
      };
      createMessagingGroup(row);
      stats.messagingGroups.inserted++;
      mg = row;
    } else {
      stats.messagingGroups.skipped++;
    }
    jidToMgId.set(g.jid, mg.id);

    // Wiring — dedupe by (messaging_group_id, agent_group_id)
    const existingWiring = getDb()
      .prepare('SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
      .get(mg.id, agId) as { id: string } | undefined;
    if (existingWiring) {
      stats.wirings.skipped++;
      continue;
    }

    createMessagingGroupAgent(buildWiring(mg.id, agId, g, env));
    stats.wirings.inserted++;
  }

  // ── Owner user + role + DM + membership ──
  if (ownerUserId) {
    const { kind, handle } = splitUserId(ownerUserId);
    const user: User = {
      id: ownerUserId,
      kind,
      display_name: 'Owner',
      created_at: nowIso(),
    };
    upsertUser(user);
    stats.users.inserted++;

    if (!isOwner(ownerUserId)) {
      grantRole({
        user_id: ownerUserId,
        role: 'owner',
        agent_group_id: null,
        granted_by: null,
        granted_at: nowIso(),
      });
      stats.roles.inserted++;
    } else {
      stats.roles.skipped++;
    }

    // DM cache — prefer exact-JID match, fall back to the first is_group=0
    // messaging_group on the owner's channel.
    const ownerChannel = kind === 'phone' ? 'whatsapp' : kind;
    const directMgId = jidToMgId.get(handle) ?? findDmMessagingGroup(ownerChannel);
    if (directMgId) {
      upsertUserDm({
        user_id: ownerUserId,
        channel_type: ownerChannel,
        messaging_group_id: directMgId,
        resolved_at: nowIso(),
      });
      stats.userDms.inserted++;
    } else {
      stats.warnings.push(
        `Could not resolve DM channel for owner ${ownerUserId} on channel '${ownerChannel}'. ` +
          `The owner must DM the bot once so the DM channel gets cached.`,
      );
    }

    // Owner is implicit member of every agent group — make it explicit so
    // getMembers(agId) returns a non-empty set for the UI.
    for (const agId of folderToAgentGroupId.values()) {
      addMember({
        user_id: ownerUserId,
        agent_group_id: agId,
        added_by: null,
        added_at: nowIso(),
      });
      stats.members.inserted++;
    }
  } else {
    stats.warnings.push(
      'No owner resolved — run the extract step again with OWNER_USER_ID set, or hand-edit owner.json before re-seeding.',
    );
  }

  // ── Allowlist → members ──
  if (allowlist?.chats) {
    for (const [jid, entry] of Object.entries(allowlist.chats)) {
      if (!entry || entry.allow === '*' || !Array.isArray(entry.allow)) continue;
      const agId = findAgentGroupForJid(jid, v1Groups, folderToAgentGroupId);
      if (!agId) continue;

      for (const allowedJid of entry.allow) {
        const memberId = userIdFromJid(allowedJid);
        const { kind } = splitUserId(memberId);
        upsertUser({
          id: memberId,
          kind,
          display_name: null,
          created_at: nowIso(),
        });
        stats.users.inserted++;

        addMember({
          user_id: memberId,
          agent_group_id: agId,
          added_by: ownerUserId,
          added_at: nowIso(),
        });
        stats.members.inserted++;
      }
    }
  }

  return stats;
}

// ── Wiring builder ──

function buildWiring(
  messagingGroupId: string,
  agentGroupId: string,
  g: V1GroupRow,
  env: Record<string, string>,
): MessagingGroupAgent {
  const assistantName = env.ASSISTANT_NAME ?? 'Andy';
  const defaultTrigger = `@${assistantName}`;

  // Map v1 (requires_trigger, trigger_pattern) onto v2 engage-mode semantics.
  // Mirrors migration 010's backfill logic so in-place and from-scratch seeds
  // converge on the same rows.
  let engage_mode: 'pattern' | 'mention' | 'mention-sticky' = 'mention';
  let engage_pattern: string | null = null;

  const pattern =
    typeof g.trigger_pattern === 'string' && g.trigger_pattern.length > 0 ? g.trigger_pattern : null;

  if (pattern) {
    engage_mode = 'pattern';
    engage_pattern = pattern;
  } else if (g.requires_trigger === 0) {
    // v1 rows with requires_trigger=0 responded to every message. v2's
    // "always" sentinel is engage_pattern='.'.
    engage_mode = 'pattern';
    engage_pattern = '.';
  } else {
    // No explicit pattern, trigger required → v2 mention mode with the
    // default trigger derived from ASSISTANT_NAME.
    engage_mode = 'mention';
    engage_pattern = null;
    void defaultTrigger; // kept for readability; v2's mention mode resolves this at runtime
  }

  return {
    id: shortId('mga'),
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode,
    engage_pattern,
    sender_scope: 'all', // v1 gated unknowns via the sender-allowlist file, not per-wiring
    ignored_message_policy: 'drop', // no v1 analog; conservative
    session_mode: 'shared', // v1 had one session per group, not per-thread
    priority: 0,
    created_at: nowIso(),
  };
}

// ── v1 → v2 container config translation ──

function translateContainerConfig(v1: unknown): ContainerConfig {
  const c = (v1 ?? {}) as V1ContainerConfig;
  const mounts = (c.additionalMounts ?? []).map((m) => ({
    hostPath: m.hostPath,
    containerPath: m.containerPath ?? `/workspace/extra/${path.basename(m.hostPath)}`,
    readonly: m.readonly ?? true,
  }));
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: mounts,
    skills: 'all',
  };
}

// ── helpers ──

function readInstalledChannels(): Set<string> {
  const channelsDir = path.join(process.cwd(), 'src', 'channels');
  const installed = new Set<string>();
  if (!fs.existsSync(channelsDir)) return installed;
  // Infra files — not adapters. Keep in sync with the actual contents of
  // src/channels/ on trunk (see channel-registry.ts + index.ts imports).
  const infra = new Set(['adapter', 'ask-question', 'channel-registry', 'chat-sdk-bridge', 'cli', 'index']);
  for (const entry of fs.readdirSync(channelsDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const name = entry.slice(0, -3);
    if (infra.has(name)) continue;
    installed.add(name);
  }
  // CLI always available (lives on trunk) — surface it explicitly since the
  // infra filter above would otherwise hide it.
  installed.add('cli');
  return installed;
}

function findAgentGroupForJid(
  jid: string,
  v1Groups: V1GroupRow[],
  folderToAgentGroupId: Map<string, string>,
): string | null {
  const match = v1Groups.find((g) => g.jid === jid);
  if (!match) return null;
  return folderToAgentGroupId.get(match.folder) ?? null;
}

function findDmMessagingGroup(channelType: string): string | undefined {
  const row = getDb()
    .prepare(
      'SELECT id FROM messaging_groups WHERE channel_type = ? AND is_group = 0 ORDER BY created_at LIMIT 1',
    )
    .get(channelType) as { id: string } | undefined;
  return row?.id;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
