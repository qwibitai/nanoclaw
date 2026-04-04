/**
 * SDK option types — the public type surface for AgentLite consumers.
 *
 * Kept separate from config.ts (runtime config vars) and sdk.ts (class impl)
 * so the API surface is easy to review and doesn't pull in runtime logic.
 */

import type {
  ContainerConfig,
  MountAllowlist,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from './types.js';
export type {
  ContainerConfig,
  AdditionalMount,
  MountAllowlist,
  AllowedRoot,
} from './types.js';

/**
 * Channel callback shape — controls how inbound messages are processed.
 *
 * The built-in handler stores messages in the database, intercepts remote
 * control commands, and enforces the sender allowlist. When wrapping via
 * `AgentLiteOptions.channelHandler`, you **must** call the built-in
 * callbacks (e.g. `builtin.onMessage`) or messages will not be stored
 * and the agent will never see them.
 */
export interface ChannelHandler {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Resolves credentials to env vars injected into agent containers.
 *  Called once per container spawn. Return a map like { ANTHROPIC_API_KEY: 'sk-...' }. */
export type CredentialResolver = () => Promise<Record<string, string>>;

/** Model/LLM configuration for agent containers. */
export interface ModelOptions {
  /** Resolve credentials to env vars injected into each agent container.
   *  If not set, falls back to OneCLI gateway. */
  credentials?: CredentialResolver;
}

/** Options accepted by the AgentLite SDK constructor. All optional with defaults. */
export interface AgentLiteOptions {
  /** Agent name (used for trigger pattern @Name and CLAUDE.md templates). Defaults to 'Andy'. */
  name?: string;
  /** Directory for agentlite data (store/, groups/, data/, .boxlite/). Defaults to cwd at start() time. */
  workdir?: string;
  /** Model/LLM configuration. If not provided, falls back to OneCLI gateway for credentials. */
  model?: ModelOptions;
  /** Mount allowlist for container security. Defines which host paths can be mounted.
   *  If not provided, all additional mounts are blocked. */
  mountAllowlist?: MountAllowlist;
  /**
   * Wrap the built-in channel handler to add custom logic (logging, filtering, etc.).
   * Applied to all channels. You **must** call `builtin.onMessage` / `builtin.onChatMetadata`
   * inside your wrapper — omitting them breaks message storage and delivery.
   *
   * @example
   * ```ts
   * channelHandler: (builtin) => ({
   *   ...builtin,
   *   onMessage: (jid, msg) => {
   *     console.log(`[${jid}] ${msg.content}`);
   *     builtin.onMessage(jid, msg); // required — stores the message
   *   },
   * })
   * ```
   */
  channelHandler?: (builtin: ChannelHandler) => ChannelHandler;
}

/** Simplified group options for SDK registration. */
export interface GroupOptions {
  name: string;
  isMain?: boolean;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: ContainerConfig;
}
