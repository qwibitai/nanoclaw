/**
 * AgentLite SDK
 *
 * Out-of-box orchestrator for running Claude agents in BoxLite VMs
 * with messaging channel integration.
 *
 * @example
 * ```typescript
 * import { AgentLite, TelegramChannel } from '@boxlite-ai/agentlite';
 *
 * const agent_lite = new AgentLite();
 * await agent_lite.start();
 *
 * agent_lite.registerChannel(new TelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN }));
 * agent_lite.registerGroup('tg:7123844036', { name: 'Main', isMain: true });
 * ```
 */

import { ASSISTANT_NAME } from './config.js';
import { Channel, RegisteredGroup } from './types.js';

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
  private _mainModule: typeof import('./index.js') | null = null;

  constructor() {}

  /**
   * Start the orchestrator.
   * Initializes BoxLite runtime, database, and message processing loop.
   * Call this first, then registerChannel/registerGroup dynamically.
   */
  async start(): Promise<void> {
    if (this._started) throw new Error('AgentLite already started');
    this._started = true;

    const main = await import('./index.js');
    this._mainModule = main;

    await main._startFromSDK(this._channels, this._groups);
  }

  /**
   * Register a messaging channel (Telegram, Slack, etc.).
   * Can be called after start() — channel will be connected immediately.
   */
  async registerChannel(channel: Channel): Promise<void> {
    this._channels.push(channel);

    if (this._started && this._mainModule) {
      await this._mainModule._registerChannelFromSDK(channel);
    }
  }

  /**
   * Register a group/chat for the agent to monitor.
   * Only `name` is required — folder, trigger, and timestamps are auto-derived.
   * Can be called after start() — group will be active immediately.
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
      requiresTrigger: options.requiresTrigger ?? (options.isMain ? false : true),
    };

    this._groups.set(jid, group);

    if (this._started && this._mainModule) {
      this._mainModule._registerGroupFromSDK(jid, group);
    }
  }

  /**
   * Stop the orchestrator gracefully.
   */
  async stop(): Promise<void> {
    if (!this._started || !this._mainModule) return;
    await this._mainModule._stopFromSDK();
    this._started = false;
  }
}
