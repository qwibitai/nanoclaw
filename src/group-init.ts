import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { initContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink name inside the group's dir. Claude Code's @-import only
// follows paths inside cwd, so we can't reference /workspace/global
// directly — we symlink into the group dir and import the symlink. The
// symlink resolves to /workspace/global/CLAUDE.md inside the container;
// dangling on the host is fine, host tools don't follow it.
export const GLOBAL_MEMORY_LINK_NAME = '.claude-global.md';
export const GLOBAL_CLAUDE_IMPORT = `@./${GLOBAL_MEMORY_LINK_NAME}`;

// Nanoclaw-managed env vars. Reconciled to trunk on every container spawn:
// values here always win over what's on disk, keys in DEPRECATED_ENV get
// deleted, anything outside both lists is user-owned and left alone.
const REQUIRED_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  // Auto-compact at 80% of context window instead of SDK default (~97%).
  // Prevents sessions from hitting the hard context limit and triggering
  // silent model fallback on upstream 400 errors.
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
  // Paired with the percentage above: Claude Code 2.1+ has an internal
  // auto-compact window default well under 200k regardless of model. For
  // [1m] sessions that default triggers compaction at ~165k instead of at
  // 80% of 1M. Forcing the window to 1_000_000 aligns the percentage with
  // the [1m] capacity. Non-[1m] sessions still hit their own window first.
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
  // Disable adaptive thinking so the CLI emits visible `thinking` content
  // blocks (the older fixed-budget mode). The CLI's internal gate only
  // applies this to model ids containing "opus-4-6" or "sonnet-4-6"; for
  // 4-7 it's a benign no-op but keeps 4-6 sessions consistent.
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
  // Fixed thinking token budget. 127999 = max_output − 1 (Opus 4.7 max is
  // 128000). Deprecated in the SDK query option surface but still honored
  // by the CLI as an env-var knob that pairs with the disabled-adaptive
  // mode above — gives us a large budget on fixed-budget model variants.
  MAX_THINKING_TOKENS: '127999',
};

// Env keys whose meaning moved or got dropped. Removed from existing
// settings.json on next init so stale values can't leak into the SDK.
//
// ANTHROPIC_DEFAULT_<FAMILY>_MODEL and NANOCLAW_DEFAULT_EFFORT used to
// be pinned here, but their single source of truth now lives in
// container-runner.ts (DEFAULT_OPUS_MODEL etc.) and gets passed via
// docker -e at spawn time. Pinning them in settings.json was a
// group-level layer that bled into every session in the group when
// changed — wrong scope for a "default."
const DEPRECATED_ENV: readonly string[] = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_EFFORT',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'NANOCLAW_DEFAULT_EFFORT',
];

// Nanoclaw-managed top-level settings. Same reconciliation semantics as
// REQUIRED_ENV above.
const REQUIRED_SETTINGS: Record<string, unknown> = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  // Background memory consolidation — prunes stale notes, resolves
  // contradictions, keeps MEMORY.md concise so auto-memory stays useful.
  autoDreamEnabled: true,
  // Explicit opt-in to thinking for supported models. The SDK treats
  // absent-or-true as "enabled automatically" but we keep this explicit
  // so `/update-nanoclaw` can never leave a group with thinking disabled
  // after a settings.json drift.
  alwaysThinkingEnabled: true,
  // Default model alias. Resolves via ANTHROPIC_DEFAULT_OPUS_MODEL —
  // which container-runner.ts ships as a docker `-e` env from
  // DEFAULT_OPUS_MODEL (the install's single source of truth).
  model: 'opus',
};

// Pre-compaction hook (container-side): runs before the SDK auto-compacts so
// destination/routing reminders survive the compaction window. Reconciled by
// shape — if the file is missing the hook entry it's restored on next init.
//
// Pre-tool-use Bash hook: routes every Bash invocation through `rtk hook claude`
// (https://github.com/rtk-ai/rtk), which transparently rewrites commands like
// `git status` into `rtk git status` to compress output before it returns to
// the SDK. Equivalent to running `rtk init -g` on a normal Claude Code install,
// but pre-baked so we never need to run that command per container.
const REQUIRED_HOOKS = {
  PreCompact: [
    {
      hooks: [
        {
          type: 'command',
          command: 'bun /app/src/compact-instructions.ts',
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command: 'rtk hook claude',
        },
      ],
    },
  ],
} as const;

const DEFAULT_SETTINGS_JSON =
  JSON.stringify({ env: REQUIRED_ENV, hooks: REQUIRED_HOOKS, ...REQUIRED_SETTINGS }, null, 2) + '\n';

/**
 * Reconcile an existing settings.json against trunk.
 *
 * For keys in REQUIRED_ENV / REQUIRED_SETTINGS: overwrite to trunk value
 * (so `/update-nanoclaw` pushes model/effort/alias changes out to every
 * existing group without a manual pass). For keys in DEPRECATED_ENV:
 * delete. The PreCompact hook is restored if missing entirely. Anything
 * outside these lists is user-owned and untouched. Returns true if the
 * file was modified.
 */
function ensureRequiredSettings(settingsFile: string): boolean {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  } catch {
    return false;
  }
  let changed = false;
  if (!settings.env || typeof settings.env !== 'object') {
    settings.env = {};
    changed = true;
  }
  const env = settings.env as Record<string, string>;
  for (const k of DEPRECATED_ENV) {
    if (k in env) {
      delete env[k];
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    if (env[k] !== v) {
      env[k] = v;
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(REQUIRED_SETTINGS)) {
    if (settings[k] !== v) {
      settings[k] = v;
      changed = true;
    }
  }
  // PreCompact hook reconciliation: present-or-add. If the file has other
  // hooks (e.g. operator-installed Stop, PreToolUse, etc.) we leave them
  // alone and only ensure PreCompact contains our compact-instructions
  // command. Don't deep-merge — operators may legitimately swap the command
  // or add to it.
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
    changed = true;
  }
  const hooks = settings.hooks as Record<string, unknown>;
  const existingPreCompact = hooks.PreCompact as unknown[] | undefined;
  if (!existingPreCompact || !JSON.stringify(existingPreCompact).includes('compact-instructions.ts')) {
    hooks.PreCompact = JSON.parse(JSON.stringify(REQUIRED_HOOKS.PreCompact));
    changed = true;
  }
  // PreToolUse: present-or-add for the rtk Bash entry. Preserves any other
  // operator-installed PreToolUse hooks alongside it.
  const existingPreToolUse = hooks.PreToolUse as unknown[] | undefined;
  const hasRtkHook = Array.isArray(existingPreToolUse)
    && JSON.stringify(existingPreToolUse).includes('rtk hook claude');
  if (!hasRtkHook) {
    const next = Array.isArray(existingPreToolUse) ? [...existingPreToolUse] : [];
    next.push(JSON.parse(JSON.stringify(REQUIRED_HOOKS.PreToolUse[0])));
    hooks.PreToolUse = next;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  }
  return changed;
}

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path.
 *
 * Source code and skills are shared RO mounts — not copied per-group.
 * Skill symlinks are synced at spawn time by container-runner.ts.
 *
 * The composed `CLAUDE.md` is NOT written here — it's regenerated on every
 * spawn by `composeGroupClaudeMd()` (see `claude-md-compose.ts`). Initial
 * per-group instructions (if provided) seed `CLAUDE.local.md`.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.local.md — per-group agent memory, auto-loaded by
  // Claude Code. Seeded with caller-provided instructions on first creation.
  const claudeLocalFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(claudeLocalFile)) {
    const body = opts?.instructions ? opts.instructions + '\n' : '';
    fs.writeFileSync(claudeLocalFile, body);
    initialized.push('CLAUDE.local.md');
  }

  // groups/<folder>/container.json — empty container config, replaces the
  // former agent_groups.container_config DB column. Self-modification flows
  // read and write this file directly.
  if (initContainerConfig(group.folder)) {
    initialized.push('container.json');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  } else if (ensureRequiredSettings(settingsFile)) {
    initialized.push('settings.json (merged required keys)');
  }

  // Skills directory — created empty here; symlinks are synced at spawn
  // time by container-runner.ts based on container.json skills selection.
  // Container skills themselves live in trunk (`container/skills/`) and are
  // bind-mounted RO; this dir just holds the symlinks that Claude Code
  // discovers via ~/.claude/skills.
  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
    initialized.push('skills/');
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}
