import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { OneCLI } from '@onecli-sh/sdk';

import {
  getMemoryQueue,
  injectMemory,
  isMemoryEnabled,
} from './memory/index.js';
import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  detectRateLimit,
  rotateAccount,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getChatName,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  getRotateEnabled,
  setRotateEnabled,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
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
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * 自动注册未注册的群聊。从 chat metadata 中取名称，生成合法的 folder name，
 * 以 requiresTrigger: true 注册，这样必须 @触发 才会响应。
 * 返回是否成功注册。
 */
function autoRegisterGroup(chatJid: string): boolean {
  if (registeredGroups[chatJid]) return false;

  const chatName = getChatName(chatJid);
  if (!chatName) {
    logger.debug({ chatJid }, '自动注册跳过：找不到群名');
    return false;
  }

  // 从群名生成 folder name：去除非法字符，截断到 64 字符
  let folder = chatName
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);

  // 确保 folder 以字母或数字开头
  if (!folder || !/^[A-Za-z0-9]/.test(folder)) {
    folder = `grp_${folder || chatJid.replace(/[^A-Za-z0-9]/g, '').slice(0, 50)}`;
  }

  if (!isValidGroupFolder(folder)) {
    logger.warn({ chatJid, folder }, '自动注册失败：生成的 folder name 不合法');
    return false;
  }

  // 检查 folder 是否已被其他群占用
  const folderInUse = Object.values(registeredGroups).some(
    (g) => g.folder === folder,
  );
  if (folderInUse) {
    // 追加 JID hash 后缀避免冲突
    const suffix = chatJid.replace(/[^A-Za-z0-9]/g, '').slice(-6);
    folder = `${folder.slice(0, 57)}_${suffix}`;
    if (!isValidGroupFolder(folder)) {
      logger.warn({ chatJid, folder }, '自动注册失败：去重后 folder 不合法');
      return false;
    }
  }

  const group: RegisteredGroup = {
    name: chatName,
    folder,
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    requiresTrigger: true,
  };

  registerGroup(chatJid, group);
  logger.info({ chatJid, name: chatName, folder }, '群聊已自动注册');
  return true;
}

/**
 * 处理 /trigger 和 /notrigger 指令，切换群的 requiresTrigger 状态。
 * 返回要发送给用户的确认消息，如果不适用则返回 null。
 */
function handleTriggerToggle(
  chatJid: string,
  command: '/trigger' | '/notrigger',
): string | null {
  const group = registeredGroups[chatJid];
  if (!group) return null;
  if (group.isMain) return null; // main group 不需要 trigger

  const wantTrigger = command === '/trigger';
  if (group.requiresTrigger === wantTrigger) {
    return wantTrigger
      ? `已经是 @触发 模式，发消息需要 ${group.trigger || DEFAULT_TRIGGER} 开头`
      : '已经是免@模式，所有消息都会被处理';
  }

  group.requiresTrigger = wantTrigger;
  registeredGroups[chatJid] = group;
  setRegisteredGroup(chatJid, group);

  logger.info(
    { chatJid, name: group.name, requiresTrigger: wantTrigger },
    'Trigger mode toggled',
  );

  return wantTrigger
    ? `已切换到 @触发 模式，发消息需要 ${group.trigger || DEFAULT_TRIGGER} 开头`
    : '已切换到免@模式，所有消息都会被处理';
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

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
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // R8.1: 收集 Agent 回复文本（用于记忆更新）
  const agentReplies: string[] = [];

  // 取最后一条用户消息用于记忆召回
  const lastUserMsg = [...missedMessages]
    .reverse()
    .find((m) => !m.is_bot_message && !m.is_from_me);
  const latestUserMessage = lastUserMsg?.content;
  const memorySenderId = lastUserMsg?.sender || '';

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // 进度消息 — 转发给 channel 显示进度卡片
      if (result.status === 'progress' && result.result) {
        const payload = result.detail
          ? JSON.stringify({ title: result.result, detail: result.detail })
          : result.result;
        await channel.sendMessage(chatJid, payload);
        return;
      }

      // 传递 usage 数据到飞书 channel（在发送文本回复之前）
      if (result.usage && 'setUsage' in channel) {
        (
          channel as {
            setUsage: (jid: string, usage: typeof result.usage) => void;
          }
        ).setUsage(chatJid, result.usage);
      }

      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.setTyping?.(chatJid, false);
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
          agentReplies.push(text);
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    latestUserMessage,
    memorySenderId,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // 轮换通知
  if (output.rotatedTo) {
    channel
      .sendMessage(chatJid, `🔄 账号已自动切换到 ${output.rotatedTo}`)
      .catch(() => {});
  }
  if (output.allExhausted) {
    channel
      .sendMessage(chatJid, '⚠️ 所有账号配额已耗尽，请等待恢复或添加新账号')
      .catch(() => {});
  }

  if (output.status === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // R8.1: 对话完成后，收集 Agent 回复 + 用户消息一起入队记忆更新
  if (isMemoryEnabled()) {
    const memoryMessages = [
      ...missedMessages.map((m) => ({
        content: m.content,
        sender_name: m.sender_name,
        is_bot_message: m.is_bot_message,
        is_from_me: m.is_from_me,
      })),
      ...agentReplies.map((text) => ({
        content: text,
        is_bot_message: true,
      })),
    ];
    getMemoryQueue().add(
      group.folder,
      memoryMessages,
      sessions[group.folder],
      memorySenderId,
    );
  }

  return true;
}

interface RunAgentResult {
  status: 'success' | 'error';
  rotatedTo?: string; // 轮换到的新 secret 名称（用于通知用户）
  allExhausted?: boolean; // 所有账号配额耗尽
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  latestUserMessage?: string,
  memorySenderId?: string,
  isRetry?: boolean,
): Promise<RunAgentResult> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // R8.2: 启动容器前注入记忆
  if (isMemoryEnabled()) {
    try {
      const groupDir = resolveGroupFolderPath(group.folder);
      await injectMemory(
        group.folder,
        groupDir,
        latestUserMessage,
        memorySenderId,
      );
    } catch (err) {
      logger.warn({ err, group: group.name }, '记忆注入失败，继续启动容器');
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
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
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      // 429 检测 + 自动轮换
      if (!isRetry && output.error && detectRateLimit(output.error)) {
        const agentId = group.folder.toLowerCase().replace(/_/g, '-');
        const rotateResult = rotateAccount(agentId);

        if (rotateResult && !rotateResult.success) {
          // 所有账号耗尽
          logger.warn({ group: group.name }, '所有账号配额已耗尽');
          return { status: 'error', allExhausted: true };
        }

        if (rotateResult && rotateResult.success) {
          // 清除 session，用新 token 重试
          delete sessions[group.folder];
          deleteSession(group.folder);
          logger.info(
            { group: group.name, newSecret: rotateResult.newSecretName },
            '429 检测到，已轮换账号，重试中',
          );
          return runAgent(
            group,
            prompt,
            chatJid,
            onOutput,
            latestUserMessage,
            memorySenderId,
            true,
          ).then((retryResult) => ({
            ...retryResult,
            rotatedTo: rotateResult.newSecretName,
          }));
        }
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return { status: 'error' };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error' };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  // 启动飞书 OAuth 回调 server（用户点击授权卡片后的回调）
  try {
    const { startOAuthCallbackServer } =
      await import('./channels/feishu-oauth.js');
    startOAuthCallbackServer(async ({ openId, chatJid }) => {
      logger.info({ openId, chatJid }, '飞书 OAuth 授权成功回调');
      const channel = findChannel(channels, chatJid);
      if (channel) {
        await channel.sendMessage(
          chatJid,
          '✅ 飞书文档授权成功！后续文档操作将使用你的权限。',
        );
        logger.info({ chatJid }, '飞书授权成功通知已发送');
      } else {
        logger.warn({ chatJid }, '飞书授权成功但找不到对应 channel');
      }
    });
  } catch (err) {
    logger.warn({ err }, '飞书 OAuth server 启动失败');
  }

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
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
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Initialize memory system (if enabled)
  if (isMemoryEnabled()) {
    getMemoryQueue();
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // R8.4: flush pending memory updates before shutdown
    if (isMemoryEnabled()) {
      await getMemoryQueue().flush();
    }
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
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

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // 剥离 trigger 前缀（如 "@Andy "）以匹配 slash 命令
      const rawContent = msg.content.trim();
      let trimmed = rawContent;
      const group = registeredGroups[chatJid];
      if (group) {
        const triggerPattern = getTriggerPattern(group.trigger);
        trimmed = trimmed.replace(triggerPattern, '').trim();
      }

      // Remote control commands — intercept before storage
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // /help 指令 — 列出所有可用命令
      if (trimmed === '/help') {
        const ch = findChannel(channels, chatJid);
        const help = [
          '可用命令：',
          '',
          '/help — 显示此帮助',
          '/clear — 清除当前 session，开始新对话（记忆保留）',
          '/account — 列出所有 Anthropic 账号及当前绑定',
          '/account <name> — 切换到指定账号',
          '/account auto on|off — 开关自动轮换（429 时自动切换）',
          '/trigger — 开启 @触发模式（群聊需 @机器人才响应）',
          '/notrigger — 关闭 @触发模式（群聊中所有消息都响应）',
          '/remote-control — 启动 Claude Code 远程控制会话',
          '/remote-control-end — 结束远程控制会话',
          '/llmlog on|off|status — 开关 LLM 完整请求日志（会话级，重启后重置）',
        ].join('\n');
        ch?.sendMessage(chatJid, help).catch((err) =>
          logger.error({ err }, '/help reply failed'),
        );
        return;
      }

      // /clear 指令 — 清除 session，开始新对话（对齐 Claude Code /clear）
      if (trimmed === '/clear') {
        const group = registeredGroups[chatJid];
        if (group) {
          delete sessions[group.folder];
          deleteSession(group.folder);
          // /clear 时同步重置 llmlog 开关
          try { fs.unlinkSync(path.join(GROUPS_DIR, group.folder, '.llmlog_enabled')); } catch { /* ignore */ }
          logger.info({ group: group.folder }, '/clear: session 已清除');
          const ch = findChannel(channels, chatJid);
          ch?.sendMessage(
            chatJid,
            '对话已清除，下次消息将开始新 session。记忆保留。',
          ).catch((err) =>
            logger.error({ err }, 'Failed to send /clear reply'),
          );
        }
        return;
      }

      // /account 指令 — 切换 Anthropic 账号
      if (trimmed === '/account' || trimmed.startsWith('/account ')) {
        const arg = trimmed.slice('/account'.length).trim();
        const ch = findChannel(channels, chatJid);
        logger.info(
          { chatJid, arg, hasCh: !!ch, trimmed },
          '/account 命令匹配',
        );
        try {
          if (arg === 'auto on') {
            setRotateEnabled(true);
            ch?.sendMessage(chatJid, '🔄 自动轮换已开启').catch(() => {});
            logger.info('/account auto on');
          } else if (arg === 'auto off') {
            setRotateEnabled(false);
            ch?.sendMessage(chatJid, '🔄 自动轮换已关闭').catch(() => {});
            logger.info('/account auto off');
          } else if (!arg) {
            // 列出所有 secrets

            const secrets = JSON.parse(
              execSync('onecli secrets list', {
                encoding: 'utf-8',
                timeout: 5000,
              }),
            ) as Array<{ id: string; name: string; type: string }>;
            const agents = JSON.parse(
              execSync('onecli agents list', {
                encoding: 'utf-8',
                timeout: 5000,
              }),
            ) as Array<{
              id: string;
              name: string;
              identifier: string;
              secretMode: string;
            }>;

            // 找当前群对应的 agent
            const group = registeredGroups[chatJid];
            const agentId =
              group?.folder.toLowerCase().replace(/_/g, '-') || '';
            const currentAgent =
              agents.find((a) => a.identifier === agentId) ||
              agents.find((a) => 'isDefault' in a && a.isDefault);

            // 获取当前 agent 绑定的 secrets
            let assignedSecretIds: string[] = [];
            if (currentAgent) {
              try {
                const agentSecrets = JSON.parse(
                  execSync(`onecli agents secrets --id ${currentAgent.id}`, {
                    encoding: 'utf-8',
                    timeout: 5000,
                  }),
                ) as Array<string | { id: string }>;
                assignedSecretIds = agentSecrets.map((s) =>
                  typeof s === 'string' ? s : s.id,
                );
              } catch {
                /* no secrets assigned */
              }
            }

            const autoStatus = getRotateEnabled() ? '开启' : '关闭';
            const lines = secrets.map((s) => {
              const active = assignedSecretIds.includes(s.id) ? ' ← 当前' : '';
              return `• ${s.name} (${s.type})${active}`;
            });
            const reply =
              lines.length > 0
                ? `可用账号：\n${lines.join('\n')}\n\n自动轮换: ${autoStatus}\n\n切换：/account <name>\n开关：/account auto on|off`
                : '没有配置任何账号。用 onecli secrets create 添加。';
            logger.info(
              { chatJid, replyLen: reply.length },
              '/account 准备发送回复',
            );
            ch?.sendMessage(chatJid, reply)
              .then(() => logger.info('/account 回复已发送'))
              .catch((err) => logger.error({ err }, '/account reply failed'));
          } else {
            // 切换到指定账号

            const secrets = JSON.parse(
              execSync('onecli secrets list', {
                encoding: 'utf-8',
                timeout: 5000,
              }),
            ) as Array<{ id: string; name: string }>;
            const target = secrets.find(
              (s) =>
                s.name === arg ||
                s.id === arg ||
                s.name.toLowerCase().includes(arg.toLowerCase()),
            );
            if (!target) {
              ch?.sendMessage(
                chatJid,
                `❌ 找不到账号 "${arg}"。用 /account 查看可用账号。`,
              ).catch(() => {});
            } else {
              const group = registeredGroups[chatJid];
              const agentId =
                group?.folder.toLowerCase().replace(/_/g, '-') || '';
              const agents = JSON.parse(
                execSync('onecli agents list', {
                  encoding: 'utf-8',
                  timeout: 5000,
                }),
              ) as Array<{
                id: string;
                identifier: string;
                isDefault?: boolean;
              }>;
              const agent =
                agents.find((a) => a.identifier === agentId) ||
                agents.find((a) => 'isDefault' in a && a.isDefault);
              if (agent) {
                execSync(
                  `onecli agents set-secrets --id ${agent.id} --secret-ids ${target.id}`,
                  { encoding: 'utf-8', timeout: 5000 },
                );
                // 也清掉 session，让新容器用新 key
                if (group) {
                  delete sessions[group.folder];
                  deleteSession(group.folder);
                }
                ch?.sendMessage(
                  chatJid,
                  `✅ 已切换到 ${target.name}。下次对话生效。`,
                ).catch(() => {});
                logger.info(
                  { agent: agent.id, secret: target.name },
                  '/account: 账号已切换',
                );
              } else {
                ch?.sendMessage(chatJid, '❌ 找不到对应的 agent。').catch(
                  () => {},
                );
              }
            }
          }
        } catch (err) {
          logger.error({ err }, '/account 执行失败');
          ch?.sendMessage(
            chatJid,
            `❌ 账号操作失败: ${(err as Error).message}`,
          ).catch(() => {});
        }
        return;
      }

      // /trigger 和 /notrigger 指令 — 拦截并切换模式
      if (trimmed === '/trigger' || trimmed === '/notrigger') {
        const reply = handleTriggerToggle(
          chatJid,
          trimmed as '/trigger' | '/notrigger',
        );
        if (reply) {
          const ch = findChannel(channels, chatJid);
          ch?.sendMessage(chatJid, reply).catch((err) =>
            logger.error(
              { err, chatJid },
              'Failed to send trigger toggle reply',
            ),
          );
        }
        return; // 不存储指令消息
      }

      // /llmlog 指令 — 开关 LLM 请求日志（编排层直接处理，不进 LLM）
      if (
        trimmed === '/llmlog' ||
        trimmed === '/llmlog on' ||
        trimmed === '/llmlog off' ||
        trimmed === '/llmlog status'
      ) {
        const ch = findChannel(channels, chatJid);
        const grp = registeredGroups[chatJid];
        if (grp) {
          const flagFile = path.join(GROUPS_DIR, grp.folder, '.llmlog_enabled');
          const logDir = path.join(GROUPS_DIR, grp.folder, 'llmlogs');
          let reply: string;
          if (trimmed === '/llmlog on') {
            fs.mkdirSync(path.dirname(flagFile), { recursive: true });
            fs.writeFileSync(flagFile, '');
            reply = `[llmlog] 已开启，API 请求将保存到 groups/${grp.folder}/llmlogs/`;
          } else if (trimmed === '/llmlog off') {
            try { fs.unlinkSync(flagFile); } catch { /* ignore */ }
            reply = '[llmlog] 已关闭';
          } else {
            // status
            const isOn = fs.existsSync(flagFile);
            let count = 0;
            try { count = fs.readdirSync(logDir).length; } catch { /* ignore */ }
            reply = `[llmlog] 当前${isOn ? '开启' : '关闭'}，已保存 ${count} 条日志`;
          }
          ch?.sendMessage(chatJid, reply).catch((err) =>
            logger.error({ err }, '/llmlog reply failed'),
          );
        }
        return;
      }

      // 未知 / 命令 — 拦截并返回错误提示，不进 LLM
      if (trimmed.startsWith('/') && !trimmed.startsWith('/ ')) {
        const ch = findChannel(channels, chatJid);
        const unknownCmd = trimmed.split(/\s/)[0];
        const help = [
          `❓ 未知命令 "${unknownCmd}"，可用命令：`,
          '',
          '/help — 显示此帮助',
          '/clear — 清除当前 session，开始新对话（记忆保留）',
          '/account — 列出所有 Anthropic 账号及当前绑定',
          '/account <name> — 切换到指定账号',
          '/account auto on|off — 开关自动轮换（429 时自动切换）',
          '/trigger — 开启 @触发模式',
          '/notrigger — 关闭 @触发模式',
          '/llmlog on|off|status — 开关 LLM 完整请求日志',
          '/remote-control — 启动 Claude Code 远程控制会话',
          '/remote-control-end — 结束远程控制会话',
        ].join('\n');
        ch?.sendMessage(chatJid, help).catch((err) =>
          logger.error({ err }, 'unknown command reply failed'),
        );
        return;
      }

      // 自动注册未注册的群聊
      if (!registeredGroups[chatJid]) {
        autoRegisterGroup(chatJid);
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
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
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
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
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    onFeishuAuthRequest: async (chatJid, groupFolder) => {
      const feishuMod = await import('./channels/feishu.js');
      const feishuChannel = channels.find((c) => c.name === 'feishu') as
        | InstanceType<typeof feishuMod.FeishuChannel>
        | undefined;
      if (!feishuChannel?.sendAuthCard) return;
      const { buildAuthUrl } = await import('./channels/feishu-oauth.js');
      const state = `${chatJid}|${groupFolder}`;
      const authUrl = buildAuthUrl(state);
      if (authUrl) {
        await feishuChannel.sendAuthCard(chatJid, authUrl);
        logger.info({ chatJid }, '飞书授权卡片已发送');
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
