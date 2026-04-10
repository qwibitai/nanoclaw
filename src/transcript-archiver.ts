/**
 * Host-side transcript archiver.
 * Archives Claude session transcripts to the group's conversations/ directory.
 * Moved from agent-runner PreCompact hook to host side for provider-agnostic operation.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionsIndex {
  entries: Array<{
    sessionId: string;
    fullPath: string;
    summary: string;
    firstPrompt: string;
  }>;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // skip unparseable lines
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) return null;

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) return entry.summary;
  } catch (err) {
    logger.warn(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive a session transcript to the group's conversations/ directory.
 *
 * @param sessionId  The Claude session ID
 * @param claudeConfigDir  Path to the .claude dir (contains sessions/)
 * @param groupDir  Path to the group's workspace directory
 * @param assistantName  Optional name for the assistant in transcript
 */
export function archiveTranscript(
  sessionId: string,
  claudeConfigDir: string,
  groupDir: string,
  assistantName?: string,
): boolean {
  const transcriptPath = path.join(claudeConfigDir, 'sessions', sessionId, 'transcript.jsonl');

  if (!fs.existsSync(transcriptPath)) {
    logger.info(`No transcript found at ${transcriptPath}`);
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);

    if (messages.length === 0) {
      logger.info('No messages to archive');
      return false;
    }

    const summary = getSessionSummary(sessionId, transcriptPath);
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = path.join(groupDir, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
    fs.writeFileSync(filePath, markdown);

    logger.info(`Archived conversation to ${filePath}`);
    return true;
  } catch (err) {
    logger.warn(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
