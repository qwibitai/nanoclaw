import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

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

    // Build message XML with optional reply attributes
    let replyAttrs = '';
    if (m.is_reply) {
      const replyTo = m.reply_to_username ? ` reply_to="${escapeXml(m.reply_to_username)}"` : '';
      const replyToId = m.reply_to_message_id ? ` reply_to_id="${escapeXml(m.reply_to_message_id)}"` : '';
      replyAttrs = `${replyTo}${replyToId}`;

      // Debug: log reply metadata being formatted
      logger.debug(
        { id: m.id, sender: m.sender_name, is_reply: m.is_reply, reply_to_username: m.reply_to_username, reply_to_message_id: m.reply_to_message_id },
        'Formatting reply message',
      );
    }

    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttrs}>${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
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
