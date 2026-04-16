import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

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
  TRUST_GATEWAY_PORT,
  PROACTIVE_SUGGESTION_INTERVAL,
  WEBHOOK_PORT,
  WEBHOOK_SECRET,
  BROWSER_CDP_URL,
} from './config.js';
import { generateSuggestion } from './proactive-suggestions.js';
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
  ensureDockerNetwork,
  ensureBrowserSidecar,
  stopBrowserSidecar,
} from './container-runtime.js';
import { BrowserSessionManager } from './browser/session-manager.js';
import { StagehandBridge } from './browser/stagehand-bridge.js';
import {
  deleteRouterState,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getPendingCursors,
  getRouterState,
  initDatabase,
  logSessionCost,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getPendingTrustApprovalIds,
  getDb,
} from './db.js';
import { ExecutorPool } from './executor-pool.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  classifyAndFormat,
} from './router.js';
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
import { isBudgetExceeded } from './budget.js';
import {
  formatApprovalPrompt,
  handlePotentialApprovalReply,
} from './trust-approval-handler.js';
import { parseTrustCommand, executeTrustCommand } from './trust-commands.js';
import {
  initKnowledgeStore,
  ensureQdrantCollection,
} from './memory/knowledge-store.js';
import { initOutcomeStore, logOutcome } from './memory/outcome-store.js';
import {
  parseAssistantCommand,
  executeAssistantCommand,
} from './memory/cost-dashboard.js';
import { startTrustGateway } from './trust-gateway.js';
import { startWebhookServer } from './watchers/webhook-server.js';
import { getMeetingBriefings } from './watchers/meeting-briefing.js';
import { runHealthCheck } from './watchers/sidecar-health.js';
import { startDealWatchLoop } from './deal-watch-loop.js';
import { startEmailSSE, setEmailTriggerDebouncer, getEmailTriggerDebouncer, writeIpcTrigger } from './email-sse.js';
import { EmailTriggerDebouncer } from './email-trigger-debouncer.js';
import { startCalendarPoller, stopCalendarPoller } from './calendar-poller.js';
import {
  startWatcherPoller,
  stopWatcherPoller,
} from './watchers/watcher-poller.js';
import { createExtractFn } from './watchers/extract-text.js';
import {
  correlateByAttendee,
  correlateBySubject,
  correlateBySemanticMatch,
} from './thread-correlator.js';
import { classifyFromSSE } from './sse-classifier.js';
import {
  refreshGmailTokens,
  startGmailRefreshLoop,
} from './gmail-token-refresh.js';
import { runDailyDigest } from './daily-digest.js';
import { startEventRouter } from './event-router.js';
import { handleWebhookEvent } from './webhook-consumer.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { initLearningSystem, buildRulesBlock } from './learning/index.js';
import { handleMessageWithProcedureCheck } from './learning/procedure-match-integration.js';
import { captureTaskOutcome } from './knowledge-ingestion.js';
import { resolveModel, getEscalationModel } from './llm/provider.js';
import { scoreComplexity } from './llm/escalation.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { eventBus } from './event-bus.js';
import { shouldFireDigest, generateSmartDigest } from './digest-engine.js';
/* eslint-disable @typescript-eslint/no-unused-vars -- scaffolding: callback/push/classification wiring */
import {
  parseCallbackData,
  resolveItemByCallback,
  getTrackedItemById,
  insertTrackedItem,
  getTrackedItemBySourceId,
  updateDigestState,
  getDigestState,
  transitionItemState,
} from './tracked-items.js';
import { recordBehavior } from './classification-adjustments.js';
import { PushBuffer } from './push-buffer.js';
import { getPushActions, PushRateLimiter } from './push-manager.js';
import { classify } from './classification.js';
/* eslint-enable @typescript-eslint/no-unused-vars */
import { StatusBarManager } from './status-bar.js';
import { AutoApprovalTimer } from './auto-approval.js';
import { FailureEscalator } from './failure-escalator.js';
import { ArchiveTracker } from './archive-tracker.js';
import { MessageBatcher } from './message-batcher.js';
import { handleCallback } from './callback-router.js';
import { formatBatch } from './message-formatter.js';
import { startMiniAppServer } from './mini-app/server.js';
import { GmailOpsRouter } from './gmail-ops.js';
import type { GmailOpsProvider } from './gmail-ops.js';
import { UxConfig } from './ux-config.js';
import {
  parseCommand,
  handleConfigCommand,
  handleSmokeTest,
} from './chat-commands.js';
import type {
  MessageInboundEvent,
  MessageOutboundEvent,
  SystemStartupEvent,
  ProactiveSuggestionEvent,
} from './events.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let proactiveSuggestionTimer: ReturnType<typeof setInterval> | null = null;
let lastSuggestionAt = 0;

const channels: Channel[] = [];
const queue = new ExecutorPool();
queue.initWarmPool();

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
  // Recover from interrupted processing: if any group has a pending cursor,
  // it means the previous process was killed mid-work. Roll back the cursor
  // so those messages get re-processed.
  const pendingCursors = getPendingCursors();
  for (const [jid, previousCursor] of pendingCursors) {
    const currentCursor = lastAgentTimestamp[jid];
    if (currentCursor && currentCursor > previousCursor) {
      lastAgentTimestamp[jid] = previousCursor;
      logger.info(
        { jid, rolledBackFrom: currentCursor, rolledBackTo: previousCursor },
        'Recovered pending cursor — messages will be re-processed',
      );
    }
    deleteRouterState(`pending_cursor:${jid}`);
  }
  if (pendingCursors.size > 0) {
    setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  }

  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
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

/** @internal - exported for testing */
export { loadState as _loadState };

/** @internal - exported for testing */
export { registerGroup as _registerGroup };

/** @internal - exported for testing */
export { processGroupMessages as _processGroupMessages };

/** @internal - exported for testing */
export { runAgent as _runAgent };

/**
 * Process all pending messages for a group.
 * Called by the ExecutorPool when it's this group's turn.
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

  // Check for matching learned procedures before full agent run
  const procedureHandled = await handleMessageWithProcedureCheck(
    prompt,
    chatJid,
    (p) => runAgent(group, p, chatJid),
    async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (ch) await ch.sendMessage(jid, text);
    },
    (fn) => queue.enqueueTask(chatJid, `proc-${Date.now()}`, fn),
  );
  if (procedureHandled) {
    // Advance cursor past these messages since procedure handled them
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    deleteRouterState(`pending_cursor:${chatJid}`);
    return true;
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  // The pending cursor is persisted to DB so we can recover on crash/restart.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  setRouterState(`pending_cursor:${chatJid}`, previousCursor);
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

  // Progress UX: three states — ack → narrate → alert.
  //
  // 1. Immediately send an editable "⏳ Working…" message (confirms receipt,
  //    persists even if you leave/re-enter the chat).
  // 2. Refresh the typing indicator every 5s as an ambient "still alive" signal.
  // 3. Update the progress message only on progressLabel changes (tool narration).
  // 4. Alert only after 5 minutes of silence — before that, typing indicator
  //    is sufficient and avoids false-positive "stuck" warnings on complex tasks.
  // 5. Delete the progress message when the real response arrives.
  let progressHandle: {
    update: (t: string) => Promise<void>;
    clear: () => Promise<void>;
  } | null = null;
  if (channel.sendProgress) {
    progressHandle = await channel.sendProgress(chatJid, '⏳ Working…');
  } else {
    await channel.setTyping?.(chatJid, true);
  }

  // Refresh typing indicator every 5s (Telegram typing expires after ~5s).
  const typingInterval = setInterval(async () => {
    try {
      await channel.setTyping?.(chatJid, true);
    } catch {
      // Swallow — typing is best-effort
    }
  }, 5_000);

  let hadError = false;
  let outputSentToUser = false;
  const responseStartMs = Date.now();
  let lastActivityMs = Date.now();

  // Watchdog: only alert after 5 minutes of silence — genuine problems only.
  const WATCHDOG_ALERT_MS = 300_000;
  let watchdogFired = false;
  const watchdogInterval = setInterval(async () => {
    const silenceMs = Date.now() - lastActivityMs;
    if (silenceMs >= WATCHDOG_ALERT_MS && !watchdogFired) {
      watchdogFired = true;
      const elapsed = Math.round((Date.now() - responseStartMs) / 1000);
      const mins = Math.round(elapsed / 60);
      if (progressHandle) {
        await progressHandle.update(
          `⚠️ No response after ${mins}m — may need attention`,
        );
      }
    }
  }, 30_000);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    lastActivityMs = Date.now();
    watchdogFired = false; // reset on any activity

    // Tool narration: update progress message with what the agent is doing.
    // No elapsed time — keeps it clean and avoids adding anxiety.
    if (result.progressLabel && progressHandle) {
      await progressHandle.update(`⏳ ${result.progressLabel}…`);
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
        // Clear progress message before sending the real response
        if (progressHandle) {
          await progressHandle.clear();
          progressHandle = null;
        }
        // Only add transparency footer to substantive responses.
        // Short one-liners (< 80 chars) don't need turn counts and elapsed time.
        let outText = text;
        if (text.length >= 80) {
          const elapsedSec = Math.round((Date.now() - responseStartMs) / 1000);
          const parts: string[] = [];
          if (result.numTurns != null) parts.push(`${result.numTurns} turns`);
          parts.push(`${elapsedSec}s`);
          outText = text + `\n\n_${parts.join(' · ')}_`;
        }
        await channel.sendMessage(chatJid, outText);
        eventBus.emit('message.outbound', {
          type: 'message.outbound',
          source: 'router',
          groupId: chatJid,
          timestamp: Date.now(),
          payload: {
            chatJid,
            channel: channel.name,
            text: outText.slice(0, 200),
          },
        });
        outputSentToUser = true;
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
  });

  clearInterval(watchdogInterval);
  clearInterval(typingInterval);
  if (progressHandle) {
    await progressHandle.clear();
    progressHandle = null;
  }
  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      deleteRouterState(`pending_cursor:${chatJid}`);
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    deleteRouterState(`pending_cursor:${chatJid}`);
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Processing complete — clear the pending cursor
  deleteRouterState(`pending_cursor:${chatJid}`);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  if (isBudgetExceeded()) {
    logger.warn({ group: group.name }, 'Agent blocked by budget ceiling');
    return 'error';
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Accumulate real per-query cost reported by the SDK's result messages.
  // One container run can issue multiple queries (the keep-alive loop);
  // every result message brings its own total_cost_usd, so we sum them.
  let realCostUsd = 0;
  let sawRealCost = false;

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

  // Wrap onOutput to track session ID and accumulate real cost from streamed results
  const wrappedOnOutput = async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (typeof output.totalCostUsd === 'number') {
      realCostUsd += output.totalCostUsd;
      sawRealCost = true;
    }
    if (onOutput) await onOutput(output);
  };

  try {
    const rulesBlock = buildRulesBlock(prompt, group.folder);
    const enrichedPrompt = rulesBlock ? `${prompt}\n\n${rulesBlock}` : prompt;

    // Resolve LLM provider/model for this group
    const resolved = resolveModel({ llm: group.containerConfig?.llm });

    // Auto-escalate if message is complex and escalation model is configured
    let finalModel = resolved.model;
    if (resolved.provider !== 'anthropic') {
      const complexity = scoreComplexity(prompt);
      if (complexity.shouldEscalate) {
        const llmConfig = group.containerConfig?.llm;
        const escalationModel =
          llmConfig?.escalationModel ?? getEscalationModel(resolved.provider);
        if (escalationModel) {
          finalModel = escalationModel;
          logger.info(
            {
              group: group.name,
              score: complexity.score,
              reason: complexity.reason,
              model: escalationModel,
            },
            'Auto-escalated model',
          );
        }
      }
    }

    // Inject learned procedures into agent context
    const { listProcedures } = await import('./memory/procedure-store.js');
    const groupProcs = listProcedures(group.folder);

    if (groupProcs.length > 0) {
      const relevant = groupProcs
        .filter((p) => p.success_count > 0)
        .sort((a, b) => b.success_count - a.success_count)
        .slice(0, 5);

      if (relevant.length > 0) {
        const procedureContext =
          '<learned_procedures>\n' +
          relevant
            .map(
              (p) =>
                `- "${p.trigger}": ${p.description || p.steps.map((s) => s.action).join(' → ')} (${p.success_count} successes)`,
            )
            .join('\n') +
          '\n</learned_procedures>';

        const contextDir = path.join(GROUPS_DIR, group.folder, 'context');
        fs.mkdirSync(contextDir, { recursive: true });
        fs.writeFileSync(
          path.join(contextDir, 'procedures.txt'),
          procedureContext,
          'utf-8',
        );
      }
    }

    const output = await runContainerAgent(
      group,
      {
        prompt: enrichedPrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        verbose: group.verbose,
        provider: resolved.provider as any,
        model: finalModel ?? undefined,
        providerBaseUrl: resolved.providerBaseUrl ?? undefined,
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

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      const durationMs = Date.now() - startMs;
      logSessionCost({
        session_type: 'message',
        group_folder: group.folder,
        started_at: startedAt,
        duration_ms: durationMs,
        estimated_cost_usd: sawRealCost
          ? realCostUsd
          : (durationMs / 10_000) * 0.01,
      });
      return 'error';
    }

    const durationMs = Date.now() - startMs;
    logSessionCost({
      session_type: 'message',
      group_folder: group.folder,
      started_at: startedAt,
      duration_ms: durationMs,
      estimated_cost_usd: sawRealCost
        ? realCostUsd
        : (durationMs / 10_000) * 0.01,
    });

    captureTaskOutcome({
      groupId: group.folder,
      prompt: prompt.slice(0, 250),
      status: 'success',
      durationMs,
    }).catch(() => {});

    // Parse agent lesson for learning system
    if (output.result) {
      const lessonMatch = output.result.match(
        /"_lesson"\s*:\s*"([^"]{1,400})"/,
      );
      if (lessonMatch) {
        const { addRule } = await import('./learning/rules-engine.js');
        const { inferActionClasses } =
          await import('./learning/outcome-enricher.js');
        const lessonText = lessonMatch[1];
        addRule({
          rule: lessonText,
          source: 'agent_reported',
          actionClasses: inferActionClasses(lessonText),
          groupId: group.folder,
          confidence: 0.3,
          evidenceCount: 1,
        });
      }
    }

    // Parse agent procedure for learning system
    if (output.result) {
      const procMatch = output.result.match(
        /"_procedure"\s*:\s*(\{[\s\S]*?\})/,
      );
      if (procMatch) {
        try {
          const agentProc = JSON.parse(
            procMatch[1],
          ) as import('./learning/procedure-recorder.js').AgentProcedure;
          const { finalizeTrace } =
            await import('./learning/procedure-recorder.js');
          finalizeTrace(
            group.folder,
            `agent-${group.folder}-${startMs}`,
            true,
            agentProc,
          );
        } catch {
          logger.warn(
            { groupId: group.folder },
            'Failed to parse _procedure block from agent output',
          );
        }
      }
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    const durationMs = Date.now() - startMs;
    logSessionCost({
      session_type: 'message',
      group_folder: group.folder,
      started_at: startedAt,
      duration_ms: durationMs,
      estimated_cost_usd: sawRealCost
        ? realCostUsd
        : (durationMs / 10_000) * 0.01,
    });
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

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

          // --- Trust approval interception ---
          // Check if any new message resolves a pending trust approval.
          // If so, consume it (don't pass to agent).
          const pendingIds = getPendingTrustApprovalIds(chatJid);
          if (pendingIds.length > 0) {
            for (const msg of groupMessages) {
              if (
                handlePotentialApprovalReply(msg.content, chatJid, pendingIds)
              ) {
                // Remove from batch so it doesn't trigger agent
                const idx = groupMessages.indexOf(msg);
                if (idx >= 0) groupMessages.splice(idx, 1);
              }
            }
            if (groupMessages.length === 0) continue;
          }

          // --- Trust & assistant command interception ---
          // Intercept commands BEFORE they reach the agent. Track IDs of
          // intercepted messages so we can filter them from the DB re-read
          // in getMessagesSince() below (which would otherwise re-include them).
          const interceptedMessageIds = new Set<string>();
          const triggerPatternForCmd = getTriggerPattern(group.trigger);
          const isMainGroup = group.isMain === true;
          for (const msg of [...groupMessages]) {
            const trimmedContent = msg.content.trim();
            // Strip trigger prefix if present; for main groups also try raw text
            let strippedText: string;
            if (triggerPatternForCmd.test(trimmedContent)) {
              strippedText = trimmedContent
                .replace(triggerPatternForCmd, '')
                .trim();
            } else if (isMainGroup) {
              strippedText = trimmedContent;
            } else {
              continue;
            }

            // Trust commands: trust status, never auto-execute, reset trust, what did I miss
            const trustCmd = parseTrustCommand(strippedText);
            if (trustCmd) {
              const response = executeTrustCommand(trustCmd, group.folder);
              channel
                .sendMessage(chatJid, response)
                .catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to send trust command response',
                  ),
                );
              interceptedMessageIds.add(msg.id);
              const idx = groupMessages.indexOf(msg);
              if (idx >= 0) groupMessages.splice(idx, 1);
              continue;
            }

            // Assistant commands: cost report, teach, etc.
            const assistantCmd = parseAssistantCommand(strippedText);
            if (assistantCmd) {
              const response = executeAssistantCommand(
                assistantCmd,
                group.folder,
              );
              channel
                .sendMessage(chatJid, response)
                .catch((err) =>
                  logger.warn(
                    { chatJid, err },
                    'Failed to send assistant command response',
                  ),
                );
              interceptedMessageIds.add(msg.id);
              const idx = groupMessages.indexOf(msg);
              if (idx >= 0) groupMessages.splice(idx, 1);
              continue;
            }
          }

          if (groupMessages.length === 0) continue;

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
          // Filter out intercepted command messages so the agent doesn't see them
          const filteredPending =
            interceptedMessageIds.size > 0
              ? allPending.filter((m) => !interceptedMessageIds.has(m.id))
              : allPending;
          const messagesToSend =
            filteredPending.length > 0 ? filteredPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Before piping to active container, check if ALL remaining messages
          // are commands. If so, handle them directly — no need to pipe or queue.
          if (messagesToSend.length === 0) continue;

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Acknowledge receipt so the user knows their message wasn't lost.
            // The agent is already busy — this ack bridges the gap until it responds.
            channel
              .sendMessage(chatJid, '↳ Got it — queued behind current task.')
              .catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to send pipe ack'),
              );
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            eventBus.emit('message.inbound', {
              type: 'message.inbound',
              source: 'channel',
              groupId: chatJid,
              timestamp: Date.now(),
              payload: { chatJid, channel: channel.name, messageCount: 1 },
            });
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

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  ensureDockerNetwork('nanoclaw');
  ensureBrowserSidecar();
  cleanupOrphans();
}

// Smart digest check — runs every 15 minutes
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- wired into startup when full integration is ready
function startSmartDigestCheck(
  sendMessage: (jid: string, text: string) => Promise<void>,
  getMainGroupJid: () => string | undefined,
): void {
  setInterval(
    () => {
      const jid = getMainGroupJid();
      if (!jid) return;

      const groupName = 'main';
      if (shouldFireDigest(groupName)) {
        const digest = generateSmartDigest(groupName);
        if (digest) {
          sendMessage(jid, digest).catch((err) => {
            logger.error({ err }, 'Failed to send smart digest');
          });
          eventBus.emit('digest.sent', {
            type: 'digest.sent',
            source: 'digest-engine',
            timestamp: Date.now(),
            payload: { groupName, itemCount: 0, digestType: 'smart' },
          });
        }
      }
    },
    15 * 60 * 1000,
  );
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  initKnowledgeStore();
  // Initialize Qdrant collection if configured (non-blocking, non-fatal)
  ensureQdrantCollection().catch((err) =>
    logger.warn({ err }, 'Qdrant collection init failed'),
  );
  initOutcomeStore();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  const browserSessionManager = new BrowserSessionManager();
  const stagehandBridge = new StagehandBridge(browserSessionManager);
  const browserTrustState = {
    readGranted: false,
    readGrantedAt: 0,
    groupId: '',
  };

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await browserSessionManager.shutdown();
    for (const ch of channels) await ch.disconnect();
    stopBrowserSidecar();
    stopCalendarPoller();
    stopWatcherPoller();
    if (proactiveSuggestionTimer) {
      clearInterval(proactiveSuggestionTimer);
      proactiveSuggestionTimer = null;
    }
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
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Chat commands: config, smoketest (main group only)
      const group = registeredGroups[chatJid];
      if (group?.isMain) {
        const cmd = parseCommand(trimmed);
        if (cmd) {
          (async () => {
            try {
              let reply: string;
              if (cmd.type === 'config') {
                reply = handleConfigCommand(cmd, uxConfig);
              } else {
                const enrichAccts = channels
                  .filter((c) => c.name.startsWith('gmail-'))
                  .map((c) => c.name.replace(/^gmail-/, ''));
                reply = await handleSmokeTest({
                  classifyAndFormat,
                  gmailOpsRouter: {
                    listRecentDrafts: (account) =>
                      gmailOpsRouter.listRecentDrafts(account),
                    accounts: enrichAccts,
                  },
                  archiveTracker: {
                    getUnarchived: () => archiveTracker.getUnarchived(),
                  },
                  draftWatcherRunning: draftWatcher !== undefined,
                  uxConfig: {
                    list: () => uxConfig.list(),
                  },
                  miniAppPort: Number(process.env.MINI_APP_PORT) || 3847,
                  triggerDebouncer: getEmailTriggerDebouncer(),
                });
              }
              const ch = findChannel(channels, chatJid);
              if (ch) {
                await ch.sendMessage(chatJid, reply);
              }
            } catch (err) {
              logger.error({ err }, 'Chat command failed');
            }
          })().catch((err) => logger.error({ err }, 'Chat command error'));
          return;
        }
      }

      // "Archive all" command — batch-archive acted emails
      if (trimmed.toLowerCase() === 'archive all') {
        if (group?.isMain) {
          (async () => {
            const unarchived = archiveTracker.getUnarchived();
            const ch = findChannel(channels, chatJid);
            if (unarchived.length === 0) {
              await ch?.sendMessage(chatJid, '✅ No emails to archive');
              return;
            }
            let archived = 0;
            for (const email of unarchived) {
              try {
                await gmailOpsRouter.archiveThread(
                  email.account,
                  email.thread_id,
                );
                archiveTracker.markArchived(email.email_id, email.action_taken);
                archived++;
              } catch (err) {
                logger.error(
                  { err, emailId: email.email_id },
                  'Failed to archive email',
                );
              }
            }
            await ch?.sendMessage(
              chatJid,
              `✅ Archived ${archived}/${unarchived.length} threads`,
            );
          })().catch((err) => logger.error({ err }, 'Archive all failed'));
          return; // Don't store this message or process further
        }
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
    try {
      await channel.connect();
      channels.push(channel);
    } catch (err) {
      logger.error(
        { channel: channelName, err },
        'Channel failed to connect — skipping',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // --- GmailOps router: expose Gmail API operations to UX modules ---
  const gmailOpsRouter = new GmailOpsRouter();
  for (const ch of channels) {
    if (ch.name.startsWith('gmail')) {
      const alias =
        ch.name === 'gmail' ? 'default' : ch.name.replace('gmail-', '');
      if ('archiveThread' in ch && 'listRecentDrafts' in ch) {
        gmailOpsRouter.register(alias, ch as unknown as GmailOpsProvider);
        logger.info({ alias }, 'Registered Gmail channel with GmailOpsRouter');
      }
    }
  }

  // --- Agentic UX initialization ---

  const archiveTracker = new ArchiveTracker(getDb());
  const uxConfig = new UxConfig(getDb());
  uxConfig.seedDefaults();
  const autoApproval = new AutoApprovalTimer(eventBus);

  // --- Draft enrichment watcher ---
  const enrichmentAccounts = channels
    .filter((ch) => ch.name.startsWith('gmail') && 'listRecentDrafts' in ch)
    .map((ch) =>
      ch.name === 'gmail' ? 'default' : ch.name.replace('gmail-', ''),
    );

  let draftWatcher:
    | import('./draft-enrichment.js').DraftEnrichmentWatcher
    | undefined;
  if (enrichmentAccounts.length > 0) {
    const { DraftEnrichmentWatcher } = await import('./draft-enrichment.js');
    draftWatcher = new DraftEnrichmentWatcher(eventBus, getDb(), {
      accounts: enrichmentAccounts,
      listRecentDrafts: (account) => gmailOpsRouter.listRecentDrafts(account),
      updateDraft: (account, draftId, newBody) =>
        gmailOpsRouter.updateDraft(account, draftId, newBody),
      evaluateEnrichment: async (draft) => {
        if (draft.body.length > uxConfig.getNumber('enrichment.maxBodyLength'))
          return null;
        const ageMs = Date.now() - new Date(draft.createdAt).getTime();
        if (ageMs > uxConfig.getNumber('enrichment.maxAgeMinutes') * 60 * 1000)
          return null;

        const ENRICHMENT_TIMEOUT_MS = uxConfig.getNumber(
          'enrichment.timeoutMs',
        );
        const telegramJid = Object.keys(registeredGroups).find((jid) =>
          jid.startsWith('tg:'),
        );
        if (!telegramJid) {
          logger.warn('No Telegram JID for draft enrichment task');
          return null;
        }

        const { parseEnrichmentResponse } =
          await import('./draft-enrichment.js');

        return new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn(
              { draftId: draft.draftId },
              'Draft enrichment timed out',
            );
            resolve(null);
          }, ENRICHMENT_TIMEOUT_MS);

          const taskId = `draft-enrich-${draft.draftId}-${Date.now()}`;
          queue.enqueueTask(
            telegramJid,
            taskId,
            async () => {
              try {
                const group = registeredGroups[telegramJid];
                if (!group) {
                  clearTimeout(timer);
                  resolve(null);
                  return;
                }

                const promptTemplate = uxConfig.get('enrichment.prompt');
                const enrichPrompt = `## Draft Enrichment Task\n\n${promptTemplate
                  .replace(/\{subject\}/g, draft.subject)
                  .replace(/\{threadId\}/g, draft.threadId)
                  .replace(/\{body\}/g, draft.body)
                  .replace(/\{account\}/g, draft.account ?? '')
                  .replace(/\{draftId\}/g, draft.draftId)}`;

                let enrichedBody: string | null = null;
                await runAgent(
                  group,
                  enrichPrompt,
                  telegramJid,
                  async (output) => {
                    if (output.result) {
                      enrichedBody = parseEnrichmentResponse(output.result);
                    }
                  },
                );

                clearTimeout(timer);
                resolve(enrichedBody);
              } catch (err) {
                logger.error(
                  { draftId: draft.draftId, err },
                  'Draft enrichment agent failed',
                );
                clearTimeout(timer);
                resolve(null);
              }
            },
            'proactive',
          );
        });
      },
    });
    draftWatcher.start();
    logger.info(
      { accounts: enrichmentAccounts },
      'Draft enrichment watcher started',
    );
  }

  // --- Archive flow: record email actions for later cleanup ---
  eventBus.on('email.action.completed', (event) => {
    archiveTracker.recordAction(
      event.payload.emailId,
      event.payload.threadId,
      event.payload.account,
      event.payload.action,
    );
  });

  // Status bar — sends/edits a pinned message in the main group
  const mainGroupEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain,
  );
  const statusBar = new StatusBarManager(eventBus, {
    sendProgress: async (text) => {
      if (!mainGroupEntry)
        return { update: async () => {}, clear: async () => {} };
      const [mainJid] = mainGroupEntry;
      const channel = findChannel(channels, mainJid);
      if (channel?.sendProgress) {
        return channel.sendProgress(mainJid, text);
      }
      await channel?.sendMessage(mainJid, text);
      return { update: async () => {}, clear: async () => {} };
    },
    sendMessage: async (text) => {
      if (!mainGroupEntry) return;
      const [mainJid] = mainGroupEntry;
      const channel = findChannel(channels, mainJid);
      await channel?.sendMessage(mainJid, text);
    },
  });

  // Failure escalator
  const _failureEscalator = new FailureEscalator(eventBus, {
    onEscalate: (text, actions) => {
      if (mainGroupEntry) {
        const [mainJid] = mainGroupEntry;
        const channel = findChannel(channels, mainJid);
        channel
          ?.sendMessageWithActions?.(mainJid, text, actions)
          .catch(() => {});
      }
    },
  });

  // Message batcher for auto-handled items
  const _batcher = new MessageBatcher({
    maxItems: 5,
    maxWaitMs: 10_000,
    onFlush: (items) => {
      if (mainGroupEntry) {
        const [mainJid] = mainGroupEntry;
        const channel = findChannel(channels, mainJid);
        channel?.sendMessage(mainJid, formatBatch(items)).catch(() => {});
      }
    },
  });

  // Register callback handler on Telegram channel
  const telegramChannel = channels.find((c) => c.name === 'telegram');
  if (telegramChannel?.onCallbackQuery) {
    telegramChannel.onCallbackQuery((query) => {
      handleCallback(query, {
        archiveTracker,
        autoApproval,
        statusBar,
        gmailOps: gmailOpsRouter,
        draftWatcher,
        findChannel: (jid) => findChannel(channels, jid),
      });
    });
  }

  // Start Mini App server
  startMiniAppServer({
    port: Number(process.env.MINI_APP_PORT) || 3847,
    db: getDb(),
    gmailOps: gmailOpsRouter,
    draftWatcher,
  });

  // --- Notify on draft enrichment ---
  eventBus.on('email.draft.enriched', (event) => {
    if (!mainGroupEntry) return;
    const [mainJid] = mainGroupEntry;
    const channel = findChannel(channels, mainJid);
    const text = `✏️ Draft enriched: "${event.payload.changes}"`;
    const actions = [
      {
        label: '↩ Revert',
        callbackData: `revert:${event.payload.draftId}`,
        style: 'secondary' as const,
      },
      {
        label: '✅ Keep',
        callbackData: `keep:${event.payload.draftId}`,
        style: 'primary' as const,
      },
    ];
    channel?.sendMessageWithActions?.(mainJid, text, actions).catch(() => {});
  });

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
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText);
      if (!text) return Promise.resolve();
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
    enqueueEmailTrigger: (chatJid, prompt, onResult, triggerEmails) => {
      const taskId = `email-trigger-${Date.now()}`;
      queue.enqueueTask(chatJid, taskId, async () => {
        const group = registeredGroups[chatJid];
        if (!group) {
          logger.warn({ chatJid }, 'No group for email trigger');
          return;
        }

        // Pre-refresh Gmail OAuth tokens before spawning the container.
        // Tokens have a 1-hour lifetime and routinely expire mid-session,
        // causing the gmail-mcp inside the container to silently lose its
        // ability to read email bodies. Refreshing here is fast (<200ms
        // when nothing needs refresh) and never blocks the spawn — even on
        // refresh failure we proceed with subject-only classification
        // rather than dropping the trigger.
        const refreshResult = await refreshGmailTokens();
        if (refreshResult.status === 'error') {
          logger.warn(
            { chatJid, summary: refreshResult.summary },
            'Gmail token refresh failed before email trigger — agent may degrade to subject-only',
          );
        } else if (refreshResult.status === 'missing') {
          logger.debug(
            { chatJid, summary: refreshResult.summary },
            'Some Gmail accounts not authorized — proceeding with available accounts',
          );
        }

        // System-injected progress message: email triggers routinely take
        // 30-90s while the agent reads threads and drafts replies. Send a
        // single in-place-editable "⏳ Working..." message IMMEDIATELY,
        // then update it as the agent invokes tools (Reading Gmail thread →
        // Generating reply → ...). This gives the user instant confirmation
        // AND live visibility into what's happening, without spamming chat.
        // Channels that don't support edit-in-place fall back to
        // append-only via sendMessage.
        const ackChannel = findChannel(channels, chatJid);
        let progressHandle: {
          update: (t: string) => Promise<void>;
          clear: () => Promise<void>;
        } | null = null;
        if (ackChannel) {
          try {
            await ackChannel.setTyping?.(chatJid, true);
            if (ackChannel.sendProgress) {
              progressHandle = await ackChannel.sendProgress(
                chatJid,
                '⏳ New email(s) — processing now…',
              );
            } else {
              await ackChannel.sendMessage(
                chatJid,
                '⏳ New email(s) — processing now…',
              );
            }
          } catch (err) {
            logger.debug(
              { chatJid, err },
              'Failed to send email-trigger acknowledgment',
            );
          }
        }

        // Email triggers are single-shot: agent replies, we're done. Close
        // the container shortly after the first result so it exits cleanly
        // via the _close sentinel instead of hanging for the 30-min idle
        // window (during which external OOM reapers can SIGKILL it and
        // produce confusing code-137 exits).
        const EMAIL_TRIGGER_CLOSE_DELAY_MS = 10_000;
        let closeScheduled = false;
        const scheduleClose = () => {
          if (closeScheduled) return;
          closeScheduled = true;
          setTimeout(() => {
            logger.debug(
              { chatJid, taskId },
              'Closing email-trigger container after result',
            );
            queue.closeStdin(chatJid);
          }, EMAIL_TRIGGER_CLOSE_DELAY_MS);
        };

        const result = await runAgent(
          group,
          prompt,
          chatJid,
          async (output) => {
            // Live tool-call narration: edit the in-place ack message with
            // whatever the agent is currently doing.
            if (output.progressLabel && progressHandle) {
              await progressHandle.update(`⏳ ${output.progressLabel}…`);
            }
            if (output.result) {
              // Real result arrived — clear the progress message before
              // sending, so the chat ends with a single clean answer.
              if (progressHandle) {
                await progressHandle.clear();
                progressHandle = null;
              }
              const clean = formatOutbound(output.result);
              if (clean) {
                const { text: formatted, meta } = classifyAndFormat(clean);

                // Force-attach archive buttons from trigger metadata
                // (classifier may not detect email category since agent formats freely)
                for (const email of triggerEmails ?? []) {
                  const emailId = email.thread_id;
                  archiveTracker.recordAction(
                    emailId,
                    email.thread_id,
                    email.account,
                    'replied',
                  );

                  if (
                    !meta.actions.some((a) =>
                      a.callbackData?.startsWith('archive:'),
                    )
                  ) {
                    meta.actions.push({
                      label: '🗄 Archive',
                      callbackData: `archive:${emailId}`,
                      style: 'secondary' as const,
                    });
                  }
                }

                // Send with buttons if the channel supports them
                const outChannel = findChannel(channels, chatJid);
                if (
                  outChannel &&
                  meta.actions.length > 0 &&
                  'sendMessageWithActions' in outChannel
                ) {
                  await (outChannel as any).sendMessageWithActions(
                    chatJid,
                    formatted,
                    meta.actions,
                  );
                } else {
                  await onResult(formatted, triggerEmails ?? []);
                }
              }
              scheduleClose();
            }
          },
        );

        // If we errored out before any result landed, still clean up the
        // progress message so the user isn't left staring at "⏳ …".
        if (progressHandle) {
          await progressHandle.clear();
          progressHandle = null;
        }

        if (result === 'error') {
          const telegramJid = Object.keys(registeredGroups).find((jid) =>
            jid.startsWith('tg:'),
          );
          const notifyJid = telegramJid || chatJid;
          const channel = findChannel(channels, notifyJid);
          if (channel) {
            await channel.sendMessage(
              notifyJid,
              '⚠️ Email intelligence trigger failed. Check logs.',
            );
          }
        }
      });
    },
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
    stagehandBridge,
    browserTrustState,
  });
  // Start trust gateway (containers call this before write/transact ops)
  startTrustGateway(TRUST_GATEWAY_PORT);

  // Webhook event source (disabled when WEBHOOK_PORT=0)
  startWebhookServer(WEBHOOK_PORT, WEBHOOK_SECRET);

  // Webhook event consumer: route received webhooks to the main group as tasks
  eventBus.on('webhook.received', (event) => {
    const mainEntry = Object.entries(registeredGroups).find(
      ([, g]) => g.isMain,
    );
    if (!mainEntry) {
      logger.warn('webhook.received: no main group registered, dropping event');
      return;
    }
    const [mainJid, mainGroup] = mainEntry;
    handleWebhookEvent(
      {
        type: event.type,
        payload: (event.payload.data as Record<string, unknown>) ?? {},
        source: (event.payload.webhookSource as string) ?? 'generic',
        receivedAt: new Date(event.timestamp).toISOString(),
      },
      (prompt) => {
        const taskId = `webhook-${Date.now()}`;
        queue.enqueueTask(mainJid, taskId, async () => {
          await runAgent(mainGroup, prompt, mainJid);
        });
      },
      mainGroup.folder,
    );
  });

  // Browser sidecar health monitoring (every 30 seconds)
  if (BROWSER_CDP_URL) {
    setInterval(() => {
      runHealthCheck(BROWSER_CDP_URL, () => {
        logger.error('Browser sidecar unhealthy — attempting restart');
        try {
          ensureBrowserSidecar();
        } catch (err) {
          logger.error(
            { err: String(err) },
            'Failed to restart browser sidecar',
          );
        }
      }).catch((err) => {
        logger.warn({ err: String(err) }, 'Sidecar health check failed');
      });
    }, 30_000);
  }

  // Initialize email trigger debouncer — buffers rapid-fire SSE triggers
  // into a single merged IPC file to prevent duplicate agent runs
  const triggerDebouncer = new EmailTriggerDebouncer({
    debounceMs: uxConfig.getNumber('trigger.debounceMs'),
    maxHoldMs: uxConfig.getNumber('trigger.maxHoldMs'),
    onFlush: (emails, label) => writeIpcTrigger(emails, label),
  });
  setEmailTriggerDebouncer(triggerDebouncer);

  // Real-time email notifications via SSE (poll is fallback)
  startEmailSSE();
  startCalendarPoller();

  // Browser watcher polling
  if (browserSessionManager) {
    const watcherExtract = createExtractFn(
      browserSessionManager,
      '__watchers__',
    );
    startWatcherPoller(watcherExtract);
  }

  // Notify user when a browser watcher detects a change
  eventBus.on('watcher.changed', (event) => {
    const payload = event.payload as {
      watcherId: string;
      url: string;
      selector: string;
      previousValue: string | null;
      newValue: string | null;
      groupId: string;
    };

    const groupJid = Object.keys(registeredGroups).find(
      (jid) => registeredGroups[jid].folder === payload.groupId,
    );
    if (!groupJid) {
      logger.warn({ payload }, 'watcher.changed: no group found for groupId');
      return;
    }

    const channel = findChannel(channels, groupJid);
    if (!channel) {
      logger.warn({ groupJid }, 'watcher.changed: no channel for JID');
      return;
    }

    const msg =
      `🔔 **Watcher update** (${payload.watcherId})\n` +
      `URL: ${payload.url}\n` +
      `Changed: ${payload.previousValue ?? '(first check)'} → ${payload.newValue}`;

    channel.sendMessage(groupJid, msg).catch((err: unknown) => {
      logger.error(
        { err, groupJid },
        'watcher.changed: failed to send notification',
      );
    });
  });

  // Event router: processes events against per-group rules
  startEventRouter({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'event-router: no channel for JID');
        return;
      }
      await channel.sendMessage(jid, text);
    },
    enqueueTask: (chatJid, prompt, groupFolder) => {
      const taskId = `event-router-${Date.now()}`;
      const group = registeredGroups[chatJid];
      if (!group) return;
      queue.enqueueTask(chatJid, taskId, async () => {
        await runAgent(group, prompt, chatJid);
      });
    },
    registeredGroups: () => registeredGroups,
  });

  // Learning system: rules engine + procedure recorder
  initLearningSystem(eventBus, {
    getRegisteredGroups: () => registeredGroups,
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.sendMessage(jid, text);
    },
    enqueueTask: (jid, taskId, fn) => queue.enqueueTask(jid, taskId, fn),
  });

  // Proactive scheduling suggestions
  function startProactiveSuggestionCheck(): void {
    proactiveSuggestionTimer = setInterval(() => {
      try {
        const now = Date.now();
        if (now - lastSuggestionAt < PROACTIVE_SUGGESTION_INTERVAL) return;

        const suggestion = generateSuggestion('main', now);
        if (!suggestion) return;

        lastSuggestionAt = now;

        const telegramJid = Object.keys(registeredGroups).find((jid) =>
          jid.startsWith('tg:'),
        );
        if (telegramJid) {
          const channel = findChannel(channels, telegramJid);
          if (channel) {
            channel
              .sendMessage(telegramJid, suggestion.message)
              .catch((err) => {
                logger.warn(
                  { err: String(err) },
                  'Failed to send proactive suggestion',
                );
              });
          }
        }

        const event: ProactiveSuggestionEvent = {
          type: 'proactive.suggestion',
          source: 'scheduling-advisor',
          timestamp: now,
          payload: {
            groupName: 'main',
            suggestion: suggestion.message,
            pendingCount: suggestion.pendingCount,
            nextGapAt: suggestion.nextGapAt,
            urgencyScore: suggestion.urgencyScore,
          },
        };
        eventBus.emit('proactive.suggestion', event);

        // Meeting briefings: check for upcoming meetings
        try {
          const briefings = getMeetingBriefings(now, 15);
          for (const briefing of briefings) {
            const telegramJid = Object.keys(registeredGroups).find((jid) =>
              jid.startsWith('tg:'),
            );
            const notifyJid = telegramJid || Object.keys(registeredGroups)[0];
            if (notifyJid) {
              const group = registeredGroups[notifyJid];
              if (group) {
                const taskId = `briefing-${briefing.eventId}`;
                queue.enqueueTask(notifyJid, taskId, async () => {
                  await runAgent(group, briefing.prompt, notifyJid);
                });
                logger.info(
                  { eventId: briefing.eventId, title: briefing.eventTitle },
                  'Meeting briefing task enqueued',
                );
              }
            }
          }
        } catch (err) {
          logger.warn({ err: String(err) }, 'Meeting briefing check failed');
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'Proactive suggestion check failed');
      }
    }, 60000);
  }

  startProactiveSuggestionCheck();

  // Outcome logging: track task completion outcomes for learning
  eventBus.on('task.complete', (event) => {
    logOutcome({
      actionClass: 'task.execution',
      description: `Task ${event.payload.taskId}`,
      method: 'container',
      result: event.payload.status === 'success' ? 'success' : 'failure',
      durationMs: event.payload.durationMs,
      costUsd: event.payload.costUsd,
      groupId: event.groupId || 'unknown',
    });
  });

  // Thread correlation: correlate items by attendee and subject on classification
  eventBus.on('item.classified', (event) => {
    try {
      const item = getTrackedItemById(event.payload.itemId);
      if (!item) return;
      correlateByAttendee(item);
      correlateBySubject(item, item.group_name);
      // Async semantic correlation (fire-and-forget)
      correlateBySemanticMatch(item, item.group_name).catch((err) => {
        logger.warn(
          { err: String(err), itemId: event.payload.itemId },
          'Semantic thread correlation failed',
        );
      });
    } catch (err) {
      logger.warn(
        { err: String(err), itemId: event.payload.itemId },
        'Thread correlation failed',
      );
    }
  });

  // SSE-triggered classification: classify emails inline without container
  eventBus.on('email.received', (event) => {
    try {
      const emails = event.payload.emails as Array<{
        thread_id: string;
        account: string;
        subject?: string;
        sender?: string;
      }>;

      // Classify for digest tracking only — the email-trigger agent
      // pipeline handles all Telegram notifications via its formatted
      // summary, so we no longer send individual push messages here.
      const results = classifyFromSSE(emails);

      logger.info(
        { total: results.length },
        'SSE emails classified inline (agent handles notifications)',
      );
    } catch (err) {
      logger.warn({ err: String(err) }, 'SSE inline classification failed');
    }
  });

  // Daily digest: schedule to run every day at 8:00 AM
  const DAILY_DIGEST_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
  const digestDeps = {
    sendMessage: async (jid: string, text: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      await channel.sendMessage(jid, text);
    },
    getMainGroupJid: () =>
      Object.keys(registeredGroups).find((jid) => registeredGroups[jid].isMain),
  };
  let lastDigestDate = '';
  setInterval(async () => {
    const now = new Date();
    // Convert to configured timezone and check if it's 8 AM
    const localHour = parseInt(
      now.toLocaleString('en-US', {
        timeZone: TIMEZONE,
        hour: 'numeric',
        hour12: false,
      }),
      10,
    );
    const todayKey = now.toISOString().slice(0, 10);
    if (localHour === 8 && lastDigestDate !== todayKey) {
      lastDigestDate = todayKey;
      try {
        await runDailyDigest(digestDeps);
      } catch (err) {
        logger.error({ err }, 'Daily digest failed');
      }
    }
  }, DAILY_DIGEST_INTERVAL_MS);
  // Deal-watch: real-time HubSpot + Gong signal layer → main group.
  // Opt-in via DEAL_WATCH_ENABLED=1 in .env; no-op otherwise.
  startDealWatchLoop({
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'deal-watch: no channel owns JID, cannot send');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
  });
  // Background Gmail token refresh: tokens expire every 60 min, refresh every 45 min.
  startGmailRefreshLoop({
    onAuthExpired: (summary) => {
      // Alert via the main group's channel
      const mainJid = Object.keys(registeredGroups).find(
        (jid) => registeredGroups[jid].isMain,
      );
      if (!mainJid) return;
      const channel = findChannel(channels, mainJid);
      if (!channel) return;
      channel
        .sendMessage(
          mainJid,
          `⚠️ Gmail auth needs re-authorization.\n\nRun on your Mac:\ncd ~/.gmail-mcp && npx -y @gongrzhe/server-gmail-autoauth-mcp auth\n\nDetails: ${summary}`,
        )
        .catch((err) =>
          logger.warn({ err }, 'Failed to send Gmail auth alert'),
        );
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  eventBus.emit('system.startup', {
    type: 'system.startup',
    source: 'orchestrator',
    timestamp: Date.now(),
    payload: {
      channels: channels.map((c) => c.name),
      groupCount: Object.keys(registeredGroups).length,
    },
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
