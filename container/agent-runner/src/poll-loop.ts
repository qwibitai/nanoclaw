import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { getSessionRouting } from './db/session-routing.js';
import {
  clearContinuation,
  migrateLegacyContinuation,
  setContinuation,
} from './db/session-state.js';
import { formatMessages, extractRouting, extractImageAttachments, categorizeMessage, type RoutingContext } from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
// End stream after 120s with no SDK events. Resuming a long Claude session can
// take 60-90s before the first event arrives, and tool calls (esp. Composio
// remote bash + workbench, Drive uploads) regularly run silent for 30-60s
// without yielding any SDK events. Aborting too early disconnects the
// agent-runner iterator while the underlying claude subprocess keeps running —
// it finishes the work and writes the final response, but to a closed
// listener, so the user gets nothing back. 300s covers long agent turns
// where the model pauses mid-stream during cross-skill reasoning or while
// waiting on slow MCP tool calls (Composio cold-start, Drive/Gmail latency).
// Still short enough that a genuinely hung query doesn't wedge the container
// forever.
const IDLE_END_MS = 300_000;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Set of user IDs allowed to run admin commands (e.g. /clear) in this
   * agent group. Host populates from owners + global admins + scoped admins
   * at container wake time, so role changes take effect on next spawn.
   */
  adminUserIds?: Set<string>;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Handle commands: categorize chat messages
    const adminUserIds = config.adminUserIds ?? new Set<string>();
    const normalMessages = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') {
        normalMessages.push(msg);
        continue;
      }

      const cmdInfo = categorizeMessage(msg);

      if (cmdInfo.category === 'filtered') {
        // Silently drop — mark completed, don't process
        log(`Filtered command: ${cmdInfo.command} (msg: ${msg.id})`);
        commandIds.push(msg.id);
        continue;
      }

      if (cmdInfo.category === 'admin') {
        if (!cmdInfo.senderId || !adminUserIds.has(cmdInfo.senderId)) {
          log(`Admin command denied: ${cmdInfo.command} from ${cmdInfo.senderId} (msg: ${msg.id})`);
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: `Permission denied: ${cmdInfo.command} requires admin access.` }),
          });
          commandIds.push(msg.id);
          continue;
        }
        // Handle admin commands directly
        if (cmdInfo.command === '/clear') {
          log('Clearing session (resetting continuation)');
          continuation = undefined;
          clearContinuation(config.providerName);
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({ text: 'Session cleared.' }),
          });
          commandIds.push(msg.id);
          continue;
        }

        // Other admin commands — pass through to agent
        normalMessages.push(msg);
        continue;
      }

      // passthrough or none
      normalMessages.push(msg);
    }

    // Mark filtered/denied command messages as completed immediately
    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    // If all messages were filtered commands, skip processing
    if (normalMessages.length === 0) {
      // Mark remaining processing IDs as completed
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(normalMessages, config.provider.supportsNativeSlashCommands);

    // Extract image attachments — passed alongside the prompt as multimodal
    // content blocks so the agent actually sees the image bytes, not just
    // a text reference like "[image: photo.jpg]".
    const images = extractImageAttachments(normalMessages);

    log(
      `Processing ${normalMessages.length} message(s), kinds: ${[...new Set(normalMessages.map((m) => m.kind))].join(',')}` +
        (images.length > 0 ? `, images: ${images.length}` : ''),
    );

    const query = config.provider.query({
      prompt,
      images: images.length > 0 ? images : undefined,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const processingIds = ids.filter((id) => !commandIds.includes(id));
    try {
      const result = await processQuery(query, routing, config, processingIds);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    }

    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  config: PollLoopConfig,
  initialBatchIds: string[],
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let endRequested = false;
  let endRequestedAt = 0;
  let aborted = false;
  let lastEventTime = Date.now();

  // Concurrent polling: push follow-ups, checkpoint WAL, detect idle
  const pollHandle = setInterval(() => {
    if (done) return;

    // After end() was requested, the SDK iterator may not terminate (e.g.
    // post-/compact, events.next() can stay pending indefinitely). Give it
    // 10s of grace, then force-abort once and stop polling.
    if (endRequested) {
      if (!aborted && Date.now() - endRequestedAt > 10_000) {
        log('SDK iterator did not terminate 10s after end(), aborting');
        aborted = true;
        query.abort();
      }
      return;
    }

    // Skip system messages (MCP tool responses) and admin commands (need fresh query)
    const newMessages = getPendingMessages().filter((m) => {
      if (m.kind === 'system') return false;
      if (m.kind === 'chat' || m.kind === 'chat-sdk') {
        const cmd = categorizeMessage(m);
        if (cmd.category === 'admin') return false;
      }
      return true;
    });
    if (newMessages.length > 0) {
      const newIds = newMessages.map((m) => m.id);
      markProcessing(newIds);

      const prompt = formatMessages(newMessages);
      log(`Pushing ${newMessages.length} follow-up message(s) into active query`);
      query.push(prompt);

      markCompleted(newIds);
      lastEventTime = Date.now(); // new input counts as activity
    }

    // End stream when agent is idle: no SDK events and no pending messages.
    // Guard with endRequested so we don't re-call query.end() (and re-log) on
    // every 500ms tick while the SDK iterator is still draining — a /compact
    // result can leave events.next() pending indefinitely.
    if (Date.now() - lastEventTime > IDLE_END_MS) {
      log(`No SDK events for ${IDLE_END_MS / 1000}s, ending query`);
      endRequested = true;
      endRequestedAt = Date.now();
      query.end();
    }
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      lastEventTime = Date.now();
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation.
        setContinuation(config.providerName, event.continuation);
      } else if (event.type === 'result') {
        // Mark the initial batch completed so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for follow-ups.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(`Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`);
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(text: string, routing: RoutingContext): void {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = scratchpadParts
    .join('')
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .trim();

  // Single-destination shortcut: the agent wrote plain text — send to
  // the session's originating channel (from session_routing) if available,
  // otherwise fall back to the single destination.
  if (sent === 0 && scratchpad) {
    if (routing.channelType && routing.platformId) {
      // Reply to the channel/thread the message came from
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && scratchpad) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Inherit thread_id: prefer routing context (the thread the inbound came from);
  // if the inbound had no thread (e.g. agent-to-agent delivery, which always passes
  // threadId=null) but the destination matches the session's default channel+platform,
  // fall back to session_routing.thread_id so the reply lands in the session's
  // configured thread instead of defaulting to the channel's general topic.
  let threadId = routing.threadId;
  if (threadId === null && dest.type === 'channel') {
    const sr = getSessionRouting();
    if (sr.channel_type === channelType && sr.platform_id === platformId && sr.thread_id) {
      threadId = sr.thread_id;
    }
  }
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: threadId,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
