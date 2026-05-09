/**
 * Per-agent-group provider switching.
 *
 * Provider selection lives in three places that must stay in sync:
 *
 *   1. `groups/<folder>/container.json` `.provider` — read at next container
 *      spawn to pick which provider's host-side mounts/env apply.
 *   2. `sessions.agent_provider` — read by `session-manager` to pick the
 *      provider class inside the container.
 *   3. The running container — has the OLD provider baked into its env.
 *      Must be stopped so the next inbound message respawns fresh.
 *
 * `setProvider` does all three atomically. Both `scripts/switch-provider.ts`
 * (CLI) and the Telegram `/provider` command call into this so there is one
 * implementation to maintain.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getDb } from './db/connection.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getActiveSessions } from './db/sessions.js';

// Read at call time, not import time, so tests can flip TEST_GROUPS_DIR
// between cases without resetting modules. Production code never sets the
// env var, so this collapses to the real GROUPS_DIR with no overhead.
function groupsDir(): string {
  return process.env.TEST_GROUPS_DIR ?? GROUPS_DIR;
}

export interface ProviderHint {
  name: string;
  note: string;
}

/**
 * Hint list for the `/provider` reply. Not authoritative — the actual
 * runtime check is whether a provider module is registered. Any string is
 * accepted by `setProvider`; if the provider class isn't registered, the
 * next container spawn will surface that as a clear error.
 */
const PROVIDER_HINTS: ProviderHint[] = [
  { name: 'claude', note: 'Claude Agent SDK — Anthropic Opus/Sonnet/Haiku' },
  { name: 'codex', note: 'OpenAI Codex app-server — ChatGPT subscription or OPENAI_API_KEY' },
];

export function listProviderHints(): ProviderHint[] {
  return PROVIDER_HINTS.slice();
}

export interface CurrentProvider {
  folder: string;
  provider: string;
}

export function getCurrentProvider(folder: string): CurrentProvider | null {
  const containerJson = readContainerJson(folder);
  if (!containerJson) return null;
  return { folder, provider: containerJson.provider ?? 'claude' };
}

export interface SetProviderResult {
  ok: boolean;
  reason?: string;
  previousProvider?: string;
  newProvider?: string;
  sessionsUpdated?: number;
  containersStopped?: number;
}

/**
 * Switch a group to a new provider. Idempotent — returns `ok=false` with
 * `reason='no-change'` if the group is already on `provider`, so callers
 * can render an honest "no change" reply rather than a misleading success.
 */
export function setProvider(folder: string, provider: string): SetProviderResult {
  const containerJson = readContainerJson(folder);
  if (!containerJson) {
    return { ok: false, reason: 'no-container-json' };
  }
  const previousProvider = containerJson.provider ?? 'claude';
  if (previousProvider === provider) {
    return { ok: false, reason: 'no-change', previousProvider, newProvider: provider };
  }

  const group = getAgentGroupByFolder(folder);
  if (!group) {
    return { ok: false, reason: 'group-not-found' };
  }

  // 1. container.json
  containerJson.provider = provider;
  writeContainerJson(folder, containerJson);

  // 2. sessions.agent_provider
  const updated = getDb()
    .prepare('UPDATE sessions SET agent_provider = ? WHERE agent_group_id = ?')
    .run(provider, group.id);
  const sessionsUpdated = updated.changes;

  // 3. Stop running containers — best-effort. Errors here are not fatal:
  //    a stale container will be reaped by the next sweep tick or replaced
  //    on next inbound. The DB is already truth.
  let containersStopped = 0;
  for (const session of getActiveSessions().filter((s) => s.agent_group_id === group.id)) {
    try {
      // Lazy import — avoids pulling docker-runner code into test environments
      // that exercise setProvider via DB-only paths.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { isContainerRunning, killContainer } = require('./container-runner.js') as {
        isContainerRunning: (id: string) => boolean;
        killContainer: (id: string, reason: string) => void;
      };
      if (isContainerRunning(session.id)) {
        killContainer(session.id, 'provider change');
        containersStopped += 1;
      }
    } catch {
      /* best-effort */
    }
  }

  return { ok: true, previousProvider, newProvider: provider, sessionsUpdated, containersStopped };
}

interface ContainerJson {
  provider?: string;
  [key: string]: unknown;
}

function readContainerJson(folder: string): ContainerJson | null {
  const p = path.join(groupsDir(), folder, 'container.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ContainerJson;
}

function writeContainerJson(folder: string, content: ContainerJson): void {
  const p = path.join(groupsDir(), folder, 'container.json');
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(content, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, p);
}
