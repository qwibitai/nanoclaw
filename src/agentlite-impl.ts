/**
 * AgentLite SDK — implementation module.
 *
 * The public API lives in src/api/sdk.ts. This file contains the
 * implementation class (AgentLiteImpl) and is not directly imported
 * by consumers.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
  serializeMountAllowlist,
  type SerializableAgentSettings,
} from './agent-config.js';
import {
  getAgentRegistryDbPath,
  initAgentRegistryDb,
  type AgentRegistryDb,
  type AgentRegistryRecord,
} from './agent-registry-db.js';
import { cleanupOrphans } from './box-runtime.js';
import { buildRuntimeConfig } from './runtime-config.js';
import type { AgentLiteOptions, AgentOptions } from './api/options.js';
import type { Agent } from './api/agent.js';
import type { AgentLite } from './api/sdk.js';

interface RuntimeOptionsAwareAgent extends Agent {
  mergeRuntimeOptions(options?: AgentOptions): void;
  readonly config: {
    assistantName: string;
    workDir: string;
    mountAllowlist: import('./types.js').MountAllowlist | null;
  };
}

function toRuntimeOptions(
  record: AgentRegistryRecord,
  options?: AgentOptions,
): AgentOptions {
  return {
    workdir: record.workDir,
    name: record.assistantName,
    mountAllowlist: record.mountAllowlist ?? undefined,
    channels: options?.channels,
    credentials: options?.credentials,
  };
}

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
  private _registry: AgentRegistryDb | null = null;

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

  private get registry(): AgentRegistryDb {
    if (!this._registry) {
      throw new Error('Agent registry not initialized');
    }
    return this._registry;
  }

  /** @internal */
  async _init(): Promise<void> {
    const boxRuntime = await import('./box-runtime.js');
    boxRuntime.setBoxliteHome(
      path.join(this._runtimeConfig.workdir, '.boxlite'),
    );
    boxRuntime.ensureRuntimeReady();
    this._agentModule = await import('./agent-impl.js');
    this._registry = initAgentRegistryDb(this._runtimeConfig.workdir);
    this.restorePersistedAgents();
  }

  createAgent(name: string, options?: AgentOptions): Agent {
    if (!this._agentModule) {
      throw new Error('AgentLite not initialized');
    }
    if (this._agents.has(name) || this.registry.getAgent(name)) {
      throw new Error(`Agent "${name}" already exists`);
    }

    const settings = resolveSerializableAgentSettings(
      name,
      options,
      this._runtimeConfig.workdir,
    );
    const persisted = this.registry.createAgent(settings);

    try {
      const agent = this.instantiateAgent(persisted, options);
      this._agents.set(name, agent);
      return agent;
    } catch (err) {
      this.registry.deleteAgent(name);
      throw err;
    }
  }

  getOrCreateAgent(name: string, options?: AgentOptions): Agent {
    const existing = this._agents.get(name);
    if (existing) {
      const runtimeAgent = existing as RuntimeOptionsAwareAgent;
      this.assertSerializableOptionsMatch(name, runtimeAgent.config, options);
      runtimeAgent.mergeRuntimeOptions(options);
      return existing;
    }

    const persisted = this.registry.getAgent(name);
    if (persisted) {
      this.assertSerializableOptionsMatch(name, persisted, options);
      const agent = this.instantiateAgent(persisted, options);
      this._agents.set(name, agent);
      return agent;
    }

    return this.createAgent(name, options);
  }

  async deleteAgent(name: string): Promise<void> {
    const agent = this._agents.get(name);
    const record = this.registry.getAgent(name);

    if (!agent && !record) {
      return;
    }

    if (agent) {
      await agent.stop();
    }

    const agentId = agent?.id ?? record?.agentId;
    if (agentId) {
      await cleanupOrphans(agentId);
    }

    const workDir = agent
      ? (agent as RuntimeOptionsAwareAgent).config.workDir
      : record?.workDir;
    if (workDir) {
      this.deleteAgentWorkDir(workDir);
    }

    this._agents.delete(name);
    this.registry.deleteAgent(name);
  }

  async stop(): Promise<void> {
    for (const agent of this._agents.values()) {
      await agent.stop();
    }
    this._agents.clear();
  }

  private restorePersistedAgents(): void {
    for (const record of this.registry.listAgents()) {
      this._agents.set(record.agentName, this.instantiateAgent(record));
    }
  }

  private instantiateAgent(
    record: AgentRegistryRecord,
    runtimeOptions?: AgentOptions,
  ): Agent {
    if (!this._agentModule) {
      throw new Error('AgentLite not initialized');
    }

    const agentConfig = buildAgentConfig({
      agentId: record.agentId,
      agentName: record.agentName,
      assistantName: record.assistantName,
      workDir: record.workDir,
      mountAllowlist: record.mountAllowlist,
    });

    return new this._agentModule.AgentImpl(
      agentConfig,
      this._runtimeConfig,
      toRuntimeOptions(record, runtimeOptions),
    );
  }

  private assertSerializableOptionsMatch(
    name: string,
    existing: Pick<
      SerializableAgentSettings,
      'assistantName' | 'workDir' | 'mountAllowlist'
    >,
    options?: AgentOptions,
  ): void {
    if (!options) return;

    if (options.name !== undefined && options.name !== existing.assistantName) {
      throw new Error(
        `Agent "${name}" already exists with assistant name "${existing.assistantName}"`,
      );
    }

    if (
      options.workdir !== undefined &&
      path.resolve(options.workdir) !== existing.workDir
    ) {
      throw new Error(
        `Agent "${name}" already exists with workdir "${existing.workDir}"`,
      );
    }

    if (
      options.mountAllowlist !== undefined &&
      serializeMountAllowlist(options.mountAllowlist) !==
        serializeMountAllowlist(existing.mountAllowlist)
    ) {
      throw new Error(
        `Agent "${name}" already exists with a different mount allowlist`,
      );
    }
  }

  private deleteAgentWorkDir(workDir: string): void {
    const target = path.resolve(workDir);
    const registryDbPath = getAgentRegistryDbPath(this._runtimeConfig.workdir);
    const registryPathFromTarget = path.relative(target, registryDbPath);
    const wouldDeleteSharedRegistry =
      registryPathFromTarget === '' ||
      (!registryPathFromTarget.startsWith('..') &&
        !path.isAbsolute(registryPathFromTarget));

    if (wouldDeleteSharedRegistry) {
      throw new Error(
        `Refusing to delete agent workdir "${target}" because it contains the shared registry`,
      );
    }

    fs.rmSync(target, { recursive: true, force: true });
  }
}
