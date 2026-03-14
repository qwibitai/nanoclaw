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
  const lines = messages.map((m) => {
    // Build attribute string
    let attrs = `sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"`;

    // Add msg-id when the message provides addressable identity (for reactions/replies).
    // Channels that use "prefix-timestamp" IDs (e.g. "mychannel-1709123456") get the
    // timestamp extracted and combined with sender to form an addressable msg-id.
    if (m.sender) {
      const idParts = m.id.match(/^[a-z]+-(.+)$/);
      if (idParts) {
        attrs += ` msg-id="${idParts[1]}:${escapeXml(m.sender)}"`;
      }
    }

    // Add reply-to context if present
    if (m.quote) {
      const quoteText = m.quote.text.length > 100
        ? m.quote.text.slice(0, 100) + '...'
        : m.quote.text;
      attrs += ` replying-to="${escapeXml(m.quote.author)}: ${escapeXml(quoteText)}"`;
    }

    // Build child elements for attachments
    let attachmentElements = '';
    if (m.attachments && m.attachments.length > 0) {
      attachmentElements = m.attachments
        .map((a) => {
          let attAttrs = `type="${escapeXml(a.contentType)}" path="${escapeXml(a.containerPath)}"`;
          if (a.filename) attAttrs += ` filename="${escapeXml(a.filename)}"`;
          return `\n  <attachment ${attAttrs} />`;
        })
        .join('');
    }

    const content = escapeXml(m.content);
    if (attachmentElements) {
      return `<message ${attrs}>${content}${attachmentElements}\n</message>`;
    }
    return `<message ${attrs}>${content}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
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
  attachments?: string[],
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, attachments);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
