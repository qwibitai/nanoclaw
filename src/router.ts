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
    // When a message is a reply to another, prepend a context line so the
    // agent knows which earlier message it refers to. Truncate quoted text
    // to keep the prompt manageable.
    let body = m.content;
    if (m.quoted_message_id) {
      const author = m.quoted_author || 'unknown';
      const snippet = (m.quoted_text || '').slice(0, 200);
      const prefix = `↩ Replying to [${author}, message ${m.quoted_message_id}]: "${snippet}"\n\n`;
      body = `${prefix}${body}`;
    }
    return `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" time="${escapeXml(displayTime)}">${escapeXml(body)}</message>`;
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
  // Strip image syntax — exfiltration vector (data encoded in URL)
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]')
    .replace(/<img[^>]*>/gi, '[image removed]');
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
