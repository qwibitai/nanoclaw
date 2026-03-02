import { Channel, FileAttachment, NewMessage } from './types.js';
import { scrubCredentialsGeneric } from './redaction.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    let attrs = `sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"`;
    if (m.attachments && m.attachments.length > 0) {
      const attJson = JSON.stringify(m.attachments);
      attrs += ` attachments="${escapeXml(attJson)}"`;
    }
    return `<message ${attrs}>${escapeXml(m.content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Scrub credentials from outbound messages before sending to users.
 */
function scrubOutboundCredentials(text: string): string {
  return scrubCredentialsGeneric(text);
}

export function formatOutbound(rawText: string): string {
  rawText = scrubOutboundCredentials(rawText);
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  file?: FileAttachment,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, file);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
