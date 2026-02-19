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
    let inner = escapeXml(m.content);
    if (m.files?.length) {
      for (const f of m.files) {
        const containerPath = f.localPath.replace(/^data\/files\//, '/workspace/files/');
        inner += `\n<file name="${escapeXml(f.name)}" type="${escapeXml(f.mimetype)}" path="${escapeXml(containerPath)}" />`;
      }
    }
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${inner}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  // Strip properly closed <internal>...</internal> blocks
  let result = text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
  // Strip unclosed <internal> blocks (malformed closing tag or missing entirely)
  result = result.replace(/<internal>[\s\S]*/g, '');
  return result.trim();
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
