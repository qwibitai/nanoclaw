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

export function stripModelTokens(text: string): string {
  return text.replace(
    /<\|(?:user|assistant|system|endoftext|im_start|im_end|end)\|?>/g,
    '',
  );
}

export function stripUnclosedInternalTag(text: string): string {
  return text.replace(/<internal>[\s\S]*$/g, '');
}

/**
 * Strip model artifacts from output text.
 * - Always: model special tokens (<|user|>, etc.) and closed <internal> pairs
 * - Final only: unclosed <internal> tags (during streaming, these may be incomplete)
 */
export function stripModelArtifacts(
  text: string,
  isFinal: boolean,
): string {
  let result = stripModelTokens(text);
  result = stripInternalTags(result);
  if (isFinal) {
    result = stripUnclosedInternalTag(result);
  }
  return result.trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripModelArtifacts(rawText, true);
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
