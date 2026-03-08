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
  // Add current date/time context so Agent knows today's date for scheduling
  const now = new Date();
  const userTz = process.env.TZ || 'Asia/Seoul';
  const currentDateLocal = now.toLocaleString('en-CA', { timeZone: userTz }).split(',')[0];
  const currentTimeLocal = now.toLocaleString('en-CA', { 
    timeZone: userTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const dayOfWeek = now.toLocaleString('en-US', { weekday: 'long', timeZone: userTz });
  
  const dateContext = `[CURRENT DATE/TIME: Today is ${currentDateLocal} (${dayOfWeek}), ${currentTimeLocal} in ${userTz} timezone. Use this for any scheduling, date calculations, or planning.]`;
  
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `${dateContext}\n\n<messages>\n${lines.join('\n')}\n</messages>`;
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
