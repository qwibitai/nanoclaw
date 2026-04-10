import { Channel, NewMessage } from './types.js';
import { scrubSecrets } from './secret-scrubber.js';
import { formatLocalTime } from './timezone.js';
import { parseTextStyles, ChannelType } from './text-styles.js';

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
    const fromMe = m.is_from_me ? ' is_from_me="true"' : '';
    const isBot = m.is_any_bot || m.is_bot_message ? ' is_bot="true"' : '';
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" time="${escapeXml(displayTime)}"${fromMe}${isBot}${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<thread-title>[\s\S]*?<\/thread-title>/g, '')
    .trim();
}

/** Extract a `<thread-title>` value from raw agent output (before stripping). */
export function extractThreadTitle(raw: string): string | undefined {
  const m = raw.match(/<thread-title>([\s\S]*?)<\/thread-title>/);
  return m?.[1]?.trim().slice(0, 100) || undefined; // Discord 100-char limit
}

export function formatOutbound(rawText: string, channel?: ChannelType): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const styled = channel ? parseTextStyles(text, channel) : text;
  return scrubSecrets(styled);
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  triggerMessageId?: string | null,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, triggerMessageId);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
