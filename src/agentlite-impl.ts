/**
 * AgentLite SDK — implementation module.
 *
 * The public API lives in src/api/sdk.ts. This file contains the
 * implementation class (AgentLiteImpl) and is not directly imported
 * by consumers.
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { buildRuntimeConfig } from './runtime-config.js';
import { buildAgentConfig } from './agent-config.js';
import type { AgentLiteOptions, AgentOptions } from './api/options.js';
import type { Agent } from './api/agent.js';
import type { AgentLite } from './api/sdk.js';

// ─── Impl factory (called by api/sdk.ts) ───────────────────────────

/** @internal — called by api/sdk.ts, not by consumers. */
export async function createAgentLiteImpl(
  options?: AgentLiteOptions,
): Promise<AgentLite> {
  const impl = new AgentLiteImpl(options);
  await impl._init();
  return impl;
}

// ─── Implementation (not exported to consumers) ────────────────────

class AgentLiteImpl implements AgentLite {
  private _agents = new Map<string, Agent>();
  private _agentModule: typeof import('./agent-impl.js') | null = null;
  private _runtimeConfig: ReturnType<typeof buildRuntimeConfig>;
  private _options: AgentLiteOptions;

  constructor(options?: AgentLiteOptions) {
    this._options = options ?? {};
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    this._runtimeConfig = buildRuntimeConfig(this._options, packageRoot);
  }

  get agents(): ReadonlyMap<string, Agent> {
    return this._agents;
  }

  /** @internal */
  async _init(): Promise<void> {
    const boxRuntime = await import('./box-runtime.js');
    boxRuntime.setBoxliteHome(
      path.join(this._runtimeConfig.workdir, '.boxlite'),
    );
    boxRuntime.ensureRuntimeReady();
    this._agentModule = await import('./agent-impl.js');
  }

  createAgent(name: string, options?: AgentOptions): Agent {
    if (!this._agentModule) {
      throw new Error('AgentLite not initialized');
    }
    if (this._agents.has(name)) {
      throw new Error(`Agent "${name}" already exists`);
    }

    const agentConfig = buildAgentConfig(
      name,
      options,
      this._runtimeConfig.workdir,
    );
    const agent = new this._agentModule.AgentImpl(
      agentConfig,
      this._runtimeConfig,
      options,
    );
    this._agents.set(name, agent);
    return agent;
  }

  async deleteAgent(name: string): Promise<void> {
    const agent = this._agents.get(name);
    if (!agent) return;
    await agent.stop();
    this._agents.delete(name);
  }

  async stop(): Promise<void> {
    for (const agent of this._agents.values()) {
      await agent.stop();
    }
    this._agents.clear();
  }
}
