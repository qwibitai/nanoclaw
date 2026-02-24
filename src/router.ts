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
  const lines = messages.map((m) =>
    `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Convert markdown formatting to WhatsApp-compatible markup.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```
 */
export function markdownToWhatsApp(text: string): string {
  // Convert markdown headings to bold
  // ## Heading → *Heading*
  let result = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Convert **bold** or __bold__ to *bold* (WhatsApp bold is single *)
  // Must avoid converting already-single * patterns
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');

  // Convert [text](url) links to "text (url)" since WhatsApp auto-links URLs
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Convert horizontal rules to a visual separator
  result = result.replace(/^[-*_]{3,}$/gm, '─────────────');

  return result;
}

/**
 * Split a long message into chunks at natural boundaries.
 * WhatsApp handles long messages but readability drops past ~3000 chars.
 */
export function chunkMessage(text: string, maxLen = 3000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a paragraph break
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    // Fall back to a single newline
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLen);
    // Fall back to a space
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
    // Last resort: hard split
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return markdownToWhatsApp(text);
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
