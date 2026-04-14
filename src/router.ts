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
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Normalize confidence markers in agent output for channel delivery.
 *
 * The agent emits:
 *   ✓ Verified: ...  — KNOWN fact with a source
 *   ~ Unverified: ... — REMEMBERED claim
 *   ? Unknown: ...   — unconfirmed claim
 *
 * For channels that support Unicode (WhatsApp, Telegram, Signal, Discord),
 * the markers pass through unchanged. For plain-text channels, map to text.
 */
export function normalizeConfidenceMarkers(
  text: string,
  plainText: boolean = false,
): string {
  if (!plainText) return text;
  return text
    .replace(/^✓ Verified:/gm, '[confirmed]')
    .replace(/^~ Unverified:/gm, '[from memory]')
    .replace(/^\? Unknown:/gm, '[uncertain]');
}

export function formatOutbound(
  rawText: string,
  plainText: boolean = false,
): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return normalizeConfidenceMarkers(text, plainText);
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
