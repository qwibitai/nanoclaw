/**
 * Public option types for AgentLite consumers.
 */

import type { ChannelDriverFactory } from './channel-driver.js';
import type { MountAllowlist } from './mount.js';

/** Resolves credentials to env vars injected into agent containers. */
export type CredentialResolver = () => Promise<Record<string, string>>;

/**
 * MCP server configuration (stdio transport).
 * The source directory is copied into the container, similar to skills.
 */
export interface McpServerConfig {
  /** Host path to the MCP server source directory. Copied into the container. */
  source: string;
  /** Command to run (e.g., 'node', 'python'). Must be available in the container. */
  command: string;
  /** Arguments. The first argument is resolved relative to the source directory inside the container. */
  args?: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
}

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
  /** Agent-specific data directory. Persisted in the platform registry. Default: {base}/agents/{name} */
  workdir?: string;
  /** Assistant trigger name (used in @Name patterns). Persisted in the platform registry. Default: 'Andy' */
  name?: string;
  /** Resolve credentials injected into agent containers. Runtime-only, never persisted. */
  credentials?: CredentialResolver;
  /** Mount allowlist for container security. Persisted in the platform registry. */
  mountAllowlist?: MountAllowlist;
  /** Initial channels. Factories are called at agent.start() time and are never persisted. */
  channels?: Record<string, ChannelDriverFactory>;
  /** Instructions appended to the system prompt for every group in this agent. */
  instructions?: string;
  /** Host paths to skill directories (each must contain SKILL.md). Loaded into every group's container. */
  skills?: string[];
  /** Custom MCP servers made available to agent containers. Persisted in the platform registry. */
  mcpServers?: Record<string, McpServerConfig>;
}
