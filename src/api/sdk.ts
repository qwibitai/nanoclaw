/**
 * AgentLite SDK — the public API entry point.
 *
 * @example
 * ```typescript
 * import { createAgentLite } from '@boxlite-ai/agentlite';
 * import { telegram } from '@boxlite-ai/agentlite/channels/telegram';
 *
 * const agentlite = await createAgentLite({ workdir: './data' });
 * const agent = agentlite.createAgent('main', {
 *   name: 'Andy',
 *   channels: { telegram: telegram({ token: process.env.TG_TOKEN! }) },
 * });
 * await agent.start();
 * ```
 */

export type {
  AgentLiteOptions,
  AgentOptions,
  CredentialResolver,
} from './options.js';
export type { Agent } from './agent.js';
export type {
  ChannelDriver,
  ChannelDriverFactory,
  ChannelDriverConfig,
  ChannelIdentity,
} from './channel-driver.js';
export type { MountAllowlist, AllowedRoot } from './mount.js';

import type { Agent } from './agent.js';
import type { AgentLiteOptions, AgentOptions } from './options.js';

/** Platform-level runtime. Creates and manages Agents. */
export interface AgentLite {
  /** All active agents. */
  readonly agents: ReadonlyMap<string, Agent>;

  /** Create a named Agent with isolated workdir, channels, and per-chat VMs. */
  createAgent(name: string, options?: AgentOptions): Agent;
  /** Stop and remove a named Agent. */
  deleteAgent(name: string): Promise<void>;
  /** Stop all agents and release resources. */
  stop(): Promise<void>;
}

/** Create and initialize the AgentLite platform. */
export async function createAgentLite(
  options?: AgentLiteOptions,
): Promise<AgentLite> {
  const { createAgentLiteImpl } = await import('../agentlite-impl.js');
  return createAgentLiteImpl(options);
}
