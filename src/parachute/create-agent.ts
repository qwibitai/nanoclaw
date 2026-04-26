/**
 * Create a Parachute agent group from a single call.
 *
 * Wraps NanoClaw's central-DB write (`createAgentGroup`) and on-disk init
 * (`initGroupFilesystem`) into one shim, with optional inline vault
 * attachment via `attachVaultToGroup`. Channel wiring is intentionally NOT
 * here — the wizard creates a channel-less group; channel install is its
 * own surface (paraclaw#2).
 *
 * The shim is the seam the web server uses; the existing CLI scripts
 * (`init-first-agent.ts` etc.) stay on the same NanoClaw helpers and are
 * untouched.
 */
import {
  createAgentGroup as dbCreateAgentGroup,
  getAgentGroupByFolder,
} from '../db/agent-groups.js';
import { initGroupFilesystem } from '../group-init.js';
import { normalizeName } from '../modules/agent-to-agent/db/agent-destinations.js';
import type { AgentGroup } from '../types.js';

import type { VaultAttachment, VaultScope } from './types.js';
import { attachVaultToGroup, readVaultAttachment } from './vault-mcp.js';

const FOLDER_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const FOLDER_MAX = 48;

export interface FolderValidationOk {
  ok: true;
}
export interface FolderValidationFail {
  ok: false;
  reason: string;
}
export type FolderValidation = FolderValidationOk | FolderValidationFail;

export function validateFolderSlug(slug: string): FolderValidation {
  if (!slug) return { ok: false, reason: 'folder slug is required' };
  if (slug.length > FOLDER_MAX) {
    return { ok: false, reason: `folder slug must be ≤ ${FOLDER_MAX} chars` };
  }
  if (!FOLDER_RE.test(slug)) {
    return {
      ok: false,
      reason:
        'folder slug must be lowercase letters, digits, and dashes; cannot start or end with a dash',
    };
  }
  return { ok: true };
}

export function suggestFolderSlug(name: string): string {
  return normalizeName(name).slice(0, FOLDER_MAX);
}

export function isFolderTaken(folder: string): boolean {
  return getAgentGroupByFolder(folder) !== undefined;
}

export interface CreateAgentGroupVaultOpts {
  scope: VaultScope;
  vaultBaseUrl?: string;
  tokenLabel?: string;
  /** If absent, callers higher up the stack mint via `parachute vault tokens create`. */
  token: string;
  mcpName?: string;
  instructions?: string;
}

export interface CreateAgentGroupOpts {
  name: string;
  folder: string;
  instructions?: string;
  /** Optional inline vault attachment. The token must already be in hand. */
  vault?: CreateAgentGroupVaultOpts;
}

export interface CreateAgentGroupResult {
  group: AgentGroup;
  vault: VaultAttachment | null;
}

/**
 * Create a new agent group: validate, write DB row, initialize filesystem,
 * optionally attach a vault. NOT idempotent — `isFolderTaken` is the gate
 * the caller must check; this throws if the folder already exists.
 */
export function createParachuteAgentGroup(opts: CreateAgentGroupOpts): CreateAgentGroupResult {
  const folderCheck = validateFolderSlug(opts.folder);
  if (!folderCheck.ok) {
    throw new Error(`invalid folder slug: ${folderCheck.reason}`);
  }
  const trimmedName = opts.name.trim();
  if (!trimmedName) {
    throw new Error('agent name is required');
  }
  if (isFolderTaken(opts.folder)) {
    throw new Error(`agent group folder already exists: ${opts.folder}`);
  }

  const id = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created_at = new Date().toISOString();
  const group: AgentGroup = {
    id,
    name: trimmedName,
    folder: opts.folder,
    agent_provider: null,
    created_at,
  };

  dbCreateAgentGroup(group);
  initGroupFilesystem(group, { instructions: opts.instructions });

  let vault: VaultAttachment | null = null;
  if (opts.vault) {
    attachVaultToGroup({
      folder: group.folder,
      vaultBaseUrl: opts.vault.vaultBaseUrl ?? 'http://127.0.0.1:1940/vault/default',
      vaultToken: opts.vault.token,
      scope: opts.vault.scope,
      tokenLabel: opts.vault.tokenLabel ?? `claw-${group.folder}`,
      mcpName: opts.vault.mcpName,
      instructions: opts.vault.instructions,
    });
    vault = readVaultAttachment(group.folder, opts.vault.mcpName);
  }

  return { group, vault };
}
