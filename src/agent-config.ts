/**
 * AgentConfig — immutable configuration for a single Agent.
 * Created from persisted agent metadata plus runtime-only options.
 */

import path from 'path';

import type { MountAllowlist } from './types.js';
import type { AgentOptions } from './api/options.js';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalizeJson(child)]),
    );
  }
  return value;
}

export function serializeMountAllowlist(
  mountAllowlist: MountAllowlist | null,
): string | null {
  return mountAllowlist === null
    ? null
    : JSON.stringify(normalizeJson(mountAllowlist));
}

export interface SerializableAgentSettings {
  readonly agentName: string;
  readonly assistantName: string;
  readonly workDir: string;
  readonly mountAllowlist: MountAllowlist | null;
}

export interface PersistedAgentSettings extends SerializableAgentSettings {
  readonly agentId: string;
}

/** Immutable config for one Agent — identity, paths, and security. */
export interface AgentConfig extends PersistedAgentSettings {
  readonly triggerPattern: RegExp;
  readonly storeDir: string;
  readonly groupsDir: string;
  readonly dataDir: string;
}

/** Resolve the serializable subset of AgentOptions that is stored in the registry. */
export function resolveSerializableAgentSettings(
  agentName: string,
  opts: AgentOptions | undefined,
  baseWorkdir: string,
): SerializableAgentSettings {
  return {
    agentName,
    assistantName: opts?.name ?? 'Andy',
    workDir: path.resolve(
      opts?.workdir ?? path.join(baseWorkdir, 'agents', agentName),
    ),
    mountAllowlist: opts?.mountAllowlist ?? null,
  };
}

/** Build an immutable AgentConfig from persisted registry metadata. */
export function buildAgentConfig(input: PersistedAgentSettings): AgentConfig {
  const workDir = path.resolve(input.workDir);

  return {
    agentId: input.agentId,
    agentName: input.agentName,
    assistantName: input.assistantName,
    triggerPattern: new RegExp(`^@${escapeRegex(input.assistantName)}\\b`, 'i'),
    workDir,
    storeDir: path.join(workDir, 'store'),
    groupsDir: path.join(workDir, 'groups'),
    dataDir: path.join(workDir, 'data'),
    mountAllowlist: input.mountAllowlist,
  };
}
