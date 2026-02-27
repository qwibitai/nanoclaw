import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}


/**
 * Scrub credentials from outbound messages before sending to users.
 */
function scrubOutboundCredentials(text: string): string {
  return text
    .replace(/\b(sk|pk|xai|gsk|eyJ)[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, '$1[REDACTED]')
    .replace(/\b(or-|ant-|sk-ant-)[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '[REDACTED]')
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, '[REDACTED]')
    .replace(/(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]');
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
