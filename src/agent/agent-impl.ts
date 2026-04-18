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
import type { ZodRawShape } from 'zod';

import { startIpcWatcher } from '../ipc.js';
import { ActionsHttp } from './actions-http.js';
import {
  assertCustomActionName,
  type ActionContext,
  type ActionCallback,
  type RegisteredAction,
} from '../api/action.js';
import { AcpOutboundClient } from '../acp/client.js';
import { ACP_NOTICE_SENDER, ACP_NOTICE_SENDER_NAME } from '../acp/notice.js';
import { startSchedulerLoop } from '../task-scheduler.js';

import path from 'path';
import type { Agent } from '../api/agent.js';
import type { McpServerConfig } from '../api/options.js';
import type { AgentContext } from './agent-context.js';
import type { AgentRegistryDb } from './registry-db.js';
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
  private _registry: AgentRegistryDb | null = null;
  private ipcHandle: { stop(): void } | null = null;
  private schedulerHandle: { stop(): void } | null = null;
  private actions = new Map<string, RegisteredAction>();
  readonly actionsHttp = new ActionsHttp(() => this.actions);
  /** Outbound ACP (Zed Agent Client Protocol) client; null unless opts.acp.peers is set. */
  acpClient: AcpOutboundClient | null = null;

  // ─── Managers ───────────────────────────────────────────────────
  private channelMgr: ChannelManager;
  private groupMgr: GroupManager;
  private taskMgr: TaskManager;
  private messageMgr: MessageProcessor;

  constructor(
    agentConfig: AgentConfig,
    runtimeConfig: RuntimeConfig,
    options?: AgentOptions,
    registry?: AgentRegistryDb,
  ) {
    super();
    this.config = agentConfig;
    this.runtimeConfig = runtimeConfig;
    this._options = options;
    this._registry = registry ?? null;
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

  // ─── Channels ───────────────────────────────────────────────────

  async addChannel(key: string, factory: ChannelDriverFactory): Promise<void> {
    return this.channelMgr.addChannel(key, factory);
  }

  async removeChannel(key: string): Promise<void> {
    return this.channelMgr.removeChannel(key);
  }

  // ─── Groups ─────────────────────────────────────────────────────

  async registerGroup(
    jid: string,
    options: RegisterGroupOptions,
  ): Promise<void> {
    return this.groupMgr.registerGroup(jid, options);
  }

  getRegisteredGroups(): PublicRegisteredGroup[] {
    return this.groupMgr.getRegisteredGroups();
  }

  getGroup(jid: string): PublicRegisteredGroup | undefined {
    return this.groupMgr.getRegisteredGroups().find((g) => g.jid === jid);
  }

  getAvailableGroups(): AvailableGroup[] {
    return this.groupMgr.getAvailableGroups();
  }

  // ─── Messaging ──────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    const sent = await this.channelMgr.sendOutboundMessage(jid, text);
    if (!sent) throw new Error(`No channel for JID: ${jid}`);
  }

  // ─── Scheduled tasks ────────────────────────────────────────────

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

  // ─── Custom actions ─────────────────────────────────────────────

  action(name: string, cb: ActionCallback): this;
  action(name: string, description: string, cb: ActionCallback): this;
  action<Args extends ZodRawShape>(
    name: string,
    inputSchema: Args,
    cb: ActionCallback<Args>,
  ): this;
  action<Args extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Args,
    cb: ActionCallback<Args>,
  ): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action(name: string, ...args: any[]): this {
    assertCustomActionName(name);

    let description: string | undefined;
    let inputSchema: ZodRawShape | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cb: ((...a: any[]) => unknown) | undefined;

    // Walk the remaining args left-to-right matching each overload shape.
    let i = 0;
    if (typeof args[i] === 'string') {
      description = args[i] as string;
      i++;
    }
    if (args[i] !== undefined && typeof args[i] === 'object') {
      inputSchema = args[i] as ZodRawShape;
      i++;
    }
    if (typeof args[i] === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb = args[i] as (...a: any[]) => unknown;
      i++;
    }

    if (!cb) {
      throw new Error(`action("${name}"): missing callback`);
    }

    const handler: RegisteredAction['handler'] = inputSchema
      ? (validatedArgs, ctx) => cb!(validatedArgs, ctx)
      : (_args, ctx) => cb!(ctx);

    const entry: RegisteredAction = { handler };
    if (description !== undefined) entry.description = description;
    if (inputSchema !== undefined) entry.inputSchema = inputSchema;

    this.actions.set(name, entry);
    return this;
  }

  // ─── Instructions Management ──────────────────────────────────

  setInstructions(instructions: string | null): void {
    (this.config as { instructions: string | null }).instructions =
      instructions;
    this.persistAndSync({ instructions });
  }

  getInstructions(): string | null {
    return this.config.instructions;
  }

  // ─── Skill Management ─────────────────────────────────────────

  setSkills(sourcePaths: string[]): void {
    const resolved =
      sourcePaths.length > 0 ? sourcePaths.map((s) => path.resolve(s)) : null;
    (this.config as { skillsSources: typeof resolved }).skillsSources =
      resolved;
    this.persistAndSync({ skillsSources: resolved });
  }

  addSkill(sourcePath: string): void {
    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Skill source is not a directory: ${resolved}`);
    }
    if (!fs.existsSync(path.join(resolved, 'SKILL.md'))) {
      throw new Error(`Skill directory missing SKILL.md: ${resolved}`);
    }
    const current = this.config.skillsSources ?? [];
    if (!current.includes(resolved)) {
      this.setSkills([...current, resolved]);
    }
  }

  removeSkill(name: string): void {
    const current = this.config.skillsSources ?? [];
    this.setSkills(current.filter((s) => path.basename(s) !== name));
  }

  getSkills(): string[] {
    return [...(this.config.skillsSources ?? [])];
  }

  // ─── MCP Server Management ──────────────────────────────────────

  setMcpServers(servers: Record<string, McpServerConfig>): void {
    const resolved =
      Object.keys(servers).length > 0
        ? Object.fromEntries(
            Object.entries(servers).map(([name, cfg]) => [
              name,
              { ...cfg, source: path.resolve(cfg.source) },
            ]),
          )
        : null;
    (this.config as { mcpServers: typeof resolved }).mcpServers = resolved;
    this.persistAndSync({ mcpServers: resolved });
  }

  addMcpServer(name: string, config: McpServerConfig): void {
    const current = this.config.mcpServers ?? {};
    this.setMcpServers({ ...current, [name]: config });
  }

  removeMcpServer(name: string): void {
    const current = { ...(this.config.mcpServers ?? {}) };
    delete current[name];
    this.setMcpServers(current);
  }

  getMcpServers(): Record<string, McpServerConfig> {
    return { ...(this.config.mcpServers ?? {}) };
  }

  // ─── Persist + sync helper ────────────────────────────────────

  private persistAndSync(updates: {
    instructions?: string | null;
    skillsSources?: string[] | null;
    mcpServers?: Record<string, McpServerConfig> | null;
  }): void {
    this._registry?.updateAgent(this.config.agentName, updates);
    if (this._started) {
      this.groupMgr.syncAgentCustomizations();
    }
  }

  // ─── AgentContext: saveState ─────────────────────────────────────

  saveState(): void {
    this.groupMgr.saveState();
  }

  private resolveAcpCallerChatJid(ctx: ActionContext): string {
    if (ctx.jid) {
      const group = this.registeredGroups[ctx.jid];
      if (group?.folder === ctx.sourceGroup) {
        return ctx.jid;
      }
    }

    const matches = Object.entries(this.registeredGroups)
      .filter(([, group]) => group.folder === ctx.sourceGroup)
      .map(([jid]) => jid);

    if (matches.length === 1) {
      return matches[0]!;
    }

    throw new Error(
      `cannot resolve ACP completion notice target for group folder "${ctx.sourceGroup}"`,
    );
  }

  private async injectAcpNotice(jid: string, text: string): Promise<void> {
    const group = this.registeredGroups[jid];
    if (!group) {
      throw new Error(`cannot inject ACP notice for unregistered JID ${jid}`);
    }
    const timestamp = new Date().toISOString();
    this.db.storeChatMetadata(jid, timestamp, group.name);
    this.db.storeMessageDirect({
      id: `acp-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: ACP_NOTICE_SENDER,
      sender_name: ACP_NOTICE_SENDER_NAME,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
    this.queue.enqueueMessageCheck(jid);
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

    await this.actionsHttp.start();
    this.startSubsystems();
    this.emit('started');
  }

  async stop(): Promise<void> {
    this._stopping = true;
    this.ipcHandle?.stop();
    this.schedulerHandle?.stop();
    await this.actionsHttp.stop();
    await this.messageMgr.waitForStop();
    if (this.acpClient) {
      await this.acpClient.shutdown();
    }
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
      emit: this.emit.bind(this) as import('../task-scheduler.js').TaskEventEmitter,
    });

    // Outbound ACP client — only constructed if peers are configured.
    // Registers five `acp_*` HTTP actions that the in-VM model reaches via
    // the existing search_actions / call_action MCP tools.
    const acpPeers = this._options?.acp?.peers ?? [];
    if (acpPeers.length > 0) {
      this.acpClient = new AcpOutboundClient({
        peers: acpPeers,
        groupsDir: this.config.groupsDir,
        dataDir: this.config.dataDir,
        resolveCallerChatJid: (ctx) => this.resolveAcpCallerChatJid(ctx),
        injectNotice: async (jid, text) => this.injectAcpNotice(jid, text),
      });
      this.acpClient.registerActions(this);
    }

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
