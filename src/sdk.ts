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
 * const agent = new AgentLite({ workdir: './agentlite-data' });
 * await agent.start();
 *
 * await agent.registerChannel(new TelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN }));
 * agent.registerGroup('tg:7123844036', { name: 'Main', isMain: true });
 * ```
 */

import { ASSISTANT_NAME, setProjectRoot, setAssistantName } from './config.js';
import { Channel, RegisteredGroup } from './types.js';

// Type-only re-exports (zero runtime cost — erased at compile time)
export type { Channel, RegisteredGroup, NewMessage } from './types.js';
export type { ContainerOutput } from './container-runner.js';

/** Resolves credentials to env vars injected into agent containers.
 *  Called once per container spawn. Return a map like { ANTHROPIC_API_KEY: 'sk-...' }. */
export type CredentialResolver = () => Promise<Record<string, string>>;

/** LLM configuration for agent containers. */
export interface LLMOptions {
  /** Resolve credentials to env vars injected into each agent container.
   *  If not set, falls back to OneCLI gateway. */
  credentials?: CredentialResolver;
}

/** Options for the AgentLite SDK. */
export interface AgentLiteOptions {
  /** Agent name (used for trigger pattern @Name and CLAUDE.md templates). Defaults to 'Andy'. */
  name?: string;
  /** Directory for agentlite data (store/, groups/, data/, .boxlite/). Defaults to process.cwd(). */
  workdir?: string;
  /** Install SIGTERM/SIGINT handlers for graceful shutdown. Default: false.
   *  Set to false (default) when embedding in a host app that owns the process lifecycle. */
  handleSignals?: boolean;
  /** LLM configuration. If not provided, falls back to OneCLI gateway for credentials. */
  llm?: LLMOptions;
}

/** Simplified group options for SDK registration. */
export interface GroupOptions {
  name: string;
  isMain?: boolean;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
}

export class AgentLite {
  private _channels: Channel[] = [];
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
   * Call this first, then registerChannel/registerGroup dynamically.
   */
  async start(): Promise<void> {
    if (this._started) throw new Error('AgentLite already started');
    this._started = true;

    if (this._options.name) {
      setAssistantName(this._options.name);
    }
    if (this._options.workdir) {
      setProjectRoot(this._options.workdir);
    }

    // Dynamic import — the orchestrator (and its native deps) load here, not at import time
    const orchestrator = await import('./orchestrator.js');
    this._orchestrator = orchestrator;

    await orchestrator.start({
      channels: this._channels,
      groups: this._groups,
      handleSignals: this._options.handleSignals ?? false,
      llm: this._options.llm,
    });
  }

  /**
   * Register a messaging channel (Telegram, Slack, etc.).
   * Can be called before or after start().
   * If called after start(), the channel is connected immediately.
   */
  async registerChannel(channel: Channel): Promise<void> {
    this._channels.push(channel);

    if (this._started && this._orchestrator) {
      await this._orchestrator.registerChannel(channel);
    }
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
    };

    this._groups.set(jid, group);

    if (this._started && this._orchestrator) {
      this._orchestrator.registerGroup(jid, group);
    }
  }

  /**
   * Get the number of connected channels.
   */
  channelCount(): number {
    if (this._orchestrator) {
      return this._orchestrator.channelCount();
    }
    return this._channels.length;
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
