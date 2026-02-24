import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  PORT,
  RECONCILIATION_INTERVAL,
} from './config.js';
import { GitHubChannel, GitHubResponseTarget } from './channels/github.js';
import {
  ContainerOutput,
  addGitHubToken,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  cleanupProcessedEvents,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  initDatabase,
  isEventProcessed,
  markEventProcessed,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GitHubTokenManager, loadGitHubAppConfig } from './github/auth.js';
import { checkPermission, DEFAULT_ACCESS_POLICY, RateLimiter } from './github/access-control.js';
import { GitHubEvent, mapWebhookToEvent, repoJidFromThreadJid, parseRepoFromJid } from './github/event-mapper.js';
import { getSetupPageHtml, handleManifestCallback } from './github/setup-handler.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { startWebhookServer } from './webhook-server.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

let tokenManager: GitHubTokenManager | null = null;
const channels: Channel[] = [];
const queue = new GroupQueue();
const rateLimiter = new RateLimiter();

function loadState(): void {
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
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
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
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

// --- GitHub webhook event handling ---

/**
 * Handle an incoming GitHub webhook event.
 * Called by the webhook server after signature verification.
 */
async function handleWebhookEvent(
  eventName: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Idempotency check
  if (isEventProcessed(deliveryId)) {
    logger.debug({ deliveryId }, 'Duplicate event, skipping');
    return;
  }
  markEventProcessed(deliveryId);

  // Handle installation_repositories events (repo add/remove)
  if (eventName === 'installation_repositories') {
    await handleInstallationEvent(payload);
    return;
  }

  if (!tokenManager) return;

  const appSlug = await tokenManager.getAppSlug();
  const event = mapWebhookToEvent(eventName, payload, appSlug);
  if (!event) {
    logger.debug({ eventName, deliveryId }, 'Event not handled');
    return;
  }

  // Check if repo is registered
  const group = registeredGroups[event.repoJid];
  if (!group) {
    logger.debug({ repoJid: event.repoJid }, 'Event for unregistered repo, skipping');
    return;
  }

  // Access control: check permission and rate limit
  try {
    const octokit = await tokenManager.getOctokitForRepo(
      ...Object.values(parseRepoFromJid(event.repoJid)) as [string, string],
    );

    const permCheck = await checkPermission(
      octokit,
      parseRepoFromJid(event.repoJid).owner,
      parseRepoFromJid(event.repoJid).repo,
      event.sender,
      DEFAULT_ACCESS_POLICY,
    );
    if (!permCheck.allowed) {
      logger.info(
        { sender: event.sender, repoJid: event.repoJid, reason: permCheck.reason },
        'Event rejected: insufficient permissions',
      );
      return;
    }

    const rateCheck = rateLimiter.check(event.sender, event.repoJid, DEFAULT_ACCESS_POLICY);
    if (!rateCheck.allowed) {
      logger.info(
        { sender: event.sender, repoJid: event.repoJid, retryAfterMs: rateCheck.retryAfterMs },
        'Event rejected: rate limited',
      );
      return;
    }
  } catch (err) {
    logger.error({ err, repoJid: event.repoJid }, 'Access control check failed');
    return;
  }

  // Store as a message in DB (same pipeline as before)
  const message: NewMessage = {
    id: deliveryId,
    chat_jid: event.threadJid,
    sender: event.sender,
    sender_name: event.sender,
    content: event.content,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    github_metadata: event.metadata,
  };

  storeMessage(message);
  storeChatMetadata(event.repoJid, message.timestamp, event.repoFullName, 'github', true);
  storeChatMetadata(event.threadJid, message.timestamp, undefined, 'github', true);

  logger.info(
    {
      eventType: event.eventType,
      repoJid: event.repoJid,
      threadJid: event.threadJid,
      sender: event.sender,
    },
    'GitHub event stored',
  );

  // Enqueue for processing
  // Use threadJid for per-thread container isolation
  // but resolve the group from repoJid
  const formatted = formatMessages([message]);

  if (queue.sendMessage(event.threadJid, formatted)) {
    logger.debug({ threadJid: event.threadJid }, 'Piped event to active container');
    lastAgentTimestamp[event.threadJid] = message.timestamp;
    saveState();

    const channel = findChannel(channels, event.threadJid);
    channel?.setTyping?.(event.threadJid, true)?.catch((err) =>
      logger.warn({ err }, 'Failed to set typing indicator'),
    );
  } else {
    queue.enqueueMessageCheck(event.threadJid);
  }
}

/**
 * Handle installation_repositories webhook (repo added/removed from installation).
 */
async function handleInstallationEvent(payload: Record<string, unknown>): Promise<void> {
  const action = payload.action as string;
  const installation = payload.installation as { id: number; app_slug: string } | undefined;
  if (!installation) return;

  const addedRepos = (payload.repositories_added || []) as Array<{ full_name: string }>;
  const removedRepos = (payload.repositories_removed || []) as Array<{ full_name: string }>;

  for (const repo of addedRepos) {
    const repoJid = `gh:${repo.full_name}`;
    if (registeredGroups[repoJid]) {
      logger.debug({ repoJid }, 'Repo already registered');
      continue;
    }

    const folder = repo.full_name.replace('/', '--');
    registerGroup(repoJid, {
      name: repo.full_name,
      folder,
      trigger: `@${installation.app_slug}`,
      added_at: new Date().toISOString(),
      requiresTrigger: true,
    });

    logger.info({ repoJid, folder }, 'Auto-registered repo from installation');
  }

  for (const repo of removedRepos) {
    const repoJid = `gh:${repo.full_name}`;
    if (!registeredGroups[repoJid]) continue;
    // Don't delete, just log. The group and history are preserved.
    logger.info({ repoJid }, 'Repo removed from installation (group preserved)');
  }
}

/**
 * Prepare a repo checkout for the container.
 * Clones on first use, fetches before each run.
 * Returns the host path to the checkout.
 */
async function prepareRepoCheckout(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const repoDir = path.join(DATA_DIR, 'repos', `${owner}--${repo}`);

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // Clone the repo
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    execSync(`git clone --depth 50 "${cloneUrl}" "${repoDir}"`, {
      timeout: 120000,
      stdio: 'pipe',
    });
    logger.info({ owner, repo, repoDir }, 'Repo cloned');
  } else {
    // Fetch latest
    try {
      execSync(
        `git -C "${repoDir}" remote set-url origin "https://x-access-token:${token}@github.com/${owner}/${repo}.git"`,
        { timeout: 10000, stdio: 'pipe' },
      );
      execSync(`git -C "${repoDir}" fetch --depth 50 origin`, {
        timeout: 60000,
        stdio: 'pipe',
      });
      execSync(`git -C "${repoDir}" reset --hard origin/HEAD`, {
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch (err) {
      logger.warn({ owner, repo, err }, 'Failed to fetch repo, using existing checkout');
    }
  }

  // Set git config for bot identity (token-based auth for pushes)
  try {
    execSync(`git -C "${repoDir}" config user.name "NanoClaw AI"`, { stdio: 'pipe' });
    execSync(`git -C "${repoDir}" config user.email "nanoclaw[bot]@users.noreply.github.com"`, { stdio: 'pipe' });
  } catch {
    // Non-fatal
  }

  return repoDir;
}

/**
 * Process all pending messages for a group (thread).
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  // For GitHub threads (gh:owner/repo#issue:42), resolve the repo group
  const repoJid = chatJid.startsWith('gh:') ? repoJidFromThreadJid(chatJid) : chatJid;
  const group = registeredGroups[repoJid] || registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if mention/trigger is present
  // For GitHub, the event mapper already filters by @mention
  // so we just process whatever is in the queue
  const prompt = formatMessages(missedMessages);

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, chatJid, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Prepare GitHub-specific context
  let repoCheckoutPath: string | undefined;
  let githubToken: string | undefined;

  if (chatJid.startsWith('gh:') && tokenManager) {
    try {
      const { owner, repo } = parseRepoFromJid(chatJid);
      githubToken = await tokenManager.getTokenForRepo(owner, repo);
      repoCheckoutPath = await prepareRepoCheckout(owner, repo, githubToken);
    } catch (err) {
      logger.error({ err, chatJid }, 'Failed to prepare GitHub context');
    }
  }

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, repoCheckoutPath, githubToken, async (result) => {
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
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
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback');
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  repoCheckoutPath?: string,
  githubToken?: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read
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
  );

  // Update available groups snapshot
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

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
    const input = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      assistantName: ASSISTANT_NAME,
      repoCheckoutPath,
    };

    // Add GitHub token if available
    const secrets: Record<string, string> = {};
    if (githubToken) {
      addGitHubToken(secrets, githubToken);
    }

    const output = await runContainerAgent(
      group,
      { ...input, secrets },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
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

/**
 * Startup recovery: check for unprocessed messages in registered groups.
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

/**
 * Periodic reconciliation: cleanup stale data and check health.
 */
function startReconciliationLoop(): void {
  setInterval(() => {
    try {
      cleanupProcessedEvents();
      rateLimiter.cleanup();
    } catch (err) {
      logger.error({ err }, 'Reconciliation loop error');
    }
  }, RECONCILIATION_INTERVAL);
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

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Load GitHub App config
  const appConfig = loadGitHubAppConfig();

  if (appConfig) {
    tokenManager = new GitHubTokenManager(appConfig);
    const appSlug = await tokenManager.getAppSlug();
    logger.info({ appSlug }, 'GitHub App authenticated');

    // Create and connect GitHub channel
    const github = new GitHubChannel({
      tokenManager,
      onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
      onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
        storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => registeredGroups,
    });
    channels.push(github);
    await github.connect();

    // Start webhook server
    startWebhookServer({
      port: PORT,
      webhookSecret: appConfig.webhookSecret,
      onEvent: (eventName, deliveryId, payload) => {
        handleWebhookEvent(eventName, deliveryId, payload).catch((err) => {
          logger.error({ err, deliveryId }, 'Error processing webhook event');
        });
      },
      getSetupPageHtml: () => null, // Setup complete
    });
  } else {
    // No GitHub App configured — run in setup-only mode
    logger.warn('GitHub App not configured, starting in setup mode');
    logger.info(`Visit http://localhost:${PORT}/github/setup to configure`);

    startWebhookServer({
      port: PORT,
      webhookSecret: 'setup-mode',
      onEvent: () => {}, // No events in setup mode
      getSetupPageHtml: () => {
        const webhookUrl = process.env.WEBHOOK_URL || `http://localhost:${PORT}`;
        return getSetupPageHtml(webhookUrl);
      },
      onManifestCallback: async (code: string) => {
        const html = await handleManifestCallback(code);
        logger.info('GitHub App setup complete! Restart NanoClaw to load credentials.');
        return html;
      },
    });
  }

  // Start subsystems
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
    sendStructuredMessage: (jid, text, target) => {
      const github = channels.find((c) => c.name === 'github') as GitHubChannel | undefined;
      if (!github) throw new Error(`No GitHub channel for JID: ${jid}`);
      return github.sendStructuredMessage(jid, text, target as GitHubResponseTarget);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async () => {
      // No-op for GitHub — repos are auto-registered via installation webhooks
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startReconciliationLoop();

  logger.info({ port: PORT }, 'NanoClaw running (GitHub webhook mode)');
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
