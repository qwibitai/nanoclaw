import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const senderId = escapeXml(m.sender || '');
    const senderName = escapeXml(m.sender_name || m.sender || 'unknown');
    const time = escapeXml(displayTime);
    const metadataXml = renderMessageMetadata(m.metadata);
    if (!metadataXml) {
      return `<message sender="${senderName}" sender_id="${senderId}" time="${time}">${escapeXml(m.content)}</message>`;
    }
    return [
      `<message sender="${senderName}" sender_id="${senderId}" time="${time}">`,
      `<content>${escapeXml(m.content)}</content>`,
      metadataXml,
      `</message>`,
    ].join('\n');
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

function renderMessageMetadata(
  metadata?: Record<string, unknown>,
): string | null {
  if (!metadata || Object.keys(metadata).length === 0) return null;

  const lines: string[] = [];
  const remainder: Record<string, unknown> = { ...metadata };

  const source = takeString(remainder, 'source');
  const umo = takeString(remainder, 'umo');
  if (source || umo) {
    lines.push(renderSelfClosingTag('source', { name: source, umo }));
  }

  const platformName = takeString(remainder, 'platform_name');
  const platformId = takeString(remainder, 'platform_id');
  const sessionId = takeString(remainder, 'session_id');
  const chatId = takeString(remainder, 'chat_id');
  if (platformName || platformId || sessionId || chatId) {
    lines.push(
      renderSelfClosingTag('platform', {
        name: platformName,
        id: platformId,
        session_id: sessionId,
        chat_id: chatId,
      }),
    );
  }

  const groupName = takeString(remainder, 'group_name');
  const groupId = takeString(remainder, 'group_id');
  const isGroup = takeBoolean(remainder, 'is_group');
  const isWake = takeBoolean(remainder, 'is_at_or_wake_command');
  if (groupName || groupId || isGroup !== undefined || isWake !== undefined) {
    lines.push(
      renderSelfClosingTag('conversation', {
        group_name: groupName,
        group_id: groupId,
        is_group: booleanAttr(isGroup),
        is_at_or_wake_command: booleanAttr(isWake),
      }),
    );
  }

  const senderProfile = takeObject(remainder, 'sender_profile');
  if (senderProfile) {
    lines.push(
      renderSelfClosingTag('sender_profile', objectAttrs(senderProfile)),
    );
  }

  const reply = takeObject(remainder, 'reply');
  if (reply) {
    const { replyTarget, replyContextChain } = splitReplyMetadata(reply);
    lines.push(renderStructuredBlock('reply_target', replyTarget));
    if (replyContextChain.length > 0) {
      const renderedContextChain = replyContextChain
        .map((context, index) =>
          renderStructuredBlock('reply_context', {
            depth: index + 1,
            ...context,
          }),
        )
        .join('\n');
      lines.push(
        `<reply_context_chain>\n${renderedContextChain}\n</reply_context_chain>`,
      );
    }
  }

  const attachments = takeArray(remainder, 'attachments');
  if (attachments.length > 0) {
    const renderedAttachments = attachments
      .map((attachment) => {
        if (!isRecord(attachment)) {
          return `<attachment>${escapeXml(JSON.stringify(attachment))}</attachment>`;
        }
        return renderStructuredBlock('attachment', attachment);
      })
      .join('\n');
    lines.push(`<attachments>\n${renderedAttachments}\n</attachments>`);
  }

  const segments = takeArray(remainder, 'segments');
  if (segments.length > 0) {
    const renderedSegments = segments
      .map((segment) => {
        if (!isRecord(segment)) {
          return `<segment>${escapeXml(JSON.stringify(segment))}</segment>`;
        }
        return renderStructuredBlock('segment', segment);
      })
      .join('\n');
    lines.push(`<segments>\n${renderedSegments}\n</segments>`);
  }

  if (Object.keys(remainder).length > 0) {
    lines.push(
      `<metadata_json>${escapeXml(JSON.stringify(remainder))}</metadata_json>`,
    );
  }

  return lines.join('\n');
}

function renderStructuredBlock(
  tagName: string,
  value: Record<string, unknown>,
): string {
  const attrs = objectAttrs(value, ['content', 'text', 'segments']);
  const content = takeNestedText(value);
  const childSegments = Array.isArray(value.segments)
    ? value.segments.filter(isRecord)
    : [];
  const extraEntries = Object.entries(value).filter(([key, raw]) => {
    if (['content', 'text', 'segments'].includes(key)) return false;
    if (raw === null || raw === undefined) return false;
    return typeof raw === 'object';
  });

  if (!content && childSegments.length === 0 && extraEntries.length === 0) {
    return renderSelfClosingTag(tagName, attrs);
  }

  const lines = [`<${tagName}${renderAttrs(attrs)}>`];
  if (content) lines.push(`<content>${escapeXml(content)}</content>`);
  for (const child of childSegments) {
    lines.push(renderStructuredBlock('segment', child));
  }
  if (extraEntries.length > 0) {
    lines.push(
      `<metadata_json>${escapeXml(
        JSON.stringify(Object.fromEntries(extraEntries)),
      )}</metadata_json>`,
    );
  }
  lines.push(`</${tagName}>`);
  return lines.join('\n');
}

function splitReplyMetadata(reply: Record<string, unknown>): {
  replyTarget: Record<string, unknown>;
  replyContextChain: Record<string, unknown>[];
} {
  const replyTarget = cloneRecord(reply);
  const replyContextChain = collectNestedReplyContexts(replyTarget.raw);

  if (isRecord(replyTarget.raw)) {
    const sanitizedRaw = stripNestedReplyReferences(replyTarget.raw);
    if (Object.keys(sanitizedRaw).length > 0) {
      replyTarget.raw = sanitizedRaw;
    } else {
      delete replyTarget.raw;
    }
  }

  return { replyTarget, replyContextChain };
}

function collectNestedReplyContexts(value: unknown): Record<string, unknown>[] {
  const contexts: Record<string, unknown>[] = [];
  collectNestedReplyContextsInto(value, contexts);
  return contexts;
}

function collectNestedReplyContextsInto(
  value: unknown,
  contexts: Record<string, unknown>[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedReplyContextsInto(item, contexts);
    }
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (isReplyLikeKey(key) && isRecord(nested)) {
      const normalized = normalizeReplyContext(nested);
      if (normalized) contexts.push(normalized);
      collectNestedReplyContextsInto(nested, contexts);
      continue;
    }
    if (key === 'segments' && Array.isArray(nested)) {
      for (const segment of nested) {
        if (!isRecord(segment)) continue;
        if (isReplyLikeSegment(segment)) {
          const normalized = normalizeReplyContext(segment);
          if (normalized) contexts.push(normalized);
        }
        collectNestedReplyContextsInto(segment, contexts);
      }
      continue;
    }
    collectNestedReplyContextsInto(nested, contexts);
  }
}

function stripNestedReplyReferences(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, nested] of Object.entries(value)) {
    if (isReplyLikeKey(key)) continue;

    if (key === 'segments' && Array.isArray(nested)) {
      const keptSegments = nested.flatMap((segment) => {
        if (!isRecord(segment) || isReplyLikeSegment(segment)) return [];
        return [stripNestedStructuredValue(segment)];
      });
      if (keptSegments.length > 0) sanitized[key] = keptSegments;
      continue;
    }

    if (isRecord(nested)) {
      const stripped = stripNestedReplyReferences(nested);
      if (Object.keys(stripped).length > 0) sanitized[key] = stripped;
      continue;
    }

    if (Array.isArray(nested)) {
      const keptItems = nested.flatMap((item) => {
        if (isRecord(item)) {
          const stripped = stripNestedReplyReferences(item);
          return Object.keys(stripped).length > 0 ? [stripped] : [];
        }
        return [item];
      });
      if (keptItems.length > 0) sanitized[key] = keptItems;
      continue;
    }

    if (nested !== null && nested !== undefined) {
      sanitized[key] = nested;
    }
  }

  return sanitized;
}

function stripNestedStructuredValue(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return stripNestedReplyReferences(value);
}

function normalizeReplyContext(
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  const context: Record<string, unknown> = {};

  const messageId = pickString(value, [
    'message_id',
    'id',
    'message_seq',
    'msg_id',
  ]);
  if (messageId) context.message_id = messageId;

  const senderId = pickString(value, ['sender_id', 'user_id']);
  if (senderId) context.sender_id = senderId;

  const senderName = pickString(value, [
    'sender_name',
    'nickname',
    'name',
    'card',
  ]);
  if (senderName) context.sender_name = senderName;

  const timestamp = pickPrimitive(value, ['timestamp', 'time', 'time_seconds']);
  if (timestamp !== undefined) context.timestamp = timestamp;

  const content = takeNestedText(value);
  if (content) context.content = content;

  return Object.keys(context).length > 0 ? context : null;
}

function pickString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
}

function pickPrimitive(
  value: Record<string, unknown>,
  keys: string[],
): string | number | boolean | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (
      typeof candidate === 'string' ||
      typeof candidate === 'number' ||
      typeof candidate === 'boolean'
    ) {
      return candidate;
    }
  }
  return undefined;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (Array.isArray(nested)) {
      clone[key] = nested.map((item) =>
        isRecord(item) ? cloneRecord(item) : item,
      );
      continue;
    }
    clone[key] = isRecord(nested) ? cloneRecord(nested) : nested;
  }
  return clone;
}

function isReplyLikeKey(key: string): boolean {
  return [
    'reply',
    'quote',
    'reply_to',
    'quoted_message',
    'reply_message',
    'message_reference',
    'source_message',
  ].includes(key);
}

function isReplyLikeSegment(segment: Record<string, unknown>): boolean {
  const type = segment.type;
  return (
    typeof type === 'string' &&
    ['reply', 'quote', 'reference', 'source'].includes(type)
  );
}

function renderSelfClosingTag(
  tagName: string,
  attrs: Record<string, string | undefined>,
): string {
  return `<${tagName}${renderAttrs(attrs)} />`;
}

function renderAttrs(attrs: Record<string, string | undefined>): string {
  const parts = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => ` ${key}="${escapeXml(value || '')}"`);
  return parts.join('');
}

function objectAttrs(
  value: Record<string, unknown>,
  exclude: string[] = [],
): Record<string, string | undefined> {
  const attrs: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (exclude.includes(key) || raw === null || raw === undefined) continue;
    if (typeof raw === 'string') {
      attrs[key] = raw;
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      attrs[key] = String(raw);
    }
  }
  return attrs;
}

function takeNestedText(value: Record<string, unknown>): string {
  if (typeof value.content === 'string' && value.content) return value.content;
  if (typeof value.text === 'string' && value.text) return value.text;
  return '';
}

function takeString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  delete obj[key];
  return typeof value === 'string' && value ? value : undefined;
}

function takeBoolean(
  obj: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = obj[key];
  delete obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function takeObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key];
  delete obj[key];
  return isRecord(value) ? value : undefined;
}

function takeArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  delete obj[key];
  return Array.isArray(value) ? value : [];
}

function booleanAttr(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
