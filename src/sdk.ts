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
 *
 * const agent = new AgentLite({ workdir: './agentlite-data' });
 * await agent.start();
 *
 * const instance = agent.createInstance('main');
 * await instance.registerChannelFactory('telegram', (opts) =>
 *   new TelegramChannel({ token: '123:ABC', channelOptions: opts })
 * );
 * instance.registerGroup('tg:7123844036', { name: 'Main', isMain: true });
 * await instance.run();
 * ```
 */

import path from 'path';

import { applyConfig, getProjectRoot } from './config.js';
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
// Re-export AgentLiteInstance type for consumers
export type { AgentLiteInstance } from './instance.js';

export class AgentLite {
  private _started = false;
  private _instances = new Map<
    string,
    InstanceType<typeof import('./instance.js').AgentLiteInstance>
  >();
  private _instanceModule: typeof import('./instance.js') | null = null;
  private _options: AgentLiteOptions;

  constructor(options?: AgentLiteOptions) {
    this._options = options ?? {};
  }

  /**
   * Initialize shared infrastructure: config, BoxLite runtime.
   * Call this before createInstance(). Native modules load here.
   */
  async start(): Promise<void> {
    if (this._started) throw new Error('AgentLite already started');
    this._started = true;

    // Apply config — sets PROJECT_ROOT, STORE_DIR, etc. for shared defaults
    applyConfig(this._options);

    // Dynamic import — native deps load here, not at import time
    const boxRuntime = await import('./box-runtime.js');
    boxRuntime.setBoxliteHome(path.join(getProjectRoot(), '.boxlite'));
    boxRuntime.ensureRuntimeReady();

    // Pre-load instance module (also loads native deps)
    this._instanceModule = await import('./instance.js');
  }

  /**
   * Create a named instance (like a RocksDB column family).
   * Each instance has its own DB, groups, channels, and message loop.
   */
  createInstance(name: string): import('./instance.js').AgentLiteInstance {
    if (!this._started || !this._instanceModule) {
      throw new Error('Call start() before createInstance()');
    }
    if (this._instances.has(name)) {
      throw new Error(`Instance "${name}" already exists`);
    }

    const instance = new this._instanceModule.AgentLiteInstance(
      name,
      this._options,
    );
    this._instances.set(name, instance);
    return instance;
  }

  /**
   * Stop all instances and shared infrastructure.
   */
  async stop(): Promise<void> {
    for (const inst of this._instances.values()) {
      await inst.stop();
    }
    this._instances.clear();
    this._started = false;
  }
}
