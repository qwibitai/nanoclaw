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

import type { AgentConfig } from './agent-config.js';
import type { RuntimeConfig } from './runtime-config.js';
import type { AgentOptions } from './api/options.js';
import type {
  ChannelDriver,
  ChannelDriverFactory,
  ChannelDriverConfig,
} from './api/channel-driver.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

import {
  ContainerOutput,
  runContainerAgent,
  setModelOptions,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans } from './box-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeMessage,
  storeChatMetadata,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
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
import type { AvailableGroup } from './container-runner.js';

import type { Agent } from './api/agent.js';

export { type Agent };

// ─── Implementation (used by sdk.ts, not by consumers) ─────────────

export class AgentImpl extends EventEmitter implements Agent {
  readonly config: AgentConfig;
  readonly runtimeConfig: RuntimeConfig;

  // --- Per-agent state ---
  private lastTimestamp = '';
  private sessions: Record<string, string> = {};
  private _registeredGroups: Record<string, RegisteredGroup> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private _channels = new Map<string, Channel>();
  private queue!: GroupQueue;
  private messageLoopRunning = false;
  private _started = false;
  private _onecli: any = null;
  private _options: AgentOptions | undefined;

  constructor(
    agentConfig: AgentConfig,
    runtimeConfig: RuntimeConfig,
    options?: AgentOptions,
  ) {
    super();
    this.config = agentConfig;
    this.runtimeConfig = runtimeConfig;
    this._options = options;
    this.queue = new GroupQueue({
      dataDir: this.config.dataDir,
      maxConcurrent: runtimeConfig.maxConcurrentContainers,
    });
  }

  /** Agent name (the key used in agentlite.createAgent()). */
  get name(): string {
    return this.config.agentName;
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
    const channel: Channel = { name: key, ...driver };
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

  /**
   * Start the agent — initialize DB, connect channels, start message loop.
   */
  async start(): Promise<void> {
    if (this._started) throw new Error(`Agent "${this.name}" already running`);
    this._started = true;

    // Ensure directories exist
    fs.mkdirSync(this.config.storeDir, { recursive: true });
    fs.mkdirSync(this.config.groupsDir, { recursive: true });
    fs.mkdirSync(this.config.dataDir, { recursive: true });

    this.copyGroupTemplates();
    await cleanupOrphans(this.name);

    // Configure model credentials
    if (this.config.credentials) {
      setModelOptions({ credentials: this.config.credentials });
    }

    // Initialize database for this agent
    initDatabase({
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
    await this.queue.shutdown(10000);
    for (const [, channel] of this._channels) {
      await channel.disconnect();
    }
    this._started = false;
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
        storeMessage(msg);
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => this._registeredGroups,
    };
  }

  /** Get the channel array for router compatibility. */
  private get channelArray(): Channel[] {
    return [...this._channels.values()];
  }

  // ─── Internal group management ───────────────────────────────────

  /** @internal Register a group (called by IPC, not by users). */
  registerGroup(jid: string, group: RegisteredGroup): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder, this.config.groupsDir);
    } catch (err) {
      logger.warn(
        { jid, folder: group.folder, err },
        'Rejecting group with invalid folder',
      );
      return;
    }

    this._registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    this.ensureOneCLIAgent(jid, group);
    logger.info(
      { jid, name: group.name, folder: group.folder, agent: this.name },
      'Group registered',
    );
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

  private ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
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
    this.lastTimestamp = getRouterState('last_timestamp') || '';
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this._registeredGroups = getAllRegisteredGroups();
    logger.info(
      {
        groupCount: Object.keys(this._registeredGroups).length,
        agent: this.name,
      },
      'State loaded',
    );
  }

  private saveState(): void {
    setRouterState('last_timestamp', this.lastTimestamp);
    setRouterState(
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
        this.config.workdir,
        this.config.dataDir,
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl(this.config.dataDir);
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
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
    const missedMessages = getMessagesSince(
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
        if (result.result) {
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
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
          }
          resetIdleTimer();
        }
        if (result.status === 'success') this.queue.notifyIdle(chatJid);
        if (result.status === 'error') hadError = true;
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
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionId = this.sessions[group.folder];

    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
      this.config.dataDir,
    );

    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this._registeredGroups)),
      this.config.dataDir,
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            this.sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);
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
          chatJid,
          isMain,
          assistantName: this.config.assistantName,
          instanceName: this.name,
          groupsDir: this.config.groupsDir,
          dataDir: this.config.dataDir,
        },
        this.runtimeConfig,
        (boxName, _containerName) =>
          this.queue.registerBox(chatJid, boxName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        this.sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
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

    while (true) {
      try {
        const jids = Object.keys(this._registeredGroups);
        const { messages, newTimestamp } = getNewMessages(
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

            const allPending = getMessagesSince(
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
      await new Promise((resolve) =>
        setTimeout(resolve, this.runtimeConfig.pollInterval),
      );
    }
  }

  private recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this._registeredGroups)) {
      const pending = getMessagesSince(
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
    const chats = getAllChats();
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

  /** @internal — test helper for setting registered groups directly. */
  _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
    this._registeredGroups = groups;
  }

  // ─── Subsystems ──────────────────────────────────────────────────

  private startSubsystems(): void {
    startSchedulerLoop({
      assistantName: this.config.assistantName,
      schedulerPollInterval: this.runtimeConfig.schedulerPollInterval,
      timezone: this.runtimeConfig.timezone,
      runtimeConfig: this.runtimeConfig,
      registeredGroups: () => this._registeredGroups,
      getSessions: () => this.sessions,
      queue: this.queue,
      onProcess: (groupJid, boxName, _containerName, groupFolder) =>
        this.queue.registerBox(groupJid, boxName, groupFolder),
      sendMessage: async (jid, rawText) => {
        const channel = findChannel(this.channelArray, jid);
        if (!channel) {
          logger.warn({ jid }, 'No channel owns JID, cannot send');
          return;
        }
        const text = formatOutbound(rawText);
        if (text) await channel.sendMessage(jid, text);
      },
    });

    startIpcWatcher({
      dataDir: this.config.dataDir,
      ipcPollInterval: this.runtimeConfig.ipcPollInterval,
      timezone: this.runtimeConfig.timezone,
      sendMessage: (jid, text) => {
        const channel = findChannel(this.channelArray, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        return channel.sendMessage(jid, text);
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
      onTasksChanged: () => {
        const tasks = getAllTasks();
        const taskRows = tasks.map((t) => ({
          id: t.id,
          groupFolder: t.group_folder,
          prompt: t.prompt,
          schedule_type: t.schedule_type,
          schedule_value: t.schedule_value,
          status: t.status,
          next_run: t.next_run,
        }));
        for (const group of Object.values(this._registeredGroups)) {
          writeTasksSnapshot(
            group.folder,
            group.isMain === true,
            taskRows,
            this.config.dataDir,
          );
        }
      },
    });

    this.queue.setProcessMessagesFn((chatJid) =>
      this.processGroupMessages(chatJid),
    );
    this.recoverPendingMessages();
    this.startMessageLoop().catch((err) => {
      logger.fatal({ err, agent: this.name }, 'Message loop crashed');
      throw err;
    });
  }
}
