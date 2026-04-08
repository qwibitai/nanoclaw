/**
 * AgentConfig — immutable configuration for a single Agent.
 * Created by AgentLite.createAgent(). Replaces per-instance fields from config.ts.
 */

import path from 'path';

import type { MountAllowlist } from './types.js';
import type { AgentOptions, CredentialResolver } from './api/options.js';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Immutable config for one Agent — identity, paths, security, credentials. */
export interface AgentConfig {
  // Identity
  readonly agentName: string;
  readonly assistantName: string;
  readonly triggerPattern: RegExp;

  // Paths (derived from workDir)
  readonly workDir: string;
  readonly storeDir: string;
  readonly groupsDir: string;
  readonly dataDir: string;

  // Security
  readonly mountAllowlist: MountAllowlist | null;

  // Credentials
  readonly credentials: CredentialResolver | null;
}

/** Build an immutable AgentConfig from agent name + options + base workdir. */
export function buildAgentConfig(
  agentName: string,
  opts: AgentOptions | undefined,
  baseWorkdir: string,
): AgentConfig {
  const assistantName = opts?.name ?? 'Andy';
  const workdir = path.resolve(
    opts?.workdir ?? path.join(baseWorkdir, 'agents', agentName),
  );

  return {
    agentName,
    assistantName,
    triggerPattern: new RegExp(`^@${escapeRegex(assistantName)}\\b`, 'i'),
    workDir: workdir,
    storeDir: path.join(workdir, 'store'),
    groupsDir: path.join(workdir, 'groups'),
    dataDir: path.join(workdir, 'data'),
    mountAllowlist: opts?.mountAllowlist ?? null,
    credentials: opts?.credentials ?? null,
  };
}
