import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  deleteSession,
  finalizeSpawnedThread,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  releaseSpawnedThreadReservation,
  reserveSpawnedThread,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
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
import { hasPrivilege, resolveGroupType } from './group-type.js';
import {
  Channel,
  InboundMessage,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import {
  resolveProviderConfig,
  resolveProviderExecutionConfig,
} from './provider-config.js';

// リファクタリング中の後方互換性のために再エクスポート
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<
  string,
  {
    sessionId: string;
    providerName?: string;
  }
> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

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

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  try {
    resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid group folder',
    );
    return;
  }

  const workspaceFolder = group.parent_folder ?? group.folder;
  let groupDir: string;
  let registeredGroup = group;
  try {
    groupDir = resolveGroupFolderPath(workspaceFolder);
  } catch (err) {
    logger.warn(
      {
        jid,
        folder: workspaceFolder,
        fallbackFolder: group.folder,
        err,
      },
      'Invalid workspace folder in group registration; falling back to group folder',
    );
    groupDir = resolveGroupFolderPath(group.folder);
    if (group.parent_folder !== undefined) {
      registeredGroup = { ...group, parent_folder: undefined };
    }
  }

  registeredGroups[jid] = registeredGroup;
  setRegisteredGroup(jid, registeredGroup);

  // container-runner の workspace マウント先に合わせて logs/ を作成
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * thread message を受信したとき、parent group の thread_defaults に基づいて
 * 子 group を自動登録する。
 */
function autoRegisterThread(
  chatJid: string,
  msg: InboundMessage,
  parent: RegisteredGroup,
): void {
  const td = parent.thread_defaults!;
  const requestedType = td.type;
  const childType =
    requestedType === 'chat' || requestedType === 'thread'
      ? requestedType
      : 'thread';
  if (requestedType && childType !== requestedType) {
    logger.warn(
      { chatJid, requestedType },
      'Invalid or privileged thread_defaults.type detected at runtime; falling back to thread',
    );
  }
  const threadName = msg.sender_name
    ? `Thread (from ${msg.sender_name})`
    : 'Thread';
  const childGroup: RegisteredGroup = {
    name: threadName,
    folder: parent.folder,
    parent_folder: parent.folder,
    trigger: parent.trigger,
    added_at: new Date().toISOString(),
    containerConfig: td.containerConfig ?? parent.containerConfig,
    requiresTrigger: td.requiresTrigger ?? parent.requiresTrigger,
    type: childType,
  };
  registerGroup(chatJid, childGroup);
  logger.info(
    { chatJid, parentFolder: parent.folder, type: childGroup.type },
    'Thread group auto-registered',
  );
}

/**
 * メッセージを受信したとき、Discord スレッドを自動作成してエージェントに処理させる。
 * channel_mode = 'thread_per_message' のチャンネル専用。
 */
async function spawnThreadForMessage(
  chatJid: string,
  msg: InboundMessage,
  group: RegisteredGroup,
  channel: Channel,
): Promise<boolean> {
  // 重複スポーン防止: まず source_message_id を予約してから非同期 createThread を実行する
  const reserved = reserveSpawnedThread(
    msg.id,
    'thread_per_message',
    msg.content.slice(0, 256),
  );
  if (!reserved) return false;

  const threadName = buildThreadNameForMessage(msg);

  let threadJid: string | null;
  try {
    threadJid = await channel.createThread!(chatJid, threadName, msg.id);
  } catch (err) {
    releaseSpawnedThreadReservation(msg.id);
    logger.error(
      { err, chatJid, sourceMessageId: msg.id },
      'Failed to create thread for message',
    );
    return false;
  }
  if (!threadJid) {
    releaseSpawnedThreadReservation(msg.id);
    logger.warn(
      { chatJid, sourceMessageId: msg.id },
      'Failed to create thread for message',
    );
    return false;
  }

  const childGroup: RegisteredGroup = {
    name: threadName,
    folder: group.folder,
    parent_folder: group.folder,
    trigger: group.trigger,
    added_at: new Date().toISOString(),
    containerConfig: group.containerConfig,
    requiresTrigger: false,
    type: 'thread',
    channel_mode: 'thread_per_message',
  };

  const syntheticMsg: InboundMessage = {
    id: `${msg.id}_thread`,
    chat_jid: threadJid,
    sender: msg.sender,
    sender_name: msg.sender_name,
    content: msg.content,
    timestamp: msg.timestamp,
    is_from_me: msg.is_from_me,
    is_thread: true,
    parent_jid: chatJid,
  };

  type ThreadPerMessageInitStage =
    | 'chat_metadata'
    | 'store_message'
    | 'register_group'
    | 'enqueue_initial_task'
    | 'finalize_spawn';
  let initStage: ThreadPerMessageInitStage = 'chat_metadata';
  try {
    // programmatic に作成した thread は受信イベントが来ないため、
    // synthetic メッセージ保存前に chats 行を作成して FK 制約を満たす。
    storeChatMetadata(threadJid, msg.timestamp, threadName, channel.name, true);

    initStage = 'store_message';
    storeMessage(syntheticMsg);

    initStage = 'register_group';
    registerGroup(threadJid, childGroup);
    if (!registeredGroups[threadJid]) {
      throw new Error('Thread group registration was rejected');
    }

    initStage = 'enqueue_initial_task';
    queue.enqueueTask(
      threadJid,
      `thread-per-message-initial:${msg.id}`,
      async () => {
        try {
          const processed = await processMessagesForGroup(
            threadJid,
            childGroup,
            channel,
          );
          if (!processed) {
            logger.error(
              { chatJid, threadJid, sourceMessageId: msg.id },
              'Initial thread-per-message direct processing failed; re-enqueueing message check',
            );
            queue.enqueueMessageCheck(threadJid);
          }
        } catch (err) {
          logger.error(
            { err, chatJid, threadJid, sourceMessageId: msg.id },
            'Initial thread-per-message direct processing threw; re-enqueueing message check',
          );
          queue.enqueueMessageCheck(threadJid);
        }
      },
    );

    initStage = 'finalize_spawn';
    finalizeSpawnedThread(msg.id, threadJid);
  } catch (err) {
    releaseSpawnedThreadReservation(msg.id);
    logger.error(
      {
        err,
        chatJid,
        threadJid,
        sourceMessageId: msg.id,
        stage: initStage,
      },
      'Failed to initialize thread-per-message thread',
    );
    return false;
  }

  logger.info(
    { chatJid, threadJid, folder: group.folder, sourceMessageId: msg.id },
    'Thread-per-message thread spawned',
  );
  return true;
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;

function extractFirstUrl(value: string): string | null {
  const firstMatch = value.match(URL_RE);
  return firstMatch?.[0] ?? null;
}

function buildThreadNameForMessage(msg: InboundMessage): string {
  const firstUrl = extractFirstUrl(msg.content);
  if (firstUrl) {
    try {
      const parsed = new URL(firstUrl);
      const fromUrl = `${parsed.hostname}${parsed.pathname}`.slice(0, 80);
      if (fromUrl) return fromUrl;
    } catch {
      const trimmed = firstUrl.trim().slice(0, 80);
      if (trimmed) return trimmed;
    }
  }

  const compact = msg.content.replace(/\s+/g, ' ').trim();
  if (compact) return compact.slice(0, 80);
  if (msg.sender_name) return `Thread from ${msg.sender_name}`.slice(0, 80);
  return 'Thread';
}

function maybeHandleThreadPerMessageMessage(
  chatJid: string,
  msg: InboundMessage,
  availableChannels: Channel[] = channels,
): boolean {
  const parentGroup = msg.parent_jid
    ? registeredGroups[msg.parent_jid]
    : undefined;
  const isThreadPerMessageThreadMessage =
    msg.is_thread === true &&
    parentGroup?.channel_mode === 'thread_per_message';
  if (isThreadPerMessageThreadMessage) {
    storeMessage(msg);
    return true;
  }

  const group = registeredGroups[chatJid];
  if (
    group?.channel_mode !== 'thread_per_message' ||
    msg.is_thread === true ||
    Boolean(msg.parent_jid)
  ) {
    return false;
  }

  const ch = findChannel(availableChannels, chatJid);
  if (!ch?.createThread) {
    storeMessage(msg);
    return true;
  }

  spawnThreadForMessage(chatJid, msg, group, ch)
    .then((handled) => {
      if (!handled) storeMessage(msg);
    })
    .catch((err) => {
      logger.error({ err, chatJid }, 'Thread-per-message spawn failed');
      storeMessage(msg);
    });
  return true;
}

/**
 * エージェントが利用可能なグループのリストを取得します。
 * 直近のアクティビティ順にグループを返します。
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

/** @internal - テスト用にエクスポート */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/** @internal - テスト用にエクスポート */
export const _spawnThreadForMessage = spawnThreadForMessage;
/** @internal - テスト用にエクスポート */
export const _maybeHandleThreadPerMessageMessage =
  maybeHandleThreadPerMessageMessage;
/** @internal - テスト用にエクスポート */
export const _processMessagesForGroup = processMessagesForGroup;

/** @internal - テスト用にエクスポート */
export const _autoRegisterThread = autoRegisterThread;

/**
 * グループのすべての保留中メッセージを処理します。
 * GroupQueue によって、そのグループの順番が来たときに呼び出されます。
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  return processMessagesForGroup(chatJid, group, channel);
}

async function processMessagesForGroup(
  chatJid: string,
  group: RegisteredGroup,
  channel: Channel,
): Promise<boolean> {
  const isPrivileged = hasPrivilege(group);

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // 非特権グループ（chat/thread）については、トリガーが必要かつ存在するか確認
  if (!isPrivileged && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // startMessageLoop 内のパイプパスがこれらのメッセージを再取得しないように
  // カーソルを進めます。エラー時にロールバックできるよう古いカーソルを保存します。
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // エージェントがアイドル状態のときに stdin を閉じるためのアイドルタイマーを追跡
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

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // ストリーミング出力コールバック — エージェントの各結果に対して呼び出されます
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // <internal>...</internal> ブロックを除去 — エージェントが内部推論に使用します
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // セッション更新マーカー (result: null) ではなく、実際の結果に対してのみアイドルタイマーをリセット
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // すでにユーザーに出力を送信している場合は、カーソルをロールバックしない —
    // ユーザーはすでに応答を受け取っており、再処理すると重複して送信されるため。
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // リトライでこれらのメッセージを再処理できるようカーソルをロールバック
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const groupType = resolveGroupType(group);
  const isPrivileged = groupType === 'main' || groupType === 'override';
  const session = sessions[chatJid];

  // コンテナが読み取るためのタスクスナップショットを更新（グループでフィルタリング）
  const tasks = getAllTasks();
  writeTasksSnapshot(
    chatJid,
    isPrivileged,
    tasks.map((t) => ({
      id: t.id,
      groupJid: t.chat_jid,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // 利用可能なグループのスナップショットを更新（特権グループのみが全グループを表示可能）
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(chatJid, isPrivileged, availableGroups);

  // ストリームされた結果からセッション ID を追跡するために onOutput をラップ
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[chatJid] = {
            sessionId: output.newSessionId,
            providerName: output.providerName,
          };
          setSession(chatJid, output.newSessionId, output.providerName);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: session?.sessionId,
        groupFolder: group.folder,
        chatJid,
        groupType,
        assistantName: ASSISTANT_NAME,
        selectedProvider: group.provider,
        sessionProviderName: session?.providerName,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[chatJid] = {
        sessionId: output.newSessionId,
        providerName: output.providerName,
      };
      setSession(chatJid, output.newSessionId, output.providerName);
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

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

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

        // すべてのメッセージの「既読」カーソルを即座に進める
        lastTimestamp = newTimestamp;
        saveState();

        // グループごとに重複排除
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

          const isPrivileged = hasPrivilege(group);
          const needsTrigger = !isPrivileged && group.requiresTrigger !== false;

          // メイン以外のグループについては、トリガーメッセージに対してのみアクションを実行。
          // トリガー以外のメッセージは DB に蓄積され、最終的にトリガーが届いたときに
          // コンテキストとして取得される。
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

          // トリガー間に蓄積された非トリガーコンテキストが含まれるよう、
          // lastAgentTimestamp 以降のすべてのメッセージを取得。
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
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
            // コンテナがパイプされたメッセージを処理している間、入力中インジケーターを表示
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // アクティブなコンテナがない — 新しいコンテナのためにエンキュー
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
 * 起動時のリカバリ: 登録済みグループ内の未処理メッセージを確認。
 * lastTimestamp の進行とメッセージ処理の間のクラッシュに対応。
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // 認証情報プロキシを開始（コンテナはこのプロキシ経由で API コールを行う）
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // グレースフルシャットダウンハンドラー
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // /remote-control および /remote-control-end コマンドを処理
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group || !hasPrivilege(group)) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not privileged group',
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

  async function handleProviderCommand(
    chatJid: string,
    msg: InboundMessage,
  ): Promise<void> {
    if (!chatJid.startsWith('dc:')) return;

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This channel is not a registered group, so provider switching is unavailable.',
      );
      return;
    }

    const resolved = resolveProviderConfig();
    const parts = msg.content.trim().split(/\s+/);

    if (parts.length === 1) {
      const execution = resolveProviderExecutionConfig(resolved, group.provider);
      const currentName = execution.defaultProvider;
      const current = execution.providers[currentName];
      await channel.sendMessage(
        chatJid,
        `Current provider: ${currentName} (${current.provider}, ${current.model})`,
      );
      return;
    }

    const requested = parts[1];
    if (!resolved.providers[requested]) {
      await channel.sendMessage(
        chatJid,
        `Unknown provider "${requested}". Available: ${Object.keys(resolved.providers).join(', ')}`,
      );
      return;
    }

    const updatedGroup: RegisteredGroup = {
      ...group,
      provider:
        requested === resolved.defaultProvider ? undefined : requested,
    };
    registeredGroups[chatJid] = updatedGroup;
    setRegisteredGroup(chatJid, updatedGroup);

    delete sessions[chatJid];
    deleteSession(chatJid);

    const selected = resolved.providers[requested];
    await channel.sendMessage(
      chatJid,
      `Provider switched to ${requested} (${selected.provider}, ${selected.model}). Session context was reset.`,
    );
  }

  // チャネルコールバック（すべてのチャネルで共有）
  const channelOpts = {
    onMessage: (chatJid: string, msg: InboundMessage) => {
      // リモートコントロールコマンド — 保存前にインターセプト
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }
      if (
        chatJid.startsWith('dc:') &&
        (trimmed === '/provider' || trimmed.startsWith('/provider '))
      ) {
        handleProviderCommand(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Provider command error'),
        );
        return;
      }

      // thread 自動登録 — まだ未登録で parent_jid がある場合のみ試みる
      if (!registeredGroups[chatJid] && msg.parent_jid) {
        const parent = registeredGroups[msg.parent_jid];
        if (parent?.thread_defaults) {
          autoRegisterThread(chatJid, msg, parent);
          if (!registeredGroups[chatJid]) {
            // registerGroup() が内部で早期 return した場合は未登録のままなので保存しない
            return;
          }
          // 登録成功時のみ以降の storeMessage / allowlist 処理を通常通り実行する
        } else {
          // parent が thread_defaults を持たない — discord.ts がすでにフィルタしているが念のため
          return;
        }
      }

      // 送信者許可リストのドロップモード: 保存前に拒否された送信者からのメッセージを破棄
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

      // thread_per_message チャンネル: すべてのメッセージでスレッド作成を試行する
      if (maybeHandleThreadPerMessageMessage(chatJid, msg)) return;

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

  // すべての登録済みチャネルを作成して接続。
  // 各チャネルは上記のバレルインポートを介して自己登録する。
  // ファクトリは認証情報がない場合に null を返すため、未設定のチャネルはスキップされる。
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

  // サブシステムを開始（接続ハンドラーとは独立）
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName) =>
      queue.registerProcess(groupJid, proc, containerName),
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
    writeGroupsSnapshot: (gj, im, ag) => writeGroupsSnapshot(gj, im, ag),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// ガード: テストによるインポート時ではなく、直接実行されたときのみ実行
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
