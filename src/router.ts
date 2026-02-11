import { ASSISTANT_NAME } from './config.js';
import {
  isIndividualChat,
  VIRTUAL_COMPLAINT_GROUP_JID,
} from './channels/whatsapp.js';
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
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

export function formatOutbound(channel: Channel, rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  const prefix =
    channel.prefixAssistantName !== false ? `${ASSISTANT_NAME}: ` : '';
  return `${prefix}${text}`;
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

/**
 * Resolve the routing JID for a chat.
 * 1:1 individual chats route to the virtual complaint group.
 * Group chats and other JIDs route to themselves.
 */
export function resolveRouteJid(chatJid: string): string {
  if (isIndividualChat(chatJid)) {
    return VIRTUAL_COMPLAINT_GROUP_JID;
  }
  return chatJid;
}

/**
 * Format messages with user context for 1:1 chats.
 * Wraps the standard message XML with a <user-context> block containing
 * the sender's phone number and push name, so the container agent knows
 * who it's talking to.
 */
export function formatMessagesWithUserContext(
  messages: NewMessage[],
  phone: string,
  pushName: string,
): string {
  const userContext = `<user-context phone="${escapeXml(phone)}" name="${escapeXml(pushName)}" />`;
  const messagesXml = formatMessages(messages);
  return `${userContext}\n${messagesXml}`;
}
