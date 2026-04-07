/**
 * Public option types for AgentLite consumers.
 */

import type { ChannelDriver } from './channel-driver.js';
import type { MountAllowlist } from './mount.js';

/** Resolves credentials to env vars injected into agent containers. */
export type CredentialResolver = () => Promise<Record<string, string>>;

/** Options for creating the AgentLite platform. */
export interface AgentLiteOptions {
  /** Base data directory. Default: cwd */
  workdir?: string;
  /** Container image. Default: 'ghcr.io/boxlite-ai/agentlite-agent:latest' */
  boxImage?: string;
  /** OneCLI gateway URL. Default: 'http://localhost:10254' */
  onecliUrl?: string;
  /** Timezone for scheduled tasks. Default: system timezone */
  timezone?: string;
}

/** Options for creating an Agent. */
export interface AgentOptions {
  /** Agent-specific data directory. Default: {base}/agents/{name} */
  workdir?: string;
  /** Assistant trigger name (used in @Name patterns). Default: 'Andy' */
  name?: string;
  /** Resolve credentials injected into agent containers. Falls back to OneCLI if not set. */
  credentials?: CredentialResolver;
  /** Mount allowlist for container security. Blocks all mounts if not provided. */
  mountAllowlist?: MountAllowlist;
  /** Initial channels to connect. Can also be added later via agent.addChannel(). */
  channels?: Record<string, ChannelDriver>;
}
