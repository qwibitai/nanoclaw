import { Channel, ClaudeAttachment, NewMessage } from './types.js';

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
    let body = escapeXml(m.content);
    if (m.media_path) {
      body += `\n[Media attached — use Read tool to view: /workspace/group/${m.media_path}]`;
    }
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${body}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

const CLAUDE_SUPPORTED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function normalizeMimeType(mimeType?: string): string | null {
  if (!mimeType) return null;
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0];
  return normalized || null;
}

function guessMimeTypeFromPath(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return null;
}

export function getClaudeAttachments(messages: NewMessage[]): ClaudeAttachment[] {
  const attachments: ClaudeAttachment[] = [];
  for (const message of messages) {
    if (!message.media_path) continue;
    const mimeType = normalizeMimeType(message.media_mime_type) || guessMimeTypeFromPath(message.media_path);
    if (!mimeType || !CLAUDE_SUPPORTED_ATTACHMENT_MIME_TYPES.has(mimeType)) continue;
    attachments.push({
      path: `/workspace/group/${message.media_path}`,
      mimeType,
    });
  }
  return attachments;
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
