/**
 * ThagomizerClaw — Message Router
 * Formats messages for agent context and routes outbound responses.
 */

import type { NewMessage, Env, RegisteredGroup } from './types.js';

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
  timezone = 'UTC',
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;
  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  return stripInternalTags(rawText);
}

function formatLocalTime(timestamp: string, timezone: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

export function matchesTrigger(
  content: string,
  assistantName: string,
): boolean {
  const escaped = assistantName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^@${escaped}\\b`, 'i');
  return pattern.test(content.trim());
}

export function shouldProcess(
  messages: NewMessage[],
  group: RegisteredGroup,
  assistantName: string,
): boolean {
  if (group.isMain) return true;
  if (group.requiresTrigger === false) return true;

  return messages.some(
    (m) => !m.is_bot_message && matchesTrigger(m.content, assistantName),
  );
}
