/**
 * Shared types, constants, and helpers for the v1 → v2 migration.
 *
 * The migration is a sequence of small steps registered in setup/index.ts
 * (migrate-detect, migrate-validate, migrate-db, …). Every step:
 *   - Reads state it needs from `logs/setup-migration/handoff.json`
 *   - Writes its own outcome back to that handoff file
 *   - Emits exactly one `=== NANOCLAW SETUP: MIGRATE_<X> ===` block on stdout
 *
 * No step aborts the chain on failure — the orchestrator in setup/migrate-v1.ts
 * reads the handoff after each step to decide whether to continue, skip, or
 * hand off to the Claude `/migrate-from-v1` skill.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Paths ──────────────────────────────────────────────────────────────

export const MIGRATION_DIR = path.join('logs', 'setup-migration');
export const HANDOFF_PATH = path.join(MIGRATION_DIR, 'handoff.json');
export const SCHEMA_MISMATCH_PATH = path.join(MIGRATION_DIR, 'schema-mismatch.json');
export const INACTIVE_TASKS_PATH = path.join(MIGRATION_DIR, 'inactive-tasks.json');

// ── V1 install discovery ───────────────────────────────────────────────

/**
 * Default candidate paths to scan for a v1 install. Combines:
 *   - `$NANOCLAW_V1_PATH` (explicit override, takes priority)
 *   - Sibling directories of the v2 checkout whose name contains "nanoclaw"
 *     or "clawdbot" (most common layout — v1 lives next to v2)
 *   - Common checkout locations under $HOME
 *   - Common XDG-style state dirs (.nanoclaw, .clawdbot — v1's predecessor)
 *
 * Kept generic — don't bake specific usernames in. Deduped so a path that
 * satisfies multiple rules only appears once.
 */
export function defaultV1Candidates(): string[] {
  const home = os.homedir();
  const cwd = process.cwd();
  const cwdParent = path.dirname(cwd);

  const siblings: string[] = [];
  try {
    if (fs.existsSync(cwdParent)) {
      for (const entry of fs.readdirSync(cwdParent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const lower = entry.name.toLowerCase();
        // Match anything claw-ish next to v2: "nanoclaw", "nanoclaw-v1",
        // "clawdbot", user's fork name like "nanoclaw-prod". Excludes the
        // v2 checkout we're running from so we don't self-match.
        if (!lower.includes('claw')) continue;
        const full = path.join(cwdParent, entry.name);
        if (path.resolve(full) === path.resolve(cwd)) continue;
        siblings.push(full);
      }
    }
  } catch {
    // Can't list parent — fall through to the fixed list.
  }

  const fixed = [
    path.join(home, 'nanoclaw'),
    path.join(home, '.nanoclaw'),
    path.join(home, 'clawdbot'),
    path.join(home, '.clawdbot'),
    path.join(home, 'Code', 'nanoclaw'),
    path.join(home, 'code', 'nanoclaw'),
    path.join(home, 'projects', 'nanoclaw'),
    path.join(home, 'Projects', 'nanoclaw'),
    path.join(home, 'src', 'nanoclaw'),
    path.join(home, 'dev', 'nanoclaw'),
    path.join(home, 'workspace', 'nanoclaw'),
    path.join(home, 'Documents', 'nanoclaw'),
    path.join(home, 'GitHub', 'nanoclaw'),
    path.join(home, 'github', 'nanoclaw'),
    path.join(home, 'repos', 'nanoclaw'),
  ];

  // NANOCLAW_V1_PATH is handled authoritatively by detect.ts — if it's set,
  // detect doesn't call this function at all. So we only build the
  // auto-discovery list here.
  const all = [...siblings, ...fixed];

  // Dedupe by resolved path. A sibling "nanoclaw" and a fixed "$HOME/nanoclaw"
  // often resolve to the same thing on single-user machines.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of all) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(p);
  }
  return out;
}

export interface V1Paths {
  root: string;
  db: string;
  env: string;
  groups: string;
  packageJson: string;
}

/**
 * Build the expected v1 file layout relative to a root. All paths are returned
 * even if they don't exist — callers check existence on the ones they care about.
 */
export function v1PathsFor(root: string): V1Paths {
  return {
    root,
    db: path.join(root, 'store', 'messages.db'),
    env: path.join(root, '.env'),
    groups: path.join(root, 'groups'),
    packageJson: path.join(root, 'package.json'),
  };
}

/**
 * Quick "does this path look like a v1 install?" check — used by detect.
 *
 * Strategy: the strongest signal is `store/messages.db`, so that's required.
 * The package.json check is a weaker corroboration — forks may rename
 * `"name"` or strip it, so we allow:
 *   - `name` missing or non-string
 *   - `name` containing "nanoclaw" or "clawdbot" (case-insensitive)
 * We reject only if `name` looks like a completely unrelated project, OR
 * the version is 2.x (the v2 rewrite itself).
 *
 * This keeps stock + forked v1 installs detectable while filtering out
 * unrelated repos that happen to have a `store/messages.db`.
 */
export function looksLikeV1Install(root: string): { ok: boolean; reason?: string } {
  if (!fs.existsSync(root)) return { ok: false, reason: 'root_missing' };
  const { db, packageJson } = v1PathsFor(root);
  if (!fs.existsSync(db)) return { ok: false, reason: 'db_missing' };

  // package.json is optional — a user may have stripped it, or be running
  // from a state-only dir (.nanoclaw). The DB shape is checked separately
  // by migrate-validate, which is authoritative for "is this schema v1?"
  if (!fs.existsSync(packageJson)) return { ok: true };

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf-8')) as { name?: string; version?: string };
    const name = (pkg.name ?? '').toLowerCase();
    if (pkg.version && /^2\./.test(pkg.version)) return { ok: false, reason: 'already_v2' };
    if (name && !name.includes('nanoclaw') && !name.includes('clawdbot')) {
      return { ok: false, reason: 'unrelated_project' };
    }
  } catch {
    // Broken package.json doesn't rule out v1 — DB presence is enough.
    return { ok: true };
  }
  return { ok: true };
}

// ── Handoff state (single source of truth across sub-steps) ────────────

/**
 * Rich state shared between migration sub-steps. Each step reads the whole
 * file, merges its section, and writes it back. Never hand-edit — it's
 * consumed by the `/migrate-from-v1` skill too.
 *
 * All paths stored are ABSOLUTE, so subsequent steps don't need to guess
 * about cwd. Relative paths would be a footgun once the skill reads this
 * file later from a different cwd.
 */
export interface Handoff {
  version: 1;
  started_at: string;
  v1_path: string | null;
  v1_version: string | null;

  /** Overall status once migrate-handoff finalizes the run. */
  overall_status: 'pending' | 'success' | 'partial' | 'failed' | 'skipped';

  steps: Partial<Record<MigrateStep, StepOutcome>>;

  /** Group folders the user chose to bring over (migrate-db populates). */
  group_selection: {
    mode: 'all' | 'wired-only' | 'cancelled' | null;
    selected_folders: string[];
    total_v1_groups: number;
    wired_v1_groups: number;
  };

  /** Distinct channels inferred from v1 registered_groups. */
  detected_channels: Array<{
    channel_type: string;
    source: 'channel_name' | 'jid_prefix';
    group_count: number;
  }>;

  /** Per-channel auth copy results (migrate-channel-auth populates). */
  channel_auth: Array<{
    channel_type: string;
    env_keys_copied: string[];
    files_copied: string[];
    files_missing: string[];
    notes: string;
  }>;

  /** Result of each `setup/install-<channel>.sh` invocation. */
  channels_installed: Array<{
    channel_type: string;
    status: 'success' | 'failed' | 'skipped' | 'not_supported';
    error?: string;
  }>;

  /** Scheduled-task migration results (migrate-tasks populates). */
  tasks: {
    v1_active: number;
    v1_inactive: number;
    migrated: number;
    failed: number;
    skipped: number;
  };

  /** Things the skill must finish manually. Always safe to append to. */
  followups: string[];
}

export type MigrateStep =
  | 'migrate-detect'
  | 'migrate-validate'
  | 'migrate-db'
  | 'migrate-groups'
  | 'migrate-env'
  | 'migrate-channel-auth'
  | 'migrate-channels'
  | 'migrate-tasks'
  | 'migrate-handoff';

export interface StepOutcome {
  status: 'success' | 'partial' | 'failed' | 'skipped';
  fields: Record<string, string | number | boolean>;
  notes: string[];
  at: string;
}

function emptyHandoff(): Handoff {
  return {
    version: 1,
    started_at: new Date().toISOString(),
    v1_path: null,
    v1_version: null,
    overall_status: 'pending',
    steps: {},
    group_selection: {
      mode: null,
      selected_folders: [],
      total_v1_groups: 0,
      wired_v1_groups: 0,
    },
    detected_channels: [],
    channel_auth: [],
    channels_installed: [],
    tasks: { v1_active: 0, v1_inactive: 0, migrated: 0, failed: 0, skipped: 0 },
    followups: [],
  };
}

/** Read the handoff, creating an empty one if it doesn't exist yet. */
export function readHandoff(): Handoff {
  fs.mkdirSync(MIGRATION_DIR, { recursive: true });
  if (!fs.existsSync(HANDOFF_PATH)) return emptyHandoff();
  try {
    const parsed = JSON.parse(fs.readFileSync(HANDOFF_PATH, 'utf-8')) as Handoff;
    if (parsed.version !== 1) throw new Error(`unsupported handoff version ${parsed.version}`);
    return parsed;
  } catch {
    // Broken handoff shouldn't wedge the migration — start fresh and let the
    // step that called us re-record its outcome.
    return emptyHandoff();
  }
}

/** Persist a handoff mutation atomically (write-tmp + rename). */
export function writeHandoff(h: Handoff): void {
  fs.mkdirSync(MIGRATION_DIR, { recursive: true });
  const tmp = HANDOFF_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
  fs.renameSync(tmp, HANDOFF_PATH);
}

/** Convenience: merge a step outcome into the handoff and persist. */
export function recordStep(step: MigrateStep, outcome: StepOutcome): void {
  const h = readHandoff();
  h.steps[step] = outcome;
  writeHandoff(h);
}

// ── JID parsing + channel inference ────────────────────────────────────

/**
 * v1 stored chat identifiers as `<prefix>:<id>` in `registered_groups.jid`.
 * The prefix was often a short code (`dc` for Discord, `tg` for Telegram)
 * that doesn't match v2's `channel_type` names. This table normalizes them.
 *
 * Unknown prefixes fall through as-is (`channel_type = prefix`) so a channel
 * we didn't anticipate still ends up with a distinct messaging_group per
 * chat — the skill can reconcile it interactively.
 */
export const JID_PREFIX_TO_CHANNEL: Record<string, string> = {
  dc: 'discord',
  discord: 'discord',
  tg: 'telegram',
  telegram: 'telegram',
  wa: 'whatsapp',
  whatsapp: 'whatsapp',
  slack: 'slack',
  matrix: 'matrix',
  mx: 'matrix',
  teams: 'teams',
  imessage: 'imessage',
  im: 'imessage',
  email: 'email',
  webex: 'webex',
  gchat: 'gchat',
  linear: 'linear',
  github: 'github',
};

export interface ParsedJid {
  raw: string;
  prefix: string;
  id: string;
  channel_type: string;
}

export function parseJid(raw: string): ParsedJid | null {
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const prefix = raw.slice(0, colon).toLowerCase();
  const id = raw.slice(colon + 1);
  if (!prefix || !id) return null;
  return {
    raw,
    prefix,
    id,
    channel_type: JID_PREFIX_TO_CHANNEL[prefix] ?? prefix,
  };
}

/**
 * Prefer an explicit v1 `channel_name` when one is set; fall back to the JID
 * prefix. v1 left `channel_name` empty on most rows (it was a late addition),
 * so the JID prefix is often the only honest source.
 */
export function inferChannelType(jid: string, channelName: string | null): string | null {
  if (channelName && channelName.trim()) return channelName.trim();
  const parsed = parseJid(jid);
  return parsed?.channel_type ?? null;
}

/**
 * v2's messaging_groups.platform_id is always prefixed with the channel_type
 * (see setup/register.ts:118-120). This helper normalizes v1's `jid` into
 * that shape so router lookups at runtime find the right row.
 *
 * Some channels need extra structure on the id itself. Discord's Chat SDK
 * emits `discord:<guild_id>:<channel_id>` at runtime but v1 only stored
 * `dc:<channel_id>` (no guild). Callers that know the guild (e.g. bot with
 * a single guild) can pass it via `extra`; otherwise the returned id will
 * be the v1-format `discord:<channel_id>` and will be repaired on first
 * message via v2's channel-registration approval flow.
 */
export function v2PlatformId(channelType: string, jid: string, extra?: { guildId?: string }): string {
  const parsed = parseJid(jid);
  const id = parsed?.id ?? jid;
  const prefixed = id.startsWith(`${channelType}:`) ? id : `${channelType}:${id}`;
  // For Discord: splice the guild id in between when we know it and the id
  // isn't already in `<guild>:<channel>` form.
  if (channelType === 'discord' && extra?.guildId) {
    const body = prefixed.slice(`discord:`.length);
    if (!body.includes(':')) return `discord:${extra.guildId}:${body}`;
  }
  return prefixed;
}

/**
 * Fetch the bot's guild memberships for a channel_type so migrate-db can
 * form platform_ids matching what the v2 adapter emits at runtime. Returns
 * null on any failure (network, auth, rate limit, unsupported channel_type)
 * — callers fall back to the v1-format platform_id, which works but may
 * trigger v2's channel-registration flow on first message.
 *
 * Currently handles Discord. Extending to other channels: the function
 * needs a "single-or-multi guild?" shape; for single-guild bots the caller
 * can splice the guild id globally, for multi-guild a per-channel lookup
 * is needed and the caller should probably bail (rate-limit risk).
 */
export async function fetchBotGuilds(
  channelType: string,
  v1EnvLookup: (key: string) => string | undefined,
): Promise<{ guildIds: string[] } | null> {
  if (channelType !== 'discord') return null;
  const token = v1EnvLookup('DISCORD_BOT_TOKEN');
  if (!token) return null;
  try {
    const resp = await fetch('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Array<{ id?: string }>;
    const guildIds = data.map((g) => g.id).filter((id): id is string => typeof id === 'string');
    return { guildIds };
  } catch {
    return null;
  }
}

// ── Trigger rules → engage mode (ports migration 010's backfill) ───────

/**
 * Mirrors the backfill() logic in src/db/migrations/010-engage-modes.ts so
 * rows written by the migration land in the same shape as rows written by
 * setup/register.ts (which goes through migration 010 at boot).
 */
export function triggerToEngage(input: {
  trigger_pattern: string | null;
  requires_trigger: number | null;
}): {
  engage_mode: 'pattern' | 'mention' | 'mention-sticky';
  engage_pattern: string | null;
} {
  const pattern = input.trigger_pattern && input.trigger_pattern.trim().length > 0 ? input.trigger_pattern : null;
  const requiresTrigger = input.requires_trigger !== 0; // NULL/1 → true; 0 → false

  if (pattern === '.' || pattern === '.*') {
    return { engage_mode: 'pattern', engage_pattern: '.' };
  }
  if (pattern) {
    return { engage_mode: 'pattern', engage_pattern: pattern };
  }
  if (!requiresTrigger) {
    return { engage_mode: 'pattern', engage_pattern: '.' };
  }
  return { engage_mode: 'mention', engage_pattern: null };
}

// ── Channel auth registry (non-.env state per channel) ─────────────────

/**
 * Describes the auth surface for a channel beyond `.env`. Each entry tells
 * the channel-auth step:
 *
 *   - `v1EnvKeys`: env keys we might find on the v1 side and carry over
 *   - `requiredV2Keys`: env keys v2's adapter REQUIRES to boot — if missing
 *     from v2's merged .env after migrate-env runs, a followup is emitted so
 *     the user knows exactly what to add (and where to get it).
 *   - `candidatePaths`: relative paths under the v1 root that may hold
 *     on-disk auth state (WhatsApp keystore, matrix sync state, etc.)
 *   - `note`: short human-readable hint surfaced to the user
 *
 * Unknown channels fall through as {v1EnvKeys:[], requiredV2Keys:[],
 * candidatePaths:[]} — the skill asks the user how to proceed.
 *
 * Keep `requiredV2Keys` honest: list only what the v2 adapter actually
 * refuses to boot without. False positives spam the followups; false
 * negatives let the agent silently fail. Verify against the actual
 * `@chat-adapter/<name>` package when adding/updating entries.
 */
export interface ChannelAuthSpec {
  v1EnvKeys: string[];
  requiredV2Keys: { key: string; where: string }[];
  candidatePaths: string[];
  note?: string;
}

export const CHANNEL_AUTH_REGISTRY: Record<string, ChannelAuthSpec> = {
  discord: {
    v1EnvKeys: ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'],
    // v1 used raw discord.js (bot token only). v2 uses Chat SDK which needs
    // the interaction-verification public key + application id on top.
    requiredV2Keys: [
      { key: 'DISCORD_BOT_TOKEN', where: 'Discord Developer Portal → Application → Bot → Token' },
      { key: 'DISCORD_APPLICATION_ID', where: 'Discord Developer Portal → Application → General → Application ID' },
      { key: 'DISCORD_PUBLIC_KEY', where: 'Discord Developer Portal → Application → General → Public Key' },
    ],
    candidatePaths: [],
    note: 'v1 used raw discord.js (bot token only). v2 uses Chat SDK and needs APPLICATION_ID + PUBLIC_KEY too.',
  },
  'discord-supervisor': {
    v1EnvKeys: ['DISCORD_SUPERVISOR_BOT_TOKEN'],
    requiredV2Keys: [],
    candidatePaths: [],
    note: 'v1-specific secondary bot. v2 does not have a native supervisor channel; the token is preserved in .env for the skill to reconcile.',
  },
  telegram: {
    v1EnvKeys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'],
    requiredV2Keys: [
      { key: 'TELEGRAM_BOT_TOKEN', where: 'BotFather on Telegram → /mybots → Bot → API Token' },
    ],
    candidatePaths: ['data/sessions/telegram', 'store/telegram-session'],
  },
  whatsapp: {
    v1EnvKeys: ['WHATSAPP_PHONE', 'WHATSAPP_OWNER'],
    requiredV2Keys: [],
    candidatePaths: [
      'data/sessions/baileys',
      'data/baileys_auth',
      'store/auth_info_baileys',
      'store/baileys',
      'auth_info_baileys',
    ],
    note: 'Baileys keystore — copying is best-effort. Encryption sessions may still need a fresh pair via /add-whatsapp.',
  },
  matrix: {
    v1EnvKeys: ['MATRIX_HOMESERVER', 'MATRIX_USER_ID', 'MATRIX_ACCESS_TOKEN'],
    requiredV2Keys: [
      { key: 'MATRIX_HOMESERVER', where: 'your Matrix homeserver URL (e.g. https://matrix.org)' },
      { key: 'MATRIX_ACCESS_TOKEN', where: 'Element → Settings → Help & About → Access Token (keep secret)' },
    ],
    candidatePaths: ['data/matrix-store', 'store/matrix', 'data/sessions/matrix'],
  },
  slack: {
    v1EnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'],
    requiredV2Keys: [
      { key: 'SLACK_BOT_TOKEN', where: 'Slack app → OAuth & Permissions → Bot User OAuth Token (xoxb-…)' },
      { key: 'SLACK_SIGNING_SECRET', where: 'Slack app → Basic Information → Signing Secret' },
    ],
    candidatePaths: [],
  },
  teams: {
    v1EnvKeys: ['TEAMS_APP_ID', 'TEAMS_APP_PASSWORD', 'TEAMS_TENANT_ID'],
    requiredV2Keys: [
      { key: 'TEAMS_APP_ID', where: 'Azure portal → App registration → Application (client) ID' },
      { key: 'TEAMS_APP_PASSWORD', where: 'Azure portal → App registration → Certificates & secrets' },
    ],
    candidatePaths: [],
  },
  imessage: {
    v1EnvKeys: ['IMESSAGE_PHOTON_URL', 'IMESSAGE_PHOTON_TOKEN'],
    requiredV2Keys: [],
    candidatePaths: ['data/imessage', 'store/imessage'],
  },
  webex: {
    v1EnvKeys: ['WEBEX_BOT_TOKEN'],
    requiredV2Keys: [{ key: 'WEBEX_BOT_TOKEN', where: 'Webex developer portal → Bot → Bot Access Token' }],
    candidatePaths: [],
  },
  gchat: {
    v1EnvKeys: ['GCHAT_SERVICE_ACCOUNT', 'GCHAT_WEBHOOK_URL'],
    requiredV2Keys: [],
    candidatePaths: ['data/gchat-credentials.json', 'store/gchat-sa.json'],
  },
  resend: {
    v1EnvKeys: ['RESEND_API_KEY', 'RESEND_FROM'],
    requiredV2Keys: [{ key: 'RESEND_API_KEY', where: 'resend.com → API Keys' }],
    candidatePaths: [],
  },
  github: {
    v1EnvKeys: ['GITHUB_WEBHOOK_SECRET', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY_PATH'],
    requiredV2Keys: [],
    candidatePaths: [],
    note: 'Webhook channel — secrets carry over, but GitHub webhook URLs are new per v2 install.',
  },
  linear: {
    v1EnvKeys: ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET'],
    requiredV2Keys: [{ key: 'LINEAR_API_KEY', where: 'Linear → Settings → API → Personal API keys' }],
    candidatePaths: [],
  },
};

/**
 * For channels where v2's adapter needs keys v1 never stored (e.g. Discord's
 * Chat SDK wants DISCORD_APPLICATION_ID + DISCORD_PUBLIC_KEY, but v1 used
 * raw discord.js with just the bot token), try to derive the missing keys
 * from the v1 creds we already have by calling the channel's API.
 *
 * Returns a map of key → value for what we successfully resolved.
 * Never throws; returns `{}` on any failure (network, auth, unexpected
 * shape). The caller writes the resolved keys to v2 .env, then re-checks
 * `requiredV2Keys` so the step reports `success` instead of `partial` when
 * auto-resolution covered the gap.
 *
 * Adding a new channel resolver: pull the needed values from an endpoint
 * that accepts only the v1-side credential (bot token, API key). Don't
 * prompt, don't log values. If the endpoint has rate limits, keep this
 * best-effort and fail silently.
 */
export async function autoResolveV2Keys(
  channelType: string,
  v1EnvLookup: (key: string) => string | undefined,
): Promise<Record<string, string>> {
  if (channelType === 'discord') {
    const token = v1EnvLookup('DISCORD_BOT_TOKEN');
    if (!token) return {};
    try {
      const resp = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!resp.ok) return {};
      const data = (await resp.json()) as { id?: string; verify_key?: string };
      const out: Record<string, string> = {};
      if (typeof data.id === 'string' && data.id) out.DISCORD_APPLICATION_ID = data.id;
      if (typeof data.verify_key === 'string' && data.verify_key) {
        out.DISCORD_PUBLIC_KEY = data.verify_key;
      }
      return out;
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * Map a v2 `channel_type` name to the corresponding `setup/install-<x>.sh`
 * script, if one exists. `null` means no v2 skill is available yet — the
 * handoff lists the channel as "not supported" and the skill raises it with
 * the user.
 */
export function installScriptForChannel(channelType: string): string | null {
  const known = new Set([
    'discord',
    'telegram',
    'whatsapp',
    'whatsapp-cloud',
    'teams',
    'slack',
    'matrix',
    'imessage',
    'webex',
    'gchat',
    'resend',
    'github',
    'linear',
  ]);
  if (!known.has(channelType)) return null;
  return `setup/install-${channelType}.sh`;
}

// ── Misc helpers ───────────────────────────────────────────────────────

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── v1-specific pattern scan (for migrate-groups) ──────────────────────

/**
 * Tight set of v1-only infrastructure patterns. When one of these shows up
 * in a copied CLAUDE.md, the content referencing v1 plumbing that is genuinely
 * gone in v2 (IPC file queue, single-DB paths, v1 pr-factory conventions).
 *
 * Deliberately excludes portable patterns — `mcp__nanoclaw__*` tool names,
 * `agent-browser`, generic `/workspace/` paths — which v2 supports the same
 * way. The list is scan-only; the migration does NOT modify file content. It
 * just adds a followup so the /migrate-from-v1 skill can triage each file
 * with the user.
 *
 * Keep this list conservative: false positives spam the skill with noise,
 * false negatives leave the user with silently-broken agents. When adding,
 * include a comment naming the specific v1 thing each pattern points at.
 */
export interface V1PatternMatch {
  pattern: string;
  description: string;
  lines: number[];
}

const V1_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\/workspace\/ipc\/tasks/,
    description: "v1 IPC file queue (gone in v2 — agents talk to the host via session DBs, not JSON files)",
  },
  {
    pattern: /\/workspace\/extra\/project\/store\b/,
    description: "v1-specific mount + store/ path (v2 mounts differ; state lives under data/)",
  },
  {
    pattern: /\bstore\/messages\.db\b/,
    description: "v1 central DB path (v2 uses data/v2.db + data/v2-sessions/<id>/{inbound,outbound}.db)",
  },
  {
    pattern: /"clear_session"|"retrigger"/,
    description: "v1 IPC task types (no v2 equivalent; use session lifecycle + the scheduling MCP tool instead)",
  },
  {
    pattern: /\[PR_CONTEXT:/,
    description: "v1 pr-factory context-tag convention (specific to the supervisor group; needs reworking in v2)",
  },
  {
    pattern: /\brequires_trigger\b|\btrigger_pattern\b/,
    description: "v1 column names on registered_groups (v2 uses engage_mode + engage_pattern on messaging_group_agents)",
  },
  {
    pattern: /\bchatJid\b(?!\s*[:=]\s*["']dc:)/,
    description: "v1 routing key (v2 uses messaging_group_id or channel_type+platform_id)",
  },
];

/** Scan a CLAUDE.md-ish text blob for v1-specific infrastructure patterns. */
export function scanForV1Patterns(text: string): V1PatternMatch[] {
  const matches: V1PatternMatch[] = [];
  const lines = text.split('\n');

  for (const entry of V1_PATTERNS) {
    const hitLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (entry.pattern.test(lines[i])) {
        hitLines.push(i + 1);
      }
    }
    if (hitLines.length > 0) {
      matches.push({
        pattern: entry.pattern.source,
        description: entry.description,
        // Cap to first 5 line numbers — we're generating a followup summary,
        // not a code index. Full context is in the file itself.
        lines: hitLines.slice(0, 5),
      });
    }
  }

  return matches;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '{"error":"unserializable"}';
  }
}
