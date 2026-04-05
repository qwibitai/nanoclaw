/**
 * AgentLiteInstance — a named partition within an AgentLite process.
 *
 * Modeled after RocksDB column families: each instance owns its own
 * database, group folders, IPC directories, channels, and message loop.
 * Multiple instances share the same BoxLite runtime and config.
 */

import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  PACKAGE_ROOT,
  IDLE_TIMEOUT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
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
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
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
import { ChannelFactory, ChannelOpts } from './channels/registry.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { ChannelHandler, GroupOptions } from './options.js';
import type { AgentLiteOptions } from './options.js';
import { logger } from './logger.js';

import type { AvailableGroup } from './container-runner.js';

export class AgentLiteInstance {
  readonly name: string;
  readonly instanceRoot: string;
  readonly storeDir: string;
  readonly groupsDir: string;
  readonly dataDir: string;

  // --- Per-instance state (previously module-level in orchestrator.ts) ---
  private lastTimestamp = '';
  private sessions: Record<string, string> = {};
  private _registeredGroups: Record<string, RegisteredGroup> = {};
  private lastAgentTimestamp: Record<string, string> = {};
  private channels: Channel[] = [];
  private queue!: GroupQueue;
  private messageLoopRunning = false;
  private _started = false;

  private _channelHandlerCustomizer:
    | ((defaults: ChannelHandler) => ChannelHandler)
    | undefined;

  // Lazy OneCLI
  private _onecli: any = null;

  // Pre-registered groups and channel factories (before run())
  private _preGroups = new Map<string, RegisteredGroup>();
  private _preChannelFactories: Array<{
    name: string;
    factory: ChannelFactory;
  }> = [];

  private _parentOptions: AgentLiteOptions;

  constructor(name: string, parentOptions: AgentLiteOptions) {
    this.name = name;
    this._parentOptions = parentOptions;

    const projectRoot = path.resolve(parentOptions.workdir ?? process.cwd());
    this.instanceRoot = path.resolve(projectRoot, 'instances', name);
    this.storeDir = path.join(this.instanceRoot, 'store');
    this.groupsDir = path.join(this.instanceRoot, 'groups');
    this.dataDir = path.join(this.instanceRoot, 'data');

    this.queue = new GroupQueue({ dataDir: this.dataDir });
  }

  // --- Public API ---

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

    this._preGroups.set(jid, group);

    if (this._started) {
      setRegisteredGroup(jid, group);
      this._registeredGroups[jid] = group;
      this.ensureOneCLIAgent(jid, group);
      logger.info(
        { jid, name: group.name, folder: group.folder, instance: this.name },
        'Group registered dynamically',
      );
    }
  }

  async registerChannelFactory(
    name: string,
    factory: ChannelFactory,
  ): Promise<boolean> {
    // Before run(): queue for later connection
    if (!this._started) {
      this._preChannelFactories.push({ name, factory });
      return true;
    }

    return this._connectChannelFactory(name, factory);
  }

  private async _connectChannelFactory(
    name: string,
    factory: ChannelFactory,
  ): Promise<boolean> {
    let handler = this.buildDefaultChannelHandler();
    if (this._channelHandlerCustomizer) {
      handler = this._channelHandlerCustomizer(handler);
    }
    const opts: ChannelOpts = handler;

    const channel = factory(opts);
    if (!channel) {
      logger.warn(
        { channel: name, instance: this.name },
        'Factory returned null, skipping',
      );
      return false;
    }

    this.channels.push(channel);
    await channel.connect();
    logger.info(
      { channel: channel.name, instance: this.name },
      'Channel registered',
    );
    return true;
  }

  async run(options?: {
    model?: { credentials?: () => Promise<Record<string, string>> };
    channelHandler?: (builtin: ChannelHandler) => ChannelHandler;
  }): Promise<void> {
    if (this._started)
      throw new Error(`Instance "${this.name}" already running`);
    this._started = true;

    this.copyGroupTemplates();

    // Cleanup orphaned containers scoped to this instance
    await cleanupOrphans(this.name);

    // Configure model credentials for container injection
    if (options?.model) {
      setModelOptions(options.model);
    } else if (this._parentOptions.model) {
      setModelOptions(this._parentOptions.model);
    }

    // Initialize database for this instance
    initDatabase();

    logger.info({ instance: this.name }, 'Database initialized');
    this.loadState();

    // Register pre-provided groups
    for (const [jid, group] of this._preGroups) {
      setRegisteredGroup(jid, group);
      this._registeredGroups[jid] = group;
    }

    // Ensure OneCLI agents exist for all registered groups
    for (const [jid, group] of Object.entries(this._registeredGroups)) {
      this.ensureOneCLIAgent(jid, group);
    }

    restoreRemoteControl();

    // Store channel handler customizer
    this._channelHandlerCustomizer =
      options?.channelHandler ?? this._parentOptions.channelHandler;

    // Connect pre-registered channel factories
    for (const { name, factory } of this._preChannelFactories) {
      await this._connectChannelFactory(name, factory);
    }
    this._preChannelFactories = [];

    if (this.channels.length > 0) {
      logger.info(
        { count: this.channels.length, instance: this.name },
        'Initial channels connected',
      );
    } else {
      logger.info(
        { instance: this.name },
        'No initial channels — waiting for dynamic registration',
      );
    }

    this.startSubsystems();
  }

  async stop(): Promise<void> {
    await this.queue.shutdown(10000);
    for (const ch of this.channels) await ch.disconnect();
    this._started = false;
  }

  // --- Exports for testing ---

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

  /** @internal - exported for testing */
  _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
    this._registeredGroups = groups;
  }

  // --- Internal functions ---

  private async getOneCLI(): Promise<any> {
    if (!this._onecli) {
      try {
        const { OneCLI } = await import('@onecli-sh/sdk');
        this._onecli = new OneCLI({ url: ONECLI_URL });
      } catch {
        logger.debug(
          'OneCLI SDK not installed — credential gateway unavailable',
        );
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
        instance: this.name,
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

  private internalRegisterGroup(jid: string, group: RegisteredGroup): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder, this.groupsDir);
    } catch (err) {
      logger.warn(
        { jid, folder: group.folder, err },
        'Rejecting group registration with invalid folder',
      );
      return;
    }

    this._registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
    this.ensureOneCLIAgent(jid, group);

    logger.info(
      { jid, name: group.name, folder: group.folder, instance: this.name },
      'Group registered',
    );
  }

  /** Handle /remote-control and /remote-control-end commands. */
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

    const channel = findChannel(this.channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        this.instanceRoot,
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
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  /** Build default channel handler with message storage + remote control. */
  private buildDefaultChannelHandler(): ChannelHandler {
    return {
      onMessage: (chatJid: string, msg: NewMessage) => {
        // Remote control commands — intercept before storage
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

  /** Copy default CLAUDE.md templates to group folders. */
  private copyGroupTemplates(): void {
    const templateDir = path.join(PACKAGE_ROOT, 'groups');
    if (!fs.existsSync(templateDir)) return;

    for (const name of ['global', 'main']) {
      const src = path.join(templateDir, name, 'CLAUDE.md');
      const dst = path.join(this.groupsDir, name, 'CLAUDE.md');
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const content = fs.readFileSync(src, 'utf-8');
        fs.writeFileSync(
          dst,
          content.replaceAll('{{ASSISTANT_NAME}}', ASSISTANT_NAME),
        );
      }
    }
  }

  // --- Message processing ---

  private async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this._registeredGroups[chatJid];
    if (!group) return true;

    const channel = findChannel(this.channels, chatJid);
    if (!channel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
    const missedMessages = getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
    );

    if (missedMessages.length === 0) return true;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          TRIGGER_PATTERN.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (!hasTrigger) return true;
    }

    const prompt = formatMessages(missedMessages, TIMEZONE);

    const previousCursor = this.lastAgentTimestamp[chatJid] || '';
    this.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveState();

    logger.info(
      {
        group: group.name,
        messageCount: missedMessages.length,
        instance: this.name,
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
      }, IDLE_TIMEOUT);
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

        if (result.status === 'success') {
          this.queue.notifyIdle(chatJid);
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
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
      this.dataDir,
    );

    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this._registeredGroups)),
      this.dataDir,
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
          assistantName: ASSISTANT_NAME,
          instanceName: this.name,
          groupsDir: this.groupsDir,
          dataDir: this.dataDir,
        },
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

  private async startMessageLoop(): Promise<void> {
    if (this.messageLoopRunning) {
      logger.debug(
        { instance: this.name },
        'Message loop already running, skipping',
      );
      return;
    }
    this.messageLoopRunning = true;

    logger.info(
      { instance: this.name },
      `AgentLite running (trigger: @${ASSISTANT_NAME})`,
    );

    while (true) {
      try {
        const jids = Object.keys(this._registeredGroups);
        const { messages, newTimestamp } = getNewMessages(
          jids,
          this.lastTimestamp,
          ASSISTANT_NAME,
        );

        if (messages.length > 0) {
          logger.info(
            { count: messages.length, instance: this.name },
            'New messages',
          );

          this.lastTimestamp = newTimestamp;
          this.saveState();

          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = this._registeredGroups[chatJid];
            if (!group) continue;

            const channel = findChannel(this.channels, chatJid);
            if (!channel) {
              logger.warn(
                { chatJid },
                'No channel owns JID, skipping messages',
              );
              continue;
            }

            const isMainGroup = group.isMain === true;
            const needsTrigger =
              !isMainGroup && group.requiresTrigger !== false;

            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = groupMessages.some(
                (m) =>
                  TRIGGER_PATTERN.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }

            const allPending = getMessagesSince(
              chatJid,
              this.lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend, TIMEZONE);

            if (this.queue.sendMessage(chatJid, formatted)) {
              logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
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
        logger.error({ err, instance: this.name }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }

  private recoverPendingMessages(): void {
    for (const [chatJid, group] of Object.entries(this._registeredGroups)) {
      const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info(
          {
            group: group.name,
            pendingCount: pending.length,
            instance: this.name,
          },
          'Recovery: found unprocessed messages',
        );
        this.queue.enqueueMessageCheck(chatJid);
      }
    }
  }

  private startSubsystems(): void {
    startSchedulerLoop({
      registeredGroups: () => this._registeredGroups,
      getSessions: () => this.sessions,
      queue: this.queue,
      onProcess: (groupJid, boxName, _containerName, groupFolder) =>
        this.queue.registerBox(groupJid, boxName, groupFolder),
      sendMessage: async (jid, rawText) => {
        const channel = findChannel(this.channels, jid);
        if (!channel) {
          logger.warn({ jid }, 'No channel owns JID, cannot send message');
          return;
        }
        const text = formatOutbound(rawText);
        if (text) await channel.sendMessage(jid, text);
      },
    });
    startIpcWatcher({
      sendMessage: (jid, text) => {
        const channel = findChannel(this.channels, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        return channel.sendMessage(jid, text);
      },
      registeredGroups: () => this._registeredGroups,
      registerGroup: (jid, group) => this.internalRegisterGroup(jid, group),
      syncGroups: async (force: boolean) => {
        await Promise.all(
          this.channels
            .filter((ch) => ch.syncGroups)
            .map((ch) => ch.syncGroups!(force)),
        );
      },
      getAvailableGroups: () => this.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) =>
        writeGroupsSnapshot(gf, im, ag, rj, this.dataDir),
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
            this.dataDir,
          );
        }
      },
    });
    this.queue.setProcessMessagesFn((chatJid) =>
      this.processGroupMessages(chatJid),
    );
    this.recoverPendingMessages();
    this.startMessageLoop().catch((err) => {
      logger.fatal(
        { err, instance: this.name },
        'Message loop crashed unexpectedly',
      );
      throw err;
    });
  }
}
