/**
 * AgentConfig — immutable configuration for a single Agent.
 * Created from persisted agent metadata plus runtime-only options.
 */

import path from 'path';

import type { MountAllowlist } from '../types.js';
import type {
  AgentBackendOptions,
  AgentOptions,
  McpServerConfig,
} from '../api/options.js';
import { normalizeAgentBackendOptions } from './backend.js';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeJson(value: unknown): unknown {
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
  readonly backend: AgentBackendOptions;
  readonly workDir: string;
  readonly mountAllowlist: MountAllowlist | null;
  /** Agent-level instructions appended to the system prompt. */
  readonly instructions: string | null;
  /** Source paths for agent-level skill directories (for re-sync on start). */
  readonly skillsSources: string[] | null;
  /** Custom MCP servers passed into agent containers. */
  readonly mcpServers: Record<string, McpServerConfig> | null;
}

export interface PersistedAgentSettings extends SerializableAgentSettings {
  readonly agentId: string;
}

type BuildAgentConfigInput = Omit<PersistedAgentSettings, 'backend'> & {
  readonly backend?: AgentBackendOptions;
};

/** Immutable config for one Agent — identity, paths, and security. */
export interface AgentConfig extends PersistedAgentSettings {
  readonly triggerPattern: RegExp;
  readonly storeDir: string;
  readonly groupsDir: string;
  readonly dataDir: string;
  /** Agent-level customization directory. */
  readonly agentDir: string;
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
    backend: normalizeAgentBackendOptions(opts?.backend),
    workDir: path.resolve(
      opts?.workdir ?? path.join(baseWorkdir, 'agents', agentName),
    ),
    mountAllowlist: opts?.mountAllowlist ?? null,
    instructions: opts?.instructions ?? null,
    skillsSources: opts?.skills?.length
      ? opts.skills.map((s) => path.resolve(s))
      : null,
    mcpServers:
      opts?.mcpServers && Object.keys(opts.mcpServers).length > 0
        ? Object.fromEntries(
            Object.entries(opts.mcpServers).map(([name, cfg]) => [
              name,
              { ...cfg, source: path.resolve(cfg.source) },
            ]),
          )
        : null,
  };
}

/** Build an immutable AgentConfig from persisted registry metadata. */
export function buildAgentConfig(input: BuildAgentConfigInput): AgentConfig {
  const workDir = path.resolve(input.workDir);

  return {
    agentId: input.agentId,
    agentName: input.agentName,
    assistantName: input.assistantName,
    backend: normalizeAgentBackendOptions(input.backend),
    triggerPattern: new RegExp(`^@${escapeRegex(input.assistantName)}\\b`, 'i'),
    workDir,
    storeDir: path.join(workDir, 'store'),
    groupsDir: path.join(workDir, 'groups'),
    dataDir: path.join(workDir, 'data'),
    agentDir: path.join(workDir, 'agent'),
    mountAllowlist: input.mountAllowlist,
    instructions: input.instructions,
    skillsSources: input.skillsSources,
    mcpServers: input.mcpServers,
  };
}
