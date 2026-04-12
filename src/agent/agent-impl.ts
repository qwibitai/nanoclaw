/**
 * AgentImpl — thin orchestrator that delegates to focused managers.
 *
 * Each Agent owns its own workdir, database, channels, and per-chat VMs.
 * Multiple Agents share a BoxLite runtime via the parent AgentLite.
 */

import fs from 'fs';
import { EventEmitter } from 'events';

import type { TypedEmitter } from '../typed-emitter.js';
import type { AgentEvents } from '../api/events.js';
import type { AgentConfig } from './config.js';
import type { RuntimeConfig } from '../runtime-config.js';
import type { AgentOptions, CredentialResolver } from '../api/options.js';
import type {
  AvailableGroup,
  RegisterGroupOptions,
  RegisteredGroup as PublicRegisteredGroup,
} from '../api/group.js';
import type {
  ListTasksOptions,
  ScheduleTaskOptions,
  Task,
  TaskDetails,
  UpdateTaskOptions,
} from '../api/task.js';
import type { ChannelDriverFactory } from '../api/channel-driver.js';
import type {
  Channel,
  MountAllowlist,
  RegisteredGroup as InternalRegisteredGroup,
} from '../types.js';
import { logger } from '../logger.js';

import { cleanupOrphans } from '../box-runtime.js';
import { AgentDb, initDatabase } from '../db.js';
import { resolveMountAllowlist } from '../mount-security.js';
import { GroupQueue } from '../group-queue.js';
import { writeGroupsSnapshot } from '../container-runner.js';
import { startIpcWatcher } from '../ipc.js';
import { startSchedulerLoop } from '../task-scheduler.js';

import type { Agent } from '../api/agent.js';
import type { AgentContext } from './agent-context.js';
import { ChannelManager } from './channel-manager.js';
import { GroupManager } from './group-manager.js';
import { TaskManager } from './task-manager.js';
import { MessageProcessor } from './message-processor.js';

export { type Agent };

// ─── Implementation ─────────────────────────────────────────────────

export class AgentImpl
  extends (EventEmitter as { new (): TypedEmitter<AgentEvents> })
  implements Agent, AgentContext
{
  readonly config: AgentConfig;
  readonly runtimeConfig: RuntimeConfig;

  // ─── Shared mutable state (exposed via AgentContext) ─────────────
  sessions: Record<string, string> = {};
  registeredGroups: Record<string, InternalRegisteredGroup> = {};
  lastAgentTimestamp: Record<string, string> = {};
  lastTimestamp = '';
  channels = new Map<string, Channel>();
  credentialResolver: CredentialResolver | null = null;
  resolvedMountAllowlist: MountAllowlist | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────
  private _started = false;
  private _stopping = false;

  get started(): boolean {
    return this._started;
  }
  get stopping(): boolean {
    return this._stopping;
  }

  // ─── Core subsystems ────────────────────────────────────────────
  db!: AgentDb;
  queue!: GroupQueue;
  private _options: AgentOptions | undefined;
  private ipcHandle: { stop(): void } | null = null;
  private schedulerHandle: { stop(): void } | null = null;

  // ─── Managers ───────────────────────────────────────────────────
  private channelMgr: ChannelManager;
  private groupMgr: GroupManager;
  private taskMgr: TaskManager;
  private messageMgr: MessageProcessor;

  constructor(
    agentConfig: AgentConfig,
    runtimeConfig: RuntimeConfig,
    options?: AgentOptions,
  ) {
    super();
    this.config = agentConfig;
    this.runtimeConfig = runtimeConfig;
    this._options = options;
    this.credentialResolver = options?.credentials ?? null;
    this.queue = new GroupQueue({
      dataDir: this.config.dataDir,
      maxConcurrent: runtimeConfig.maxConcurrentContainers,
    });

    // Create managers with this as the shared context
    this.channelMgr = new ChannelManager(this);
    this.groupMgr = new GroupManager(this);
    this.taskMgr = new TaskManager(this);
    this.messageMgr = new MessageProcessor(
      this,
      this.channelMgr,
      this.groupMgr,
      this.taskMgr,
    );
  }

  // ─── Identity ───────────────────────────────────────────────────

  get id(): string {
    return this.config.agentId;
  }

  get name(): string {
    return this.config.agentName;
  }

  /** @internal — merge runtime-only options for restored agents. */
  mergeRuntimeOptions(opts: AgentOptions | undefined): void {
    if (!opts) return;
    this._options = opts;
    this.credentialResolver = opts.credentials ?? this.credentialResolver;
  }

  // ─── Public API (delegated) ─────────────────────────────────────

  async addChannel(key: string, factory: ChannelDriverFactory): Promise<void> {
    return this.channelMgr.addChannel(key, factory);
  }

  async removeChannel(key: string): Promise<void> {
    return this.channelMgr.removeChannel(key);
  }

  getRegisteredGroups(): PublicRegisteredGroup[] {
    return this.groupMgr.getRegisteredGroups();
  }

  async registerGroup(
    jid: string,
    options: RegisterGroupOptions,
  ): Promise<void> {
    return this.groupMgr.registerGroup(jid, options);
  }

  getAvailableGroups(): AvailableGroup[] {
    return this.groupMgr.getAvailableGroups();
  }

  async scheduleTask(options: ScheduleTaskOptions): Promise<Task> {
    return this.taskMgr.scheduleTask(options);
  }

  listTasks(options?: ListTasksOptions): Task[] {
    return this.taskMgr.listTasks(options);
  }

  getTask(taskId: string): TaskDetails | undefined {
    return this.taskMgr.getTask(taskId);
  }

  async updateTask(taskId: string, updates: UpdateTaskOptions): Promise<Task> {
    return this.taskMgr.updateTask(taskId, updates);
  }

  async pauseTask(taskId: string): Promise<Task> {
    return this.taskMgr.pauseTask(taskId);
  }

  async resumeTask(taskId: string): Promise<Task> {
    return this.taskMgr.resumeTask(taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    return this.taskMgr.cancelTask(taskId);
  }

  // ─── AgentContext: saveState ─────────────────────────────────────

  saveState(): void {
    this.groupMgr.saveState();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._started) throw new Error(`Agent "${this.name}" already running`);
    this._started = true;
    this._stopping = false;

    // Ensure directories exist
    fs.mkdirSync(this.config.storeDir, { recursive: true });
    fs.mkdirSync(this.config.groupsDir, { recursive: true });
    fs.mkdirSync(this.config.dataDir, { recursive: true });

    this.groupMgr.copyGroupTemplates();
    this.groupMgr.syncAgentCustomizations();
    await cleanupOrphans(this.id);

    this.resolvedMountAllowlist = resolveMountAllowlist(
      this.config.mountAllowlist,
    );

    this.db = initDatabase({
      storeDir: this.config.storeDir,
      dataDir: this.config.dataDir,
      assistantName: this.config.assistantName,
    });
    logger.info({ agent: this.name }, 'Database initialized');
    this.groupMgr.loadState();

    this.groupMgr.ensureAllOneCLIAgents();
    this.channelMgr.restoreRemoteControl();

    // Connect initial channels from constructor options
    if (this._options?.channels) {
      for (const [key, factory] of Object.entries(this._options.channels)) {
        await this.channelMgr.addChannel(key, factory);
      }
    }

    if (this.channels.size > 0) {
      logger.info(
        { count: this.channels.size, agent: this.name },
        'Channels connected',
      );
    }

    this.startSubsystems();
    this.emit('started');
  }

  async stop(): Promise<void> {
    this._stopping = true;
    this.ipcHandle?.stop();
    this.schedulerHandle?.stop();
    await this.messageMgr.waitForStop();
    await this.queue.shutdown(10000);
    for (const [, channel] of this.channels) {
      await channel.disconnect();
    }
    this._started = false;
    this.emit('stopped');
  }

  // ─── Subsystem wiring ───────────────────────────────────────────

  private startSubsystems(): void {
    this.schedulerHandle = startSchedulerLoop({
      agentId: this.id,
      assistantName: this.config.assistantName,
      schedulerPollInterval: this.runtimeConfig.schedulerPollInterval,
      timezone: this.runtimeConfig.timezone,
      runtimeConfig: this.runtimeConfig,
      db: this.db,
      workDir: this.config.workDir,
      groupsDir: this.config.groupsDir,
      dataDir: this.config.dataDir,
      credentialResolver: this.credentialResolver ?? undefined,
      mountAllowlist: this.resolvedMountAllowlist,
      registeredGroups: () => this.registeredGroups,
      getSessions: () => this.sessions,
      queue: this.queue,
      onProcess: (groupJid, boxName, _containerName, groupFolder) =>
        this.queue.registerBox(groupJid, boxName, groupFolder),
      sendMessage: async (jid, rawText) => {
        await this.channelMgr.sendOutboundMessage(jid, rawText);
      },
      onStateChange: ({ jid, groupFolder, state, reason, exitCode }) => {
        const group = this.registeredGroups[jid];
        this.emit('run.state', {
          agentId: this.id,
          jid,
          name: group?.name || groupFolder,
          folder: groupFolder,
          state,
          timestamp: new Date().toISOString(),
          reason,
          exitCode,
        });
      },
    });

    this.ipcHandle = startIpcWatcher({
      dataDir: this.config.dataDir,
      ipcPollInterval: this.runtimeConfig.ipcPollInterval,
      timezone: this.runtimeConfig.timezone,
      db: this.db,
      sendMessage: async (jid, text) => {
        const sent = await this.channelMgr.sendOutboundMessage(jid, text);
        if (!sent) throw new Error(`No channel for JID: ${jid}`);
      },
      registeredGroups: () => this.registeredGroups,
      registerGroup: (jid, group) => this.registerGroup(jid, group),
      syncGroups: async (force: boolean) => {
        for (const ch of this.channels.values()) {
          if (ch.syncGroups) await ch.syncGroups(force);
        }
      },
      getAvailableGroups: () => this.groupMgr.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) =>
        writeGroupsSnapshot(gf, im, ag, rj, this.config.dataDir),
      onTasksChanged: () => this.taskMgr.refreshTaskSnapshots(),
    });

    this.queue.setProcessMessagesFn((chatJid) =>
      this.messageMgr.processGroupMessages(chatJid),
    );
    this.messageMgr.recoverPendingMessages();
    this.messageMgr.start();
  }

  // ─── Test helpers & internal access ──────────────────────────────

  /** @internal — delegates to ChannelManager. Used by tests. */
  buildDefaultChannelHandler() {
    return this.channelMgr.buildDriverConfig();
  }

  /** @internal — alias for tests that access the private name. */
  _buildDriverConfig() {
    return this.channelMgr.buildDriverConfig();
  }

  /** @internal — delegates to MessageProcessor. Used by tests. */
  processGroupMessages(chatJid: string): Promise<boolean> {
    return this.messageMgr.processGroupMessages(chatJid);
  }

  /** @internal — delegates to ChannelManager. */
  async sendOutboundMessage(
    jid: string,
    rawText: string,
    channel?: Channel,
  ): Promise<boolean> {
    return this.channelMgr.sendOutboundMessage(jid, rawText, channel);
  }

  /** @internal — test helper for setting registered groups directly. */
  _setRegisteredGroups(groups: Record<string, InternalRegisteredGroup>): void {
    this.registeredGroups = groups;
  }

  /** @internal — test helper for injecting a database directly. */
  _setDbForTests(testDb: AgentDb): void {
    this.db = testDb;
  }
}
