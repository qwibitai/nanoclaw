/**
 * Message formatting and outbound channel routing.
 * Docs map:
 * - docs/SPEC.md#message-flow
 * - docs/SPEC.md#commands
 */
import { Channel, NewMessage } from "./types.js";
import { formatLocalTime } from "./timezone.js";

export function escapeXml(s: string): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatMessages(messages: NewMessage[], timezone: string): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join("\n")}\n</messages>`;
}

export function formatMessagesWithCap(
  messages: NewMessage[],
  timezone: string,
  maxMessages: number = 200,
  totalCount?: number,
): string {
  const kept = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  const effectiveTotal = totalCount ?? messages.length;
  const omitted = effectiveTotal - kept.length;
  if (omitted <= 0) {
    return formatMessages(kept, timezone);
  }
  return `<note>${omitted} older messages omitted for context window</note>\n${formatMessages(kept, timezone)}`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return "";
  return text;
}

export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
