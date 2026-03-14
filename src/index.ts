/**
 * NanoClaw host orchestrator.
 * Docs map:
 * - docs/SPEC.md#message-flow
 * - docs/SPEC.md#deployment
 * - docs/ARCHITECTURE.md#3-multi-channel-pattern
 * Fork-specific rationale:
 * - Maintains main/non-main group boundaries described in docs/FORK_OVERVIEW.md.
 */
import fs from "fs";
import path from "path";

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  MAX_PROMPT_MESSAGES,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from "./config.js";
import { startCredentialProxy } from "./credential-proxy.js";
import "./channels/index.js";
import { getChannelFactory, getRegisteredChannelNames } from "./channels/registry.js";
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from "./container-runner.js";
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from "./container-runtime.js";
import {
  getAllChats,
  getAllMessagesSince,
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
  storeChatMetadata,
  storeMessage,
} from "./db.js";
import { GroupQueue } from "./group-queue.js";
import { resolveGroupFolderPath } from "./group-folder.js";
import { startIpcWatcher } from "./ipc.js";
import {
  anchorTriggerWindow,
  findChannel,
  formatMessages,
  formatMessagesWithCap,
  formatOutbound,
} from "./router.js";
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from "./sender-allowlist.js";
import { startSchedulerLoop } from "./task-scheduler.js";
import { isAuthError } from "./auth-circuit-breaker.js";
import { shouldSend, recordSent } from "./message-dedup.js";
import { createTanrenClient, readTanrenConfig } from "./tanren/index.js";
import { Channel, NewMessage, PartialSendError, RegisteredGroup } from "./types.js";
import { logger } from "./logger.js";

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from "./router.js";

let lastTimestamp = "";
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, { ts: string; id: string }> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const pendingTailDrain = new Map<string, { ts: string; id: string }>();

function loadState(): void {
  lastTimestamp = getRouterState("last_timestamp") || "";
  const agentTs = getRouterState("last_agent_timestamp");
  try {
    const raw: Record<string, string | { ts: string; id: string }> = agentTs
      ? JSON.parse(agentTs)
      : {};
    lastAgentTimestamp = {};
    for (const [key, val] of Object.entries(raw)) {
      lastAgentTimestamp[key] = typeof val === "string" ? { ts: val, id: "" } : val;
    }
  } catch {
    logger.warn("Corrupted last_agent_timestamp in DB, resetting");
    lastAgentTimestamp = {};
  }
  const tailDrainRaw = getRouterState("pending_tail_drain");
  try {
    const parsed = tailDrainRaw ? JSON.parse(tailDrainRaw) : {};
    pendingTailDrain.clear();
    if (Array.isArray(parsed)) {
      // Migration: old format was ["jid1", "jid2"]
      for (const jid of parsed) pendingTailDrain.set(jid, { ts: "", id: "" });
    } else {
      for (const [jid, cursor] of Object.entries(parsed)) {
        pendingTailDrain.set(jid, cursor as { ts: string; id: string });
      }
    }
  } catch {
    logger.warn("Corrupted pending_tail_drain in DB, resetting");
    pendingTailDrain.clear();
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, "State loaded");
}

function saveState(): void {
  setRouterState("last_timestamp", lastTimestamp);
  setRouterState("last_agent_timestamp", JSON.stringify(lastAgentTimestamp));
}

function savePendingTailDrain(): void {
  setRouterState("pending_tail_drain", JSON.stringify(Object.fromEntries(pendingTailDrain)));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      "Rejecting group registration with invalid folder",
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, "logs"), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, "Group registered");
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import("./container-runner.js").AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== "__group_sync__" && c.is_group)
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

/** @internal - exported for testing */
export function _getPendingTailDrain(): ReadonlyMap<string, { ts: string; id: string }> {
  return pendingTailDrain;
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
    logger.warn({ chatJid }, "No channel owns JID, skipping messages");
    return true;
  }

  const isMainGroup = group.isMain === true;
  const needsFullDrain = !isMainGroup && group.requiresTrigger !== false;

  // Clear stale tail-drain entry if the group no longer needs full drain
  // (e.g., requiresTrigger changed to false, or group became main).
  // The bounded path doesn't touch pendingTailDrain, and the poll guard
  // would block the group indefinitely if the entry persists.
  if (!needsFullDrain && pendingTailDrain.delete(chatJid)) {
    savePendingTailDrain();
  }

  const cursor = lastAgentTimestamp[chatJid] || { ts: "", id: "" };
  let missedMessages = needsFullDrain
    ? getAllMessagesSince(chatJid, cursor.ts, ASSISTANT_NAME, 200, cursor.id)
    : getMessagesSince(chatJid, cursor.ts, ASSISTANT_NAME, MAX_PROMPT_MESSAGES, cursor.id);

  if (missedMessages.length === 0) {
    if (pendingTailDrain.delete(chatJid)) savePendingTailDrain();
    return true;
  }

  // Whether the trigger window was truncated (tail messages still need processing).
  // Only set for non-main groups with trigger requirements.
  let truncated = false;
  let isTailDrain = false;
  let tailDrainCutoff: { ts: string; id: string } | null = null;
  // Capture the last message's cursor for use as cutoff on first truncation.
  const fullBacklogLast =
    missedMessages.length > 0
      ? {
          ts: missedMessages[missedMessages.length - 1].timestamp,
          id: missedMessages[missedMessages.length - 1].id,
        }
      : null;
  // Track whether we deleted from pendingTailDrain (for persisting on early returns).
  let wasTailDrain = false;

  // For non-main groups, check if trigger is required and present
  if (needsFullDrain) {
    tailDrainCutoff = pendingTailDrain.get(chatJid) ?? null;
    wasTailDrain = pendingTailDrain.delete(chatJid);
    isTailDrain = wasTailDrain;
    // DB save deferred until batch completes (crash safety)
    if (isTailDrain) {
      // Continuation of a truncated trigger window — skip trigger requirement.
      // Filter to messages at or before the cutoff so post-cutoff messages
      // get normal trigger-gated processing.
      if (tailDrainCutoff && tailDrainCutoff.ts !== "") {
        const cutoffIdx = missedMessages.findIndex(
          (m) =>
            m.timestamp > tailDrainCutoff!.ts ||
            (m.timestamp === tailDrainCutoff!.ts && m.id > tailDrainCutoff!.id),
        );
        if (cutoffIdx === 0) {
          // All messages are past cutoff — tail-drain is complete
          isTailDrain = false;
        } else if (cutoffIdx > 0) {
          missedMessages = missedMessages.slice(0, cutoffIdx);
        }
        // cutoffIdx === -1: all messages at/before cutoff — process all
      }
      // Cap at MAX_PROMPT_MESSAGES; overflow re-enters next cycle
      if (isTailDrain && missedMessages.length > MAX_PROMPT_MESSAGES) {
        truncated = true;
        missedMessages = missedMessages.slice(0, MAX_PROMPT_MESSAGES);
      }
    }
    if (!isTailDrain) {
      // Normal path: require a trigger
      const allowlistCfg = loadSenderAllowlist();
      const triggerIdx = missedMessages.findIndex(
        (m) =>
          TRIGGER_PATTERN.test(m.content.trim()) &&
          (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
      );
      if (triggerIdx < 0) {
        if (wasTailDrain) savePendingTailDrain();
        return true;
      }
      const total = missedMessages.length;
      const window = anchorTriggerWindow(total, triggerIdx, MAX_PROMPT_MESSAGES);
      truncated = window.truncated;
      missedMessages = missedMessages.slice(window.start, window.end);
    }
  }

  const prompt = formatMessagesWithCap(missedMessages, TIMEZONE, MAX_PROMPT_MESSAGES);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || { ts: "", id: "" };
  const last = missedMessages[missedMessages.length - 1];
  lastAgentTimestamp[chatJid] = { ts: last.timestamp, id: last.id };
  // Pre-persist tail-drain marker alongside cursor to prevent crash-window data loss.
  // If truncated, overflow messages exist beyond this batch — record the cutoff
  // so recovery can continue the drain even if the process crashes during agent execution.
  if (truncated) {
    const cutoff = isTailDrain && tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast!;
    pendingTailDrain.set(chatJid, cutoff);
    savePendingTailDrain();
  }
  saveState();

  logger.info({ group: group.name, messageCount: missedMessages.length }, "Processing messages");

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, "Idle timeout, closing container stdin");
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let hadSendError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Suppress auth error messages from reaching Discord
        if (isAuthError(text)) {
          logger.warn({ group: group.name }, "Suppressed auth error from Discord output");
        } else if (!shouldSend(chatJid, text)) {
          logger.warn({ group: group.name }, "Suppressed duplicate message from Discord output");
        } else {
          try {
            await channel.sendMessage(chatJid, text);
            recordSent(chatJid, text);
            outputSentToUser = true;
          } catch (err) {
            hadSendError = true;
            if (err instanceof PartialSendError) {
              outputSentToUser = true;
              logger.warn(
                {
                  group: group.name,
                  chatJid,
                  chunksSent: err.chunksSent,
                  totalChunks: err.totalChunks,
                },
                "Partial send: some chunks delivered, skipping cursor rollback",
              );
            } else {
              logger.error({ group: group.name, chatJid, err }, "Failed to send output to channel");
            }
          }
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === "success") {
      queue.notifyIdle(chatJid);
    }

    if (result.status === "error") {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === "error" || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        "Agent error after output was sent, skipping cursor rollback to prevent duplicates",
      );
      if (truncated) {
        // Marker already persisted at cursor-advance time.
        queue.enqueueMessageCheck(chatJid);
      } else if (isTailDrain) {
        savePendingTailDrain();
        queue.enqueueMessageCheck(chatJid);
      } else if (wasTailDrain) {
        savePendingTailDrain();
      }
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    if (isTailDrain) {
      pendingTailDrain.set(chatJid, tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast!);
      savePendingTailDrain();
    } else if (truncated) {
      // Pre-persisted marker is stale after rollback — clear it to preserve trigger gating
      pendingTailDrain.delete(chatJid);
      savePendingTailDrain();
    } else if (wasTailDrain) {
      savePendingTailDrain();
    }
    logger.warn({ group: group.name }, "Agent error, rolled back message cursor for retry");
    return false;
  }

  // Agent succeeded but channel delivery failed — roll back cursor for retry.
  // Only roll back if no output reached the user (avoid duplicate sends).
  if (hadSendError && !outputSentToUser) {
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    if (isTailDrain) {
      pendingTailDrain.set(chatJid, tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast!);
      savePendingTailDrain();
    } else if (truncated) {
      // Pre-persisted marker is stale after rollback — clear it to preserve trigger gating
      pendingTailDrain.delete(chatJid);
      savePendingTailDrain();
    } else if (wasTailDrain) {
      savePendingTailDrain();
    }
    logger.warn({ group: group.name }, "All channel sends failed, rolled back cursor for retry");
    return false;
  }

  if (truncated) {
    // Marker already persisted at cursor-advance time; just enqueue continuation.
    queue.enqueueMessageCheck(chatJid);
  } else if (isTailDrain) {
    savePendingTailDrain();
    queue.enqueueMessageCheck(chatJid);
  } else if (wasTailDrain) {
    savePendingTailDrain();
  }
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<"success" | "error"> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
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

  const tanrenConfig = isMain ? readTanrenConfig() : undefined;

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
        tanren: tanrenConfig ?? undefined,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === "error") {
      logger.error({ group: group.name, error: output.error }, "Container agent error");
      return "error";
    }

    return "success";
  } catch (err) {
    logger.error({ group: group.name, err }, "Agent error");
    return "error";
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug("Message loop already running, skipping duplicate start");
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, "New messages");

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
            logger.warn({ chatJid }, "No channel owns JID, skipping messages");
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Don't pipe while tail-drain is pending — let processGroupMessages
          // handle the backlog first to avoid cursor jumps that skip messages.
          // Don't enqueue either — the tail-drain's own success/failure handlers
          // manage the next run, and an external enqueue defeats retry backoff.
          if (pendingTailDrain.has(chatJid)) {
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const pipeCursor = lastAgentTimestamp[chatJid] || { ts: "", id: "" };
          const allPending = getMessagesSince(
            chatJid,
            pipeCursor.ts,
            ASSISTANT_NAME,
            MAX_PROMPT_MESSAGES,
            pipeCursor.id,
          );
          const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessagesWithCap(messagesToSend, TIMEZONE, MAX_PROMPT_MESSAGES);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              "Piped messages to active container",
            );
            const pipeLast = messagesToSend[messagesToSend.length - 1];
            lastAgentTimestamp[chatJid] = { ts: pipeLast.timestamp, id: pipeLast.id };
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) => logger.warn({ chatJid, err }, "Failed to set typing indicator"));
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Error in message loop");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  // Phase 1: Enqueue groups with pending tail-drain entries from the DB.
  // After a crash, the entry may survive even though no messages remain
  // at the cutoff — processGroupMessages will clear it (line 205).
  const phase1Enqueued = new Set<string>();
  let removedStale = false;
  for (const chatJid of pendingTailDrain.keys()) {
    if (registeredGroups[chatJid]) {
      logger.info(
        { group: registeredGroups[chatJid].name },
        "Recovery: resuming pending tail-drain",
      );
      queue.enqueueMessageCheck(chatJid);
      phase1Enqueued.add(chatJid);
    } else {
      pendingTailDrain.delete(chatJid);
      removedStale = true;
    }
  }
  if (removedStale) savePendingTailDrain();

  // Phase 2: Enqueue groups with unprocessed messages at the cursor.
  // Skip groups already enqueued in Phase 1 — a second enqueue while
  // the first run is active sets pendingMessages=true, which defeats
  // retry backoff if the run fails.
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (phase1Enqueued.has(chatJid)) continue;
    const recoverCursor = lastAgentTimestamp[chatJid] || { ts: "", id: "" };
    const pending = getMessagesSince(
      chatJid,
      recoverCursor.ts,
      ASSISTANT_NAME,
      1,
      recoverCursor.id,
    );
    if (pending.length > 0) {
      logger.info({ group: group.name }, "Recovery: found unprocessed messages");
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
  logger.info("Database initialized");
  loadState();

  const tanrenClient = createTanrenClient();
  if (tanrenClient) {
    tanrenClient
      .health()
      .then((health) => {
        logger.info(
          { version: health.version, uptime: health.uptime_seconds },
          "Tanren API connected",
        );
      })
      .catch((err) => {
        logger.warn(
          { err },
          "Tanren API health check failed — tanren integration continues (API may recover)",
        );
      });
  } else {
    logger.debug("Tanren API not configured (TANREN_API_URL / TANREN_API_KEY missing)");
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              "sender-allowlist: dropping message (drop mode)",
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
        "Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.",
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal("No channels connected");
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
        logger.warn({ jid }, "No channel owns JID, cannot send message");
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
      await Promise.all(channels.filter((ch) => ch.syncGroups).map((ch) => ch.syncGroups!(force)));
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.onRetriesExhausted = (groupJid: string) => {
    if (pendingTailDrain.delete(groupJid)) {
      savePendingTailDrain();
      logger.info({ groupJid }, "Cleared stale pendingTailDrain after retry exhaustion");
    }
  };
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, "Message loop crashed unexpectedly");
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, "Failed to start NanoClaw");
    process.exit(1);
  });
}
