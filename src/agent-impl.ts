/**
 * Agent — an isolated agent runtime (was: AgentLiteInstance).
 *
 * Each Agent owns its own workdir, database, channels, and per-chat VMs.
 * Multiple Agents share a BoxLite runtime via the parent AgentLite.
 *
 * Public API: addChannel, removeChannel, start, stop + EventEmitter.
 * Groups are managed internally — auto-session model.
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

import type { TypedEmitter } from './typed-emitter.js';
import type { AgentEvents } from './api/events.js';
import type { AgentConfig } from './agent-config.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { AgentOptions, CredentialResolver } from './api/options.js';
import type {
  AvailableGroup,
  RegisterGroupOptions,
  RegisteredGroup as PublicRegisteredGroup,
} from './api/group.js';
import type {
  ListTasksOptions,
  ScheduleTaskOptions,
  Task,
  TaskDetails,
  TaskRun,
  UpdateTaskOptions,
} from './api/task.js';
import type {
  ChannelDriverFactory,
  ChannelDriverConfig,
} from './api/channel-driver.js';
import type {
  Channel,
  NewMessage,
  RegisteredGroup as InternalRegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import { logger } from './logger.js';

import {
  ContainerEvent,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans } from './box-runtime.js';
import { AgentDb, initDatabase } from './db.js';
import { resolveMountAllowlist } from './mount-security.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { computeTaskNextRun, createTaskId } from './task-utils.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';

import type { Agent } from './api/agent.js';

export { type Agent };

function cloneRegisteredGroup(
  jid: string,
  group: InternalRegisteredGroup,
): PublicRegisteredGroup {
  return {
    jid,
    name: group.name,
    folder: group.folder,
    trigger: group.trigger,
    added_at: group.added_at,
    containerConfig: group.containerConfig
      ? {
          ...group.containerConfig,
          additionalMounts: group.containerConfig.additionalMounts?.map(
            (mount) => ({ ...mount }),
          ),
        }
      : undefined,
    requiresTrigger: group.requiresTrigger,
    isMain: group.isMain,
  };
}

function toPublicTask(task: ScheduledTask): Task {
  return {
    id: task.id,
    jid: task.chat_jid,
    groupFolder: task.group_folder,
    prompt: task.prompt,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    contextMode: task.context_mode,
    nextRun: task.next_run,
    lastRun: task.last_run,
    lastResult: task.last_result,
    status: task.status,
    createdAt: task.created_at,
  };
}

function toPublicTaskRun(log: TaskRunLog): TaskRun {
  return {
    runAt: log.run_at,
    durationMs: log.duration_ms,
    status: log.status,
    result: log.result,
    error: log.error,
  };
}

// ─── Implementation (used by sdk.ts, not by consumers) ─────────────

export class AgentImpl
  extends (EventEmitter as { new (): TypedEmitter<AgentEvents> })
  implements Agent
{
  readonly config: AgentConfig;
  readonly runtimeConfig: RuntimeConfig;

  // --- Per-agent state ---
  private lastTimestamp = '';
  private sessions: Record<string, string> = {};
  private _registeredGroups: Record<string, InternalRegisteredGroup> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private _channels = new Map<string, Channel>();
  private queue!: GroupQueue;
  private messageLoopRunning = false;
  private _stopping = false;
  private _messageLoopPromise: Promise<void> | null = null;
  private _wakeLoop: (() => void) | null = null;
  private _started = false;
  private _onecli: any = null;
  private _options: AgentOptions | undefined;
  private credentialResolver: CredentialResolver | null = null;

  // --- Per-agent subsystem handles ---
  private db!: AgentDb;
  private ipcHandle: { stop(): void } | null = null;
  private schedulerHandle: { stop(): void } | null = null;
  private resolvedMountAllowlist: import('./types.js').MountAllowlist | null =
    null;

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
  }

  /** Stable internal nanoid used for runtime identifiers. */
  get id(): string {
    return this.config.agentId;
  }

  /** Agent name (the key used in agentlite.createAgent()). */
  get name(): string {
    return this.config.agentName;
  }

  /** @internal — merge runtime-only options for restored agents. */
  mergeRuntimeOptions(options?: AgentOptions): void {
    if (!options) return;

    const existingChannels = this._options?.channels ?? {};
    const nextChannels = options.channels
      ? { ...existingChannels, ...options.channels }
      : existingChannels;

    this._options = {
      ...this._options,
      channels: nextChannels,
      credentials: options.credentials ?? this.credentialResolver ?? undefined,
    };

    if (options.credentials) {
      this.credentialResolver = options.credentials;
    }
  }

  // ─── Public API ──────────────────────────────────────────────────

  /**
   * Add a channel via factory. Only after start().
   * Calls the factory with SDK config, stores the channel, connects it.
   */
  async addChannel(key: string, factory: ChannelDriverFactory): Promise<void> {
    if (!this._started) {
      throw new Error('Call start() before addChannel()');
    }
    if (this._channels.has(key)) {
      throw new Error(
        `Channel "${key}" already registered on agent "${this.name}"`,
      );
    }
    const config = this._buildDriverConfig();
    const driver = await factory(config);
    // Assign `name` directly — object spread would drop prototype methods on class instances
    const channel = driver as Channel;
    (channel as { name: string }).name = key;
    this._channels.set(key, channel);
    await channel.connect();
    logger.info({ channel: key, agent: this.name }, 'Channel connected');
    this.emit('channel.connected', { key });
  }

  /**
   * Remove a channel. Disconnects it if connected.
   */
  async removeChannel(key: string): Promise<void> {
    const channel = this._channels.get(key);
    if (!channel) return;
    if (channel.isConnected?.()) {
      await channel.disconnect();
    }
    this._channels.delete(key);
    this.emit('channel.disconnected', { key });
  }

  /** Get a snapshot of all registered groups. Only after start(). */
  getRegisteredGroups(): PublicRegisteredGroup[] {
    if (!this._started) {
      throw new Error('Call start() before getRegisteredGroups()');
    }

    return Object.entries(this._registeredGroups).map(([jid, group]) =>
      cloneRegisteredGroup(jid, group),
    );
  }

  /** Schedule a task for a registered group. Only after start(). */
  async scheduleTask(options: ScheduleTaskOptions): Promise<Task> {
    this.requireStartedForTaskApi('scheduleTask');
    this.requireTaskAdminAccess();

    const group = this._registeredGroups[options.jid];
    if (!group) {
      throw new Error(
        `Cannot schedule task: group "${options.jid}" is not registered`,
      );
    }

    const now = new Date().toISOString();
    const taskId = createTaskId();
    const contextMode = options.contextMode === 'group' ? 'group' : 'isolated';
    const nextRun = computeTaskNextRun(
      options.scheduleType,
      options.scheduleValue,
      this.runtimeConfig.timezone,
    );

    this.db.createTask({
      id: taskId,
      group_folder: group.folder,
      chat_jid: options.jid,
      prompt: options.prompt,
      schedule_type: options.scheduleType,
      schedule_value: options.scheduleValue,
      context_mode: contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: now,
    });

    this.refreshTaskSnapshots();

    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** List scheduled tasks. Only after start(). */
  listTasks(options?: ListTasksOptions): Task[] {
    this.requireStartedForTaskApi('listTasks');

    return this.db
      .getAllTasks()
      .filter((task) => {
        if (options?.jid && task.chat_jid !== options.jid) return false;
        if (options?.status && task.status !== options.status) return false;
        return true;
      })
      .map((task) => toPublicTask(task));
  }

  /** Get one scheduled task including run history. Only after start(). */
  getTask(taskId: string): TaskDetails | undefined {
    this.requireStartedForTaskApi('getTask');

    const task = this.db.getTaskById(taskId);
    if (!task) return undefined;

    return {
      ...toPublicTask(task),
      runs: this.db.getTaskRunLogs(taskId).map((log) => toPublicTaskRun(log)),
    };
  }

  /** Update a scheduled task. Only after start(). */
  async updateTask(taskId: string, updates: UpdateTaskOptions): Promise<Task> {
    this.requireStartedForTaskApi('updateTask');
    this.requireTaskAdminAccess();

    const task = this.requireExistingTask(taskId);
    this.requireTaskUpdatable(task, 'update');

    const dbUpdates: Parameters<AgentDb['updateTask']>[1] = {};
    if (updates.prompt !== undefined) dbUpdates.prompt = updates.prompt;
    if (updates.scheduleType !== undefined)
      dbUpdates.schedule_type = updates.scheduleType;
    if (updates.scheduleValue !== undefined)
      dbUpdates.schedule_value = updates.scheduleValue;

    if (
      updates.scheduleType !== undefined ||
      updates.scheduleValue !== undefined
    ) {
      const scheduleType = updates.scheduleType ?? task.schedule_type;
      const scheduleValue = updates.scheduleValue ?? task.schedule_value;
      dbUpdates.next_run = computeTaskNextRun(
        scheduleType,
        scheduleValue,
        this.runtimeConfig.timezone,
      );
    }

    this.db.updateTask(taskId, dbUpdates);
    this.refreshTaskSnapshots();

    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** Pause an active scheduled task. Only after start(). */
  async pauseTask(taskId: string): Promise<Task> {
    this.requireStartedForTaskApi('pauseTask');
    this.requireTaskAdminAccess();

    const task = this.requireExistingTask(taskId);
    if (task.status !== 'active') {
      throw new Error(
        `Cannot pause task "${taskId}" because it is ${task.status}`,
      );
    }

    this.db.updateTask(taskId, { status: 'paused' });
    this.refreshTaskSnapshots();

    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** Resume a paused scheduled task. Only after start(). */
  async resumeTask(taskId: string): Promise<Task> {
    this.requireStartedForTaskApi('resumeTask');
    this.requireTaskAdminAccess();

    const task = this.requireExistingTask(taskId);
    if (task.status !== 'paused') {
      throw new Error(
        `Cannot resume task "${taskId}" because it is ${task.status}`,
      );
    }

    this.db.updateTask(taskId, { status: 'active' });
    this.refreshTaskSnapshots();

    return this.getTaskSnapshotOrThrow(taskId);
  }

  /** Cancel and delete a scheduled task. Only after start(). */
  async cancelTask(taskId: string): Promise<void> {
    this.requireStartedForTaskApi('cancelTask');
    this.requireTaskAdminAccess();

    this.requireExistingTask(taskId);
    this.db.deleteTask(taskId);
    this.refreshTaskSnapshots();
  }

  /**
   * Start the agent — initialize DB, connect channels, start message loop.
   */
  async start(): Promise<void> {
    if (this._started) throw new Error(`Agent "${this.name}" already running`);
    this._started = true;
    this._stopping = false;
    this._messageLoopPromise = null;
    this._wakeLoop = null;

    // Ensure directories exist
    fs.mkdirSync(this.config.storeDir, { recursive: true });
    fs.mkdirSync(this.config.groupsDir, { recursive: true });
    fs.mkdirSync(this.config.dataDir, { recursive: true });

    this.copyGroupTemplates();
    await cleanupOrphans(this.id);

    this.resolvedMountAllowlist = resolveMountAllowlist(
      this.config.mountAllowlist,
    );

    // Initialize database for this agent
    this.db = initDatabase({
      storeDir: this.config.storeDir,
      dataDir: this.config.dataDir,
      assistantName: this.config.assistantName,
    });
    logger.info({ agent: this.name }, 'Database initialized');
    this.loadState();

    // Ensure OneCLI agents for registered groups
    for (const [jid, group] of Object.entries(this._registeredGroups)) {
      this.ensureOneCLIAgent(jid, group);
    }

    restoreRemoteControl(this.config.dataDir);

    // Connect initial channels from constructor options via factories
    if (this._options?.channels) {
      for (const [key, factory] of Object.entries(this._options.channels)) {
        await this.addChannel(key, factory);
      }
    }

    if (this._channels.size > 0) {
      logger.info(
        { count: this._channels.size, agent: this.name },
        'Channels connected',
      );
    }

    this.startSubsystems();
    this.emit('started');
  }

  /**
   * Stop the agent — disconnect channels, stop message loop.
   */
  async stop(): Promise<void> {
    this._stopping = true;
    this._wakeLoop?.();
    this.ipcHandle?.stop();
    this.schedulerHandle?.stop();
    await this._messageLoopPromise;
    await this.queue.shutdown(10000);
    for (const [, channel] of this._channels) {
      await channel.disconnect();
    }
    // DB intentionally not closed — detached boxes may still write
    // session/task state after shutdown. Handle is GC'd with the agent.
    this._started = false;
    this.messageLoopRunning = false;
    this.emit('stopped');
  }

  // ─── Channel helpers ─────────────────────────────────────────────

  /** Build the config object passed to ChannelDriverFactory. */
  private _buildDriverConfig(): ChannelDriverConfig {
    const handler = this.buildDefaultChannelHandler();
    return {
      onMessage: handler.onMessage as ChannelDriverConfig['onMessage'],
      onChatMetadata: handler.onChatMetadata,
      registeredGroups: handler.registeredGroups as () => Record<
        string,
        unknown
      >,
    };
  }

  /** Build default channel handler — stores messages, intercepts remote control. */
  private buildDefaultChannelHandler() {
    return {
      onMessage: (chatJid: string, msg: NewMessage) => {
        const trimmed = msg.content.trim();
        if (
          trimmed === '/remote-control' ||
          trimmed === '/remote-control-end'
        ) {
          this.handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
            logger.error({ err, chatJid }, 'Remote control command error'),
          );
          return;
        }

        if (
          !msg.is_from_me &&
          !msg.is_bot_message &&
          this._registeredGroups[chatJid]
        ) {
          const cfg = loadSenderAllowlist();
          if (
            shouldDropMessage(chatJid, cfg) &&
            !isSenderAllowed(chatJid, msg.sender, cfg)
          ) {
            return;
          }
        }
        this.db.storeMessage(msg);
        this.emit('message.in', {
          jid: chatJid,
          sender: msg.sender,
          text: msg.content,
          timestamp: msg.timestamp,
        });
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => {
        this.db.storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
        this.emit('chat.metadata', {
          jid: chatJid,
          timestamp,
          name,
          channel,
          isGroup,
        });
      },
      registeredGroups: () => this._registeredGroups,
    };
  }

  /** Get the channel array for router compatibility. */
  private get channelArray(): Channel[] {
    return [...this._channels.values()];
  }

  private async sendOutboundMessage(
    jid: string,
    rawText: string,
    channel?: Channel,
  ): Promise<boolean> {
    const targetChannel = channel ?? findChannel(this.channelArray, jid);
    if (!targetChannel) {
      logger.warn({ jid }, 'No channel owns JID, cannot send');
      return false;
    }

    const text = formatOutbound(rawText);
    if (!text) return false;

    await targetChannel.sendMessage(jid, text);
    this.emit('message.out', {
      jid,
      text,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // ─── Group management ────────────────────────────────────────────

  /** Register a group for message processing. Only after start(). */
  async registerGroup(
    jid: string,
    options: RegisterGroupOptions,
  ): Promise<void> {
    if (!this._started) throw new Error('Call start() before registerGroup()');

    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(options.folder, this.config.groupsDir);
    } catch (err) {
      logger.warn(
        { jid, folder: options.folder, err },
        'Rejecting group with invalid folder',
      );
      return;
    }

    const group: InternalRegisteredGroup = {
      name: options.name,
      folder: options.folder,
      trigger: options.trigger,
      added_at: new Date().toISOString(),
      containerConfig: options.containerConfig,
      requiresTrigger: options.requiresTrigger,
      isMain: options.isMain,
    };

    this._registeredGroups[jid] = group;
    this.db.setRegisteredGroup(jid, group);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    this.ensureOneCLIAgent(jid, group);
    logger.info(
      { jid, name: group.name, folder: group.folder, agent: this.name },
      'Group registered',
    );
    this.emit('group.registered', {
      jid,
      name: group.name,
      folder: group.folder,
    });
  }

  // ─── OneCLI ──────────────────────────────────────────────────────

  private async getOneCLI(): Promise<any> {
    if (!this._onecli) {
      try {
        const { OneCLI } = await import('@onecli-sh/sdk');
        this._onecli = new OneCLI({ url: this.runtimeConfig.onecliUrl });
      } catch {
        logger.debug('OneCLI SDK not installed');
        return null;
      }
    }
    return this._onecli;
  }

  private ensureOneCLIAgent(jid: string, group: InternalRegisteredGroup): void {
    if (group.isMain) return;
    const identifier = group.folder.toLowerCase().replace(/_/g, '-');
    this.getOneCLI().then((onecli) => {
      if (!onecli) return;
      onecli.ensureAgent({ name: group.name, identifier }).then(
        (res: { created: boolean }) => {
          logger.info(
            { jid, identifier, created: res.created },
            'OneCLI agent ensured',
          );
        },
        (err: unknown) => {
          logger.debug(
            { jid, identifier, err: String(err) },
            'OneCLI agent ensure skipped',
          );
        },
      );
    });
  }

  // ─── State ───────────────────────────────────────────────────────

  private loadState(): void {
    this.lastTimestamp = this.db.getRouterState('last_timestamp') || '';
    const agentTs = this.db.getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = this.db.getAllSessions();
    this._registeredGroups = this.db.getAllRegisteredGroups();
    logger.info(
      {
        groupCount: Object.keys(this._registeredGroups).length,
        agent: this.name,
      },
      'State loaded',
    );
  }

  private saveState(): void {
    this.db.setRouterState('last_timestamp', this.lastTimestamp);
    this.db.setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  private copyGroupTemplates(): void {
    const templateDir = path.join(this.runtimeConfig.packageRoot, 'groups');
    if (!fs.existsSync(templateDir)) return;

    for (const name of ['global', 'main']) {
      const src = path.join(templateDir, name, 'CLAUDE.md');
      const dst = path.join(this.config.groupsDir, name, 'CLAUDE.md');
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const content = fs.readFileSync(src, 'utf-8');
        fs.writeFileSync(
          dst,
          content.replaceAll('{{ASSISTANT_NAME}}', this.config.assistantName),
        );
      }
    }
  }

  // ─── Remote control ──────────────────────────────────────────────

  private async handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = this._registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(this.channelArray, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        this.config.workDir,
        this.config.dataDir,
      );
      if (result.ok) {
        await this.sendOutboundMessage(chatJid, result.url, channel);
      } else {
        await this.sendOutboundMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
          channel,
        );
      }
    } else {
      const result = stopRemoteControl(this.config.dataDir);
      if (result.ok) {
        await this.sendOutboundMessage(
          chatJid,
          'Remote Control session ended.',
          channel,
        );
      } else {
        await this.sendOutboundMessage(chatJid, result.error, channel);
      }
    }
  }

  // ─── Message processing ──────────────────────────────────────────

  private async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this._registeredGroups[chatJid];
    if (!group) return true;

    const channel = findChannel(this.channelArray, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;
    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
    const missedMessages = this.db.getMessagesSince(
      chatJid,
      sinceTimestamp,
      this.config.assistantName,
    );

    if (missedMessages.length === 0) return true;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          this.config.triggerPattern.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (!hasTrigger) return true;
    }

    const prompt = formatMessages(missedMessages, this.runtimeConfig.timezone);

    const previousCursor = this.lastAgentTimestamp[chatJid] || '';
    this.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveState();

    logger.info(
      {
        group: group.name,
        messageCount: missedMessages.length,
        agent: this.name,
      },
      'Processing messages',
    );

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        this.queue.closeStdin(chatJid);
      }, this.runtimeConfig.idleTimeout);
    };

    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;

    const output = await this.runAgent(
      group,
      prompt,
      chatJid,
      async (result) => {
        if (result.type === 'state') {
          this.emit('run.state', {
            agentId: this.id,
            jid: chatJid,
            name: group.name,
            folder: group.folder,
            state: result.state,
            timestamp: new Date().toISOString(),
            reason: result.reason,
            exitCode: result.exitCode,
          });
          if (result.state === 'idle') this.queue.notifyIdle(chatJid);
          return;
        }

        if (result.type === 'result' && result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            outputSentToUser = await this.sendOutboundMessage(
              chatJid,
              raw,
              channel,
            );
          }
          resetIdleTimer();
        }
        if (result.type === 'error') hadError = true;
      },
    );

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output sent, skipping cursor rollback',
        );
        return true;
      }
      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back cursor for retry',
      );
      return false;
    }

    return true;
  }

  private async runAgent(
    group: InternalRegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerEvent) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionId = this.sessions[group.folder];

    this.refreshTaskSnapshots();

    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this._registeredGroups)),
      this.config.dataDir,
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerEvent) => {
          if (output.newSessionId) {
            this.sessions[group.folder] = output.newSessionId;
            this.db.setSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          workDir: this.config.workDir,
          chatJid,
          isMain,
          assistantName: this.config.assistantName,
          agentId: this.id,
          groupsDir: this.config.groupsDir,
          dataDir: this.config.dataDir,
          credentialResolver: this.credentialResolver ?? undefined,
          mountAllowlist: this.resolvedMountAllowlist,
        },
        this.runtimeConfig,
        (boxName, _containerName) =>
          this.queue.registerBox(chatJid, boxName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        this.sessions[group.folder] = output.newSessionId;
        this.db.setSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }
      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  // ─── Message loop ────────────────────────────────────────────────

  private async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) return;
    this.messageLoopRunning = true;

    logger.info(
      { agent: this.name },
      `Agent running (trigger: @${this.config.assistantName})`,
    );

    while (!this._stopping) {
      try {
        const jids = Object.keys(this._registeredGroups);
        const { messages, newTimestamp } = this.db.getNewMessages(
          jids,
          this.lastTimestamp,
          this.config.assistantName,
        );

        if (messages.length > 0) {
          logger.info(
            { count: messages.length, agent: this.name },
            'New messages',
          );
          this.lastTimestamp = newTimestamp;
          this.saveState();

          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) existing.push(msg);
            else messagesByGroup.set(msg.chat_jid, [msg]);
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = this._registeredGroups[chatJid];
            if (!group) continue;

            const channel = findChannel(this.channelArray, chatJid);
            if (!channel) {
              logger.warn({ chatJid }, 'No channel owns JID, skipping');
              continue;
            }

            const needsTrigger =
              !group.isMain && group.requiresTrigger !== false;
            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  this.config.triggerPattern.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            const allPending = this.db.getMessagesSince(
              chatJid,
              this.lastAgentTimestamp[chatJid] || '',
              this.config.assistantName,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(
              messagesToSend,
              this.runtimeConfig.timezone,
            );

            if (this.queue.sendMessage(chatJid, formatted)) {
              this.lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              this.saveState();
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to set typing indicator',
                  ),
                );
            } else {
              this.queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      } catch (err) {
        logger.error({ err, agent: this.name }, 'Error in message loop');
      }
      await new Promise<void>((resolve) => {
        this._wakeLoop = resolve;
        setTimeout(resolve, this.runtimeConfig.pollInterval);
      });
      this._wakeLoop = null;
    }
  }

  private recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this._registeredGroups)) {
      const pending = this.db.getMessagesSince(
        chatJid,
        this.lastAgentTimestamp[chatJid] || '',
        this.config.assistantName,
      );
      if (pending.length > 0) {
        logger.info(
          { group: group.name, pendingCount: pending.length, agent: this.name },
          'Recovery: unprocessed messages',
        );
        this.queue.enqueueMessageCheck(chatJid);
      }
    }
  }

  getAvailableGroups(): AvailableGroup[] {
    if (!this._started) {
      throw new Error('Call start() before getAvailableGroups()');
    }

    const chats = this.db.getAllChats();
    const registeredJids = new Set(Object.keys(this._registeredGroups));
    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.is_group)
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  private requireStartedForTaskApi(methodName: string): void {
    if (!this._started) {
      throw new Error(`Call start() before ${methodName}()`);
    }
  }

  private requireTaskAdminAccess(): void {
    const hasMainGroup = Object.values(this._registeredGroups).some(
      (group) => group.isMain === true,
    );
    if (!hasMainGroup) {
      throw new Error('Task admin requires at least one registered main group');
    }
  }

  private requireExistingTask(taskId: string): ScheduledTask {
    const task = this.db.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    return task;
  }

  private requireTaskUpdatable(task: ScheduledTask, operation: 'update'): void {
    if (task.status === 'completed') {
      throw new Error(`Cannot ${operation} completed task "${task.id}"`);
    }
  }

  private getTaskSnapshotOrThrow(taskId: string): Task {
    const task = this.db.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }
    return toPublicTask(task);
  }

  private refreshTaskSnapshots(): void {
    const taskRows = this.db.getAllTasks().map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    }));

    for (const group of Object.values(this._registeredGroups)) {
      writeTasksSnapshot(
        group.folder,
        group.isMain === true,
        taskRows,
        this.config.dataDir,
      );
    }
  }

  /** @internal — test helper for setting registered groups directly. */
  _setRegisteredGroups(groups: Record<string, InternalRegisteredGroup>): void {
    this._registeredGroups = groups;
  }

  /** @internal — test helper for injecting a database directly. */
  _setDbForTests(testDb: AgentDb): void {
    this.db = testDb;
  }

  // ─── Subsystems ──────────────────────────────────────────────────

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
      registeredGroups: () => this._registeredGroups,
      getSessions: () => this.sessions,
      queue: this.queue,
      onProcess: (groupJid, boxName, _containerName, groupFolder) =>
        this.queue.registerBox(groupJid, boxName, groupFolder),
      sendMessage: async (jid, rawText) => {
        await this.sendOutboundMessage(jid, rawText);
      },
      onStateChange: ({
        jid,
        groupFolder,
        state,
        reason,
        exitCode,
      }) => {
        const group = this._registeredGroups[jid];
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
        const sent = await this.sendOutboundMessage(jid, text);
        if (!sent) throw new Error(`No channel for JID: ${jid}`);
      },
      registeredGroups: () => this._registeredGroups,
      registerGroup: (jid, group) => this.registerGroup(jid, group),
      syncGroups: async (force: boolean) => {
        for (const ch of this._channels.values()) {
          if (ch.syncGroups) await ch.syncGroups(force);
        }
      },
      getAvailableGroups: () => this.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) =>
        writeGroupsSnapshot(gf, im, ag, rj, this.config.dataDir),
      onTasksChanged: () => this.refreshTaskSnapshots(),
    });

    this.queue.setProcessMessagesFn((chatJid) =>
      this.processGroupMessages(chatJid),
    );
    this.recoverPendingMessages();
    this._messageLoopPromise = this.startMessageLoop().catch((err) => {
      logger.fatal({ err, agent: this.name }, 'Message loop crashed');
      throw err;
    });
  }
}
