import { getSessionRouting } from './db/session-routing.js';
import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files', '/kill']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  return text.toLowerCase().startsWith('/clear');
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg).category;
  return cat === 'admin' || cat === 'passthrough';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  /**
   * When true, suppress streaming status writes (`> 💭 ...`) for this turn.
   * Final chat messages still go out — the agent decides whether to write
   * one. Set when any task in the inbound batch carries `quietStatus: true`
   * in its content JSON. Used by background maintenance tasks where only
   * notable findings should reach chat.
   */
  quietStatus: boolean;
}

/**
 * Extract routing context from a batch of messages.
 *
 * Routing rule: if the first non-system message has `platform_id` set,
 * treat its three routing fields (platform_id, channel_type, thread_id) as
 * an authoritative atomic unit — including `thread_id=null`, which means
 * "post to the channel root, no thread". Only when the message itself has
 * no platform_id (e.g. agent-to-agent inbounds with channel_type='agent'
 * and no platform info) do we fall back to session_routing.
 *
 * Why the unit-fallback matters:
 *   - Daily background tasks like wiki-synthesise are scheduled with
 *     destination={platformId:..., channelType:..., threadId:null} so the
 *     report posts to the channel root. Without unit-fallback, the
 *     null-coalescing operator treats the explicit-null thread_id as
 *     "missing" and falls back to session_routing.thread_id — which is
 *     whatever thread last woke the session — and the report lands in
 *     that thread instead of the channel root.
 *   - Agent-to-agent inbounds have channel_type='agent' and no platform
 *     info; the reply needs to route to the originating session's
 *     channel/thread, so per-field session_routing fallback is correct
 *     for that case (gated by `platform_id == null`).
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  // Skip system rows when picking the routing anchor — recall_context system
  // messages (id `recall-<targetId>`) are inserted before their paired inbound
  // message and would otherwise hijack `inReplyTo`, making outbound replies
  // attach to `recall-X` instead of the real user message X.
  //
  // Task rows take priority over chat rows: scheduled tasks fire on a clock,
  // not in response to a conversation, so the task is always the wake reason
  // for any batch it appears in. Without this, a task firing while an older
  // chat row is still pending in the batch (e.g. host hadn't synced
  // processing_ack yet, or container restart wiped processing claims) would
  // route the task's response into the chat's thread instead of the channel
  // root the host stamped the task with.
  const taskRow = messages.find((m) => m.kind === 'task');
  const first = taskRow ?? messages.find((m) => m.kind !== 'system') ?? messages[0];
  const sessionRouting = getSessionRouting();
  // Quiet-status mode: any task in the batch carrying `quietStatus: true`
  // in its content JSON suppresses streaming status writes for the turn.
  // Tasks rarely batch with chat messages, but if they did the chat
  // shouldn't get silenced — so this is conservative: only quiet when
  // ALL non-task messages would also be no-op (currently: when the batch
  // is task-only).
  const quietStatus = messages.every((m) => {
    if (m.kind !== 'task') return false;
    try {
      const c = JSON.parse(m.content);
      return c?.quietStatus === true;
    } catch {
      return false;
    }
  });
  // Treat (platform_id, channel_type, thread_id) as a unit. `platform_id`
  // is the discriminator — when set, the message itself specifies WHERE
  // to go and we respect even an explicit null thread_id (= channel root).
  const useOwnRouting = first?.platform_id != null;
  return {
    platformId: useOwnRouting ? first.platform_id : (sessionRouting.platform_id ?? null),
    channelType: useOwnRouting ? (first.channel_type ?? null) : (sessionRouting.channel_type ?? null),
    threadId: useOwnRouting ? (first.thread_id ?? null) : (sessionRouting.thread_id ?? null),
    inReplyTo: first?.id ?? null,
    quietStatus,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 *
 * Spawn envelopes handled:
 * - {_spawn: {task_id}, text}: renders text as prompt; surfaces task_id as system context.
 * - {_spawn_cancel: {task_id, reason}}: renders as a structured system note (kind='system').
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  // Detect spawn envelope in the first chat message and inject a system fact.
  // The _spawn.task_id is surfaced before the prompt so the agent knows it
  // is operating as a spawned child and can reference its own task_id.
  let spawnTaskId: string | null = null;
  if (chatMessages.length > 0) {
    const firstContent = parseContent(chatMessages[0].content);
    const envelope = detectSpawnEnvelope(firstContent);
    if (envelope) {
      spawnTaskId = envelope.taskId;
    }
  }

  if (spawnTaskId) {
    parts.push(`[Spawn context]\ntask_id: ${spawnTaskId}\nYou are running as a spawned task. Use spawn_progress, spawn_complete, or spawn_failed to report status to the orchestrator.`);
  }

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

/**
 * Detect whether a chat message carries a spawn envelope ({_spawn: {task_id}, text}).
 * Returns the envelope and plain text if present, null otherwise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectSpawnEnvelope(content: any): { taskId: string; text: string } | null {
  if (typeof content !== 'object' || content === null) return null;
  const spawn = content._spawn;
  if (typeof spawn !== 'object' || spawn === null) return null;
  const taskId = spawn.task_id;
  if (typeof taskId !== 'string') return null;
  return { taskId, text: (content.text as string) || '' };
}

/**
 * Render a chat batch, splitting by trigger flag: trigger=1 are messages the
 * bot was addressed in (need a reply); trigger=0 are accumulated context
 * (`ignored_message_policy='accumulate'` on a non-engaging message). Both
 * reach the prompt — the bot needs surrounding thread context to answer
 * well — but only the addressed rows call for a response.
 *
 * Context is emitted first so the agent reads the backdrop before the
 * message it's expected to act on.
 */
function formatChatMessages(messages: MessageInRow[]): string {
  const triggers = messages.filter((m) => m.trigger === 1);
  const context = messages.filter((m) => m.trigger !== 1);

  if (context.length === 0) {
    if (messages.length === 1) return formatSingleChat(messages[0]);
    const lines = ['<messages>'];
    for (const msg of messages) lines.push(formatSingleChat(msg));
    lines.push('</messages>');
    return lines.join('\n');
  }

  const parts: string[] = [];
  parts.push(
    '<thread_context note="Other people in this thread sent these. You were NOT addressed in them — they are here so you have the conversation up to now. Do not respond to or reason about them as if they were directed at you.">',
  );
  for (const m of context) parts.push(formatSingleChat(m));
  parts.push('</thread_context>');

  if (triggers.length > 0) {
    const note = triggers.length === 1 ? 'Respond to this.' : 'Respond to these.';
    parts.push(`<addressed_to_you note="${note}">`);
    for (const m of triggers) parts.push(formatSingleChat(m));
    parts.push('</addressed_to_you>');
  }

  return parts.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);

  // Spawn envelope: render text field only, suppress _spawn JSON
  const envelope = detectSpawnEnvelope(content);
  if (envelope) {
    const time = formatLocalTime(msg.timestamp, TIMEZONE);
    const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
    const fromAttr = originAttr(msg);
    return `<message${idAttr}${fromAttr} sender="orchestrator" time="${escapeXml(time)}">${escapeXml(envelope.text)}</message>`;
  }

  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  const fromAttr = originAttr(msg);

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

/**
 * Build a ` from="destination_name"` attribute string from a message's routing
 * fields. Shared by all formatters so the agent always knows where a message
 * originated — critical for explicit addressing.
 */
function originAttr(msg: MessageInRow): string {
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  if (fromDest) return ` from="${escapeXml(fromDest.name)}"`;
  if (msg.channel_type || msg.platform_id) {
    return ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`;
  }
  return '';
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const from = originAttr(msg);
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const parts: string[] = [];
  if (content.scriptOutput) {
    parts.push('Script output:', JSON.stringify(content.scriptOutput, null, 2), '');
  }
  parts.push('Instructions:', content.prompt || '');
  return `<task${from} time="${escapeXml(time)}">${parts.join('\n')}</task>`;
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  const from = originAttr(msg);
  return `<webhook${from} source="${escapeXml(source)}" event="${escapeXml(event)}">${JSON.stringify(content.payload || content, null, 2)}</webhook>`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);

  // Mnemon recall context: ambient memory injected by the host before each
  // user turn. Plain text by design — the agent reads it as background
  // context, not a structured system response to act on.
  if (content.subtype === 'recall_context') {
    return `[Recalled context]\n${content.text}`;
  }

  // Spawn cancellation: render as a structured directive, not raw JSON.
  // Per design §4 S26: the orchestrator signals the child to flush and exit.
  if (content._spawn_cancel && typeof content._spawn_cancel === 'object') {
    const reason = (content._spawn_cancel.reason as string | undefined) ?? '(none)';
    return `[Spawn cancelled]\nThis task was cancelled by the orchestrator (reason: ${reason}). Please flush any in-flight work and exit cleanly.`;
  }

  const from = originAttr(msg);
  return `<system_response${from} action="${escapeXml(content.action || 'unknown')}" status="${escapeXml(content.status || 'unknown')}">${JSON.stringify(content.result || null)}</system_response>`;
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}
