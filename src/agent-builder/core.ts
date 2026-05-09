/**
 * Agent-builder core — pure library for managing agent groups and drafts.
 *
 * Two front-ends layer on top of this module:
 *   - The playground channel adapter (`src/channels/playground.ts`) — HTTP/WS UI
 *   - A future `/agent-builder` Bash skill (out of scope today)
 *
 * Conventions:
 *   - Drafts are real `agent_groups` rows with `folder` starting with `draft_`.
 *   - Target folder name is `folder.slice('draft_'.length)`.
 *   - Draft files live under `groups/draft_<target>/` and are first seeded
 *     from `groups/<target>/` on createDraft.
 *
 * No HTTP, no web sockets — just DB + filesystem. Side effects are
 * idempotent where reasonable so the playground can call them on every
 * session start without bookkeeping its own state.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import {
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  getAgentGroupByFolder,
  getAllAgentGroups,
} from '../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { getDb } from '../db/connection.js';
import { deleteSession, getActiveSessions } from '../db/sessions.js';
import type { AgentGroup, MessagingGroup } from '../types.js';

const DRAFT_PREFIX = 'draft_';
export const PLAYGROUND_CHANNEL = 'playground';

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isDraftFolder(folder: string): boolean {
  return folder.startsWith(DRAFT_PREFIX);
}

function targetFolderOf(draftFolder: string): string {
  if (!isDraftFolder(draftFolder)) {
    throw new Error(`Not a draft folder: ${draftFolder}`);
  }
  return draftFolder.slice(DRAFT_PREFIX.length);
}

function platformIdFor(draftFolder: string): string {
  return `${PLAYGROUND_CHANNEL}:${draftFolder}`;
}

function groupDir(folder: string): string {
  return path.join(GROUPS_DIR, folder);
}

function copyIfExists(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dst);
  return true;
}

// ── Listing ────────────────────────────────────────────────────────────────

/** All non-draft agent groups. */
export function listAgentGroups(): AgentGroup[] {
  return getAllAgentGroups().filter((g) => !isDraftFolder(g.folder));
}

export interface DraftListEntry {
  draft: AgentGroup;
  target: AgentGroup | null;
}

/** All drafts, paired with their target group (null if target deleted). */
export function listDrafts(): DraftListEntry[] {
  return getAllAgentGroups()
    .filter((g) => isDraftFolder(g.folder))
    .map((draft) => {
      const target = getAgentGroupByFolder(targetFolderOf(draft.folder)) ?? null;
      return { draft, target };
    });
}

// ── Draft lifecycle ────────────────────────────────────────────────────────

/**
 * Create a draft from an existing agent group.
 *
 * Side effects:
 *   - Inserts an `agent_groups` row with folder=`draft_<target>`.
 *   - Creates `groups/draft_<target>/` directory.
 *   - Copies CLAUDE.local.md and container.json from the target.
 *
 * Throws if the target doesn't exist or a draft for it already exists.
 */
export function createDraft(targetFolder: string): AgentGroup {
  if (isDraftFolder(targetFolder)) {
    throw new Error(`Cannot draft a draft: ${targetFolder}`);
  }
  const target = getAgentGroupByFolder(targetFolder);
  if (!target) {
    throw new Error(`Target agent group not found: ${targetFolder}`);
  }

  const draftFolder = `${DRAFT_PREFIX}${targetFolder}`;
  if (getAgentGroupByFolder(draftFolder)) {
    throw new Error(`Draft already exists: ${draftFolder}`);
  }

  const draftDir = groupDir(draftFolder);
  fs.mkdirSync(draftDir, { recursive: true });

  copyIfExists(path.join(groupDir(targetFolder), 'CLAUDE.local.md'), path.join(draftDir, 'CLAUDE.local.md'));
  copyIfExists(path.join(groupDir(targetFolder), 'container.json'), path.join(draftDir, 'container.json'));

  const draft: AgentGroup = {
    id: shortId('ag'),
    name: draftFolder,
    folder: draftFolder,
    agent_provider: target.agent_provider,
    model: target.model,
    created_at: nowIso(),
  };
  createAgentGroup(draft);
  return draft;
}

/**
 * Apply a draft's files to its target group.
 *
 * Side effects:
 *   - Copies CLAUDE.local.md and container.json from draft to target.
 *   - By default also discards the draft (deletes its row + folder + mg).
 *     Pass `keepDraft: true` to keep editing after apply.
 */
export function applyDraft(draftFolder: string, opts: { keepDraft?: boolean } = {}): void {
  const draft = getAgentGroupByFolder(draftFolder);
  if (!draft) throw new Error(`Draft not found: ${draftFolder}`);
  const targetFolder = targetFolderOf(draftFolder);
  const target = getAgentGroupByFolder(targetFolder);
  if (!target) throw new Error(`Target not found: ${targetFolder}`);

  const draftDir = groupDir(draftFolder);
  const targetDir = groupDir(targetFolder);
  copyIfExists(path.join(draftDir, 'CLAUDE.local.md'), path.join(targetDir, 'CLAUDE.local.md'));
  copyIfExists(path.join(draftDir, 'container.json'), path.join(targetDir, 'container.json'));

  if (!opts.keepDraft) {
    discardDraft(draftFolder);
  }
}

/**
 * Discard a draft entirely.
 *
 * Side effects:
 *   - Deletes the draft's `agent_groups` row.
 *   - Deletes the draft's playground messaging_group (if any) and any
 *     messaging_group_agents wiring rows referencing the draft.
 *   - Removes `groups/draft_<target>/` from the filesystem.
 *
 * Idempotent — safe to call on a non-existent draft.
 */
export function discardDraft(draftFolder: string): void {
  if (!isDraftFolder(draftFolder)) {
    throw new Error(`Not a draft folder: ${draftFolder}`);
  }
  const draft = getAgentGroupByFolder(draftFolder);
  if (draft) {
    // FKs aren't CASCADE — delete dependents in dependency order. We
    // sweep every table that has an agent_group_id FK to be defensive
    // against future schema additions; drafts shouldn't have most of
    // these, but a leftover in any one of them blocks deleteAgentGroup.
    const db = getDb();
    const mg = getMessagingGroupByPlatform(PLAYGROUND_CHANNEL, platformIdFor(draftFolder));

    db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(draft.id);
    db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(draft.id);
    db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(draft.id);
    db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(draft.id);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_destinations'").get()) {
      db.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(draft.id);
    }

    if (mg) {
      deleteMessagingGroup(mg.id);
    }

    deleteAgentGroup(draft.id);
  }

  const dir = groupDir(draftFolder);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Inspection ─────────────────────────────────────────────────────────────

export interface DraftDiff {
  personaChanged: boolean;
  containerJsonChanged: boolean;
  draftPersona: string | null;
  targetPersona: string | null;
  draftContainerJson: string | null;
  targetContainerJson: string | null;
}

/** Compare draft files against target. Both files may be absent. */
export function diffDraftAgainstTarget(draftFolder: string): DraftDiff {
  const targetFolder = targetFolderOf(draftFolder);
  const draftPersona = readIfExists(path.join(groupDir(draftFolder), 'CLAUDE.local.md'));
  const targetPersona = readIfExists(path.join(groupDir(targetFolder), 'CLAUDE.local.md'));
  const draftContainerJson = readIfExists(path.join(groupDir(draftFolder), 'container.json'));
  const targetContainerJson = readIfExists(path.join(groupDir(targetFolder), 'container.json'));

  return {
    personaChanged: draftPersona !== targetPersona,
    containerJsonChanged: draftContainerJson !== targetContainerJson,
    draftPersona,
    targetPersona,
    draftContainerJson,
    targetContainerJson,
  };
}

export interface DraftStatus {
  exists: boolean;
  dirty: boolean;
  targetExists: boolean;
}

/** Quick status: does the draft exist, is it different from target, does target still exist? */
export function getDraftStatus(draftFolder: string): DraftStatus {
  const draft = getAgentGroupByFolder(draftFolder);
  if (!draft) {
    return { exists: false, dirty: false, targetExists: false };
  }
  const targetFolder = targetFolderOf(draftFolder);
  const targetExists = !!getAgentGroupByFolder(targetFolder);
  if (!targetExists) {
    return { exists: true, dirty: true, targetExists: false };
  }
  const diff = diffDraftAgainstTarget(draftFolder);
  return { exists: true, dirty: diff.personaChanged || diff.containerJsonChanged, targetExists: true };
}

function readIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// ── Channel-related (called by the playground adapter on session start) ────

/**
 * Ensure a `messaging_groups` row exists for this draft's playground
 * session. Idempotent — returns the existing row if already created.
 */
export function ensureDraftMessagingGroup(draftFolder: string): MessagingGroup {
  if (!isDraftFolder(draftFolder)) {
    throw new Error(`Not a draft folder: ${draftFolder}`);
  }
  const platformId = platformIdFor(draftFolder);
  const existing = getMessagingGroupByPlatform(PLAYGROUND_CHANNEL, platformId);
  if (existing) return existing;

  const mg: MessagingGroup = {
    id: shortId('mg'),
    channel_type: PLAYGROUND_CHANNEL,
    platform_id: platformId,
    name: draftFolder,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: nowIso(),
    denied_at: null,
  };
  createMessagingGroup(mg);
  return mg;
}

/**
 * Ensure the draft's mg ↔ draft agent_group wiring exists with the
 * playground's "engage on every message" semantics. Idempotent.
 */
export function ensureDraftWiring(draftFolder: string): void {
  const draft = getAgentGroupByFolder(draftFolder);
  if (!draft) throw new Error(`Draft not found: ${draftFolder}`);
  const mg = ensureDraftMessagingGroup(draftFolder);

  const existing = getMessagingGroupAgentByPair(mg.id, draft.id);
  if (existing) return;

  createMessagingGroupAgent({
    id: shortId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: draft.id,
    engage_mode: 'pattern',
    engage_pattern: '.', // sentinel: match every message
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: nowIso(),
  });
}

// Exported for tests + the playground adapter.
export { isDraftFolder, targetFolderOf, platformIdFor };
