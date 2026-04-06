import { Channel, NewMessage } from './types.js';
import { formatLocalTime, formatCurrentTime } from './timezone.js';

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

  const header = `<context timezone="${escapeXml(timezone)}" current_time="${escapeXml(formatCurrentTime(timezone))}" />\n`;

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

export interface ExtractedImage {
  path: string;
  caption?: string;
}

const IMAGE_TAG_RE = /<image\s+path="([^"]+)"(?:\s+caption="([^"]*)")?\s*\/>/g;

export function extractImages(text: string): {
  cleanText: string;
  images: ExtractedImage[];
} {
  const images: ExtractedImage[] = [];
  const cleanText = text
    .replace(IMAGE_TAG_RE, (_, path, caption) => {
      images.push({ path, caption: caption || undefined });
      return '';
    })
    .trim();
  return { cleanText, images };
}

export async function sendImages(
  channel: Channel,
  jid: string,
  images: ExtractedImage[],
): Promise<void> {
  if (!channel.sendPhoto) return;
  for (const img of images) {
    await channel.sendPhoto(jid, img.path, img.caption);
  }
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
