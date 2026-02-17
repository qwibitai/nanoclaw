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
    let attrs = `sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"`;
    if (m.media_type) {
      attrs += ` media_type="${escapeXml(m.media_type)}"`;
      // Convert host path to container path so the agent can access the file
      if (m.media_path) {
        const filename = m.media_path.split('/').pop() || '';
        attrs += ` media_path="/workspace/group/media/${escapeXml(filename)}"`;
      }
      if (m.media_mime) attrs += ` media_mime="${escapeXml(m.media_mime)}"`;
      if (m.media_filename)
        attrs += ` media_filename="${escapeXml(m.media_filename)}"`;
    }
    return `<message ${attrs}>${escapeXml(m.content)}</message>`;
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
