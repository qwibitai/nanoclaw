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
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Patterns that match common API keys / tokens.
 * Matched strings are replaced with `[REDACTED]`.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /sk-ant-oat[A-Za-z0-9_-]{20,}/g, // Anthropic OAuth token
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI
  /gsk_[A-Za-z0-9_-]{20,}/g, // Groq
  /xai-[A-Za-z0-9_-]{20,}/g, // xAI
  /ghp_[A-Za-z0-9_]{36,}/g, // GitHub PAT classic
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub PAT fine-grained
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /AKIA[A-Z0-9]{16}/g, // AWS Access Key
  /Bearer\s+eyJ[A-Za-z0-9_-]{40,}/g, // Bearer JWT
  /AIza[A-Za-z0-9_-]{35,}/g, // Google API Key
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return redactSecrets(text);
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

/** Find a connected channel that handles a given agent type (for paired-room outbound routing). */
export function findChannelForAgent(
  channels: Channel[],
  agentType: string,
): Channel | undefined {
  return channels.find(
    (c) => c.isConnected() && c.handlesAgentType?.(agentType),
  );
}
