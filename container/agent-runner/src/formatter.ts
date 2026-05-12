import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import type { ImageAttachment, ImageMediaType } from './providers/types.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  // Compose senderId with channel prefix so admin checks match the prefixed
  // entries in NANOCLAW_ADMIN_USER_IDS (e.g. 'telegram:8557164566').
  // Strip swarm suffix (e.g. 'telegram-finance' → 'telegram') the same way
  // router.ts:extractAndUpsertUser does. WhatsApp native adapters set
  // content.sender; Chat SDK bridge sets content.author.userId; either form
  // (or an already-prefixed content.senderId) works.
  const rawSender =
    (typeof content.senderId === 'string' && content.senderId) ||
    (typeof content.author?.userId === 'string' && content.author.userId) ||
    (typeof content.sender === 'string' && content.sender) ||
    null;
  const userKind = (msg.channel_type || '').split('-')[0];
  const senderId =
    rawSender === null
      ? null
      : rawSender.includes(':') || !userKind
        ? rawSender
        : `${userKind}:${rawSender}`;

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
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  if (messages.length === 0) return '';

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

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

  return parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    lines.push(formatSingleChat(msg));
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatTime(msg.timestamp);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  // Look up the destination name for the origin (reverse map lookup).
  // If not found, fall back to a raw channel:platform_id marker so nothing
  // gets silently dropped — this should only happen if the destination was
  // removed between when the message was received and when it's being processed.
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  const fromAttr = fromDest
    ? ` from="${escapeXml(fromDest.name)}"`
    : msg.channel_type || msg.platform_id
      ? ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`
      : '';

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${time}">${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const parts = ['[SCHEDULED TASK]'];
  if (content.scriptOutput) {
    parts.push('', 'Script output:', JSON.stringify(content.scriptOutput, null, 2));
  }
  parts.push('', 'Instructions:', content.prompt || '');
  return parts.join('\n');
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  return `[WEBHOOK: ${source}/${event}]\n\n${JSON.stringify(content.payload || content, null, 2)}`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  return `[SYSTEM RESPONSE]\n\nAction: ${content.action || 'unknown'}\nStatus: ${content.status || 'unknown'}\nResult: ${JSON.stringify(content.result || null)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender || 'Unknown';
  const text = replyTo.text || '';
  const preview = text.length > 100 ? text.slice(0, 100) + '…' : text;
  return `\n<reply-to sender="${escapeXml(sender)}">${escapeXml(preview)}</reply-to>\n`;
}

/**
 * Anthropic API limits: max ~5MB per image, jpeg/png/gif/webp only.
 * Base64-encoded length ≈ decoded * 4/3, so 5MB decoded ≈ 6.67MB encoded.
 */
const SUPPORTED_IMAGE_TYPES = new Set<ImageMediaType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BASE64_BYTES = 6_700_000;

/**
 * Extract image attachments from a batch of inbound messages, ready to send
 * as multimodal content blocks. Skips images that are oversized, missing
 * base64 data, or in unsupported formats — those are still referenced as
 * text in the formatted prompt via formatAttachments(), but don't reach
 * the model as visual content.
 */
export function extractImageAttachments(messages: MessageInRow[]): ImageAttachment[] {
  const images: ImageAttachment[] = [];
  for (const msg of messages) {
    const content = parseContent(msg.content);
    const attachments = content.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const att of attachments) {
      if (att?.type !== 'image') continue;
      if (typeof att.data !== 'string' || att.data.length === 0) continue;
      if (att.data.length > MAX_BASE64_BYTES) continue;
      const mediaType = (att.mimeType ?? 'image/jpeg') as ImageMediaType;
      if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) continue;
      images.push({ mediaType, data: att.data, name: att.name });
    }
  }
  return images;
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

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return timestamp;
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
