/**
 * AgentLite SDK — the library entry point.
 *
 * This is the "lib" side of the lib/bin split (like Rust's src/lib.rs).
 * Importing this module is lightweight and side-effect-free — no native
 * modules are loaded, no process handlers installed. Heavy initialization
 * only happens when start() is called.
 *
 * @example
 * ```typescript
 * import { AgentLite } from '@boxlite-ai/agentlite';
 * import { TelegramChannel } from '@boxlite-ai/agentlite/channels/telegram';
 *
 * const agent = new AgentLite({
 *   workdir: './agentlite-data',
 *   model: { credentials: async () => ({ ANTHROPIC_API_KEY: 'sk-...' }) },
 * });
 * await agent.start();
 *
 * await agent.registerChannelFactory('telegram', (opts) =>
 *   new TelegramChannel({ token: '123:ABC', channelOptions: opts })
 * );
 * agent.registerGroup('tg:7123844036', { name: 'Main', isMain: true });
 * ```
 */

import { ASSISTANT_NAME, applyConfig } from './config.js';
import { Channel, RegisteredGroup } from './types.js';
import type { AgentLiteOptions, GroupOptions } from './options.js';
import type { ChannelFactory } from './channels/registry.js';

// Type-only re-exports (zero runtime cost — erased at compile time)
export type {
  AgentLiteOptions,
  ModelOptions,
  CredentialResolver,
  GroupOptions,
  ChannelHandler,
} from './options.js';
export type {
  Channel,
  RegisteredGroup,
  ContainerConfig,
  AdditionalMount,
  MountAllowlist,
  AllowedRoot,
} from './types.js';
export type { ChannelOpts, ChannelFactory } from './channels/registry.js';

export class AgentLite {
  private _groups: Map<string, RegisteredGroup> = new Map();
  private _started = false;
  private _orchestrator: typeof import('./orchestrator.js') | null = null;
  private _options: AgentLiteOptions;

  constructor(options?: AgentLiteOptions) {
    this._options = options ?? {};
  }

  /**
   * Start the orchestrator.
   * Initializes BoxLite runtime, database, and message processing loop.
   * This is when native modules are loaded — not at import time.
   * Call this first, then registerChannelFactory/registerGroup dynamically.
   */
  async start(): Promise<void> {
    if (this._started) throw new Error('AgentLite already started');
    this._started = true;

    // Apply all options to config module — every downstream import
    // sees updated values via ESM live bindings. One call, zero
    // changes needed in orchestrator/container-runner/ipc/etc.
    applyConfig(this._options);

    // Dynamic import — the orchestrator (and its native deps) load here, not at import time
    const orchestrator = await import('./orchestrator.js');
    this._orchestrator = orchestrator;

    await orchestrator.start({
      groups: this._groups,
      model: this._options.model,
      channelHandler: this._options.channelHandler,
    });
  }

  /**
   * Register a channel factory. Must be called after start().
   * The factory receives ChannelOpts (callbacks) and returns a Channel.
   * Returns true if the factory produced a channel, false if it returned null.
   */
  async registerChannelFactory(
    name: string,
    factory: ChannelFactory,
  ): Promise<boolean> {
    if (!this._started || !this._orchestrator) {
      throw new Error('Cannot register channels before start()');
    }
    return this._orchestrator.registerChannelFactory(name, factory);
  }

  /**
   * Register a group/chat for the agent to monitor.
   * Only `name` is required — folder, trigger, and timestamps are auto-derived.
   * Can be called before or after start().
   */
  registerGroup(jid: string, options: GroupOptions): void {
    const folder =
      options.folder ??
      options.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    const group: RegisteredGroup = {
      name: options.name,
      folder,
      trigger: options.trigger ?? `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      isMain: options.isMain ?? false,
      requiresTrigger:
        options.requiresTrigger ?? (options.isMain ? false : true),
      containerConfig: options.containerConfig,
    };

    this._groups.set(jid, group);

    if (this._started && this._orchestrator) {
      this._orchestrator.registerGroup(jid, group);
    }
  }

  /**
   * Stop the orchestrator gracefully.
   */
  async stop(): Promise<void> {
    if (!this._started || !this._orchestrator) return;
    await this._orchestrator.stop();
    this._started = false;
  }
}
