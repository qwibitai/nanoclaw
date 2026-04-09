import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

interface SessionEntry {
  sessionId?: string;
  summary?: string;
}

interface SessionsIndex {
  entries?: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TranscriptEntry {
  type?: string;
  message?: {
    content?: unknown;
  };
}

export interface ArchiveSessionTranscriptInput {
  groupFolder: string;
  sessionId: string;
  assistantName?: string;
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateTimestampName(now: Date): string {
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ];
  return `conversation-${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) return null;

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as SessionsIndex;
    const entry = index.entries?.find((item) => item.sessionId === sessionId);
    return entry?.summary?.trim() || null;
  } catch (err) {
    logger.warn(
      { sessionId, indexPath, err },
      'Failed to parse sessions index while archiving transcript',
    );
    return null;
  }
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' &&
      part !== null &&
      'text' in part &&
      typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string',
    )
    .map((part) => part.text as string)
    .join('');
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      if (entry.type === 'user') {
        const text = extractUserText(entry.message?.content).trim();
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant') {
        const text = extractAssistantText(entry.message?.content).trim();
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Ignore malformed lines; keep best-effort transcript archive.
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title: string | null,
  assistantName: string | undefined,
  now: Date,
): string {
  const formatDateTime = (date: Date) =>
    date.toLocaleString('en-US', {
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
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const clipped =
      msg.content.length > 2000 ? `${msg.content.slice(0, 2000)}...` : msg.content;
    lines.push(`**${sender}**: ${clipped}`);
    lines.push('');
  }

  return lines.join('\n');
}

function findTranscriptByFileName(
  projectsDir: string,
  sessionId: string,
): string | null {
  const targetFile = `${sessionId}.jsonl`;
  const stack = [projectsDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn(
        { projectsDir, dir, err },
        'Failed while scanning project transcript directories',
      );
      return null;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === targetFile) {
        return fullPath;
      }
    }
  }

  return null;
}

function findTranscriptPath(groupFolder: string, sessionId: string): string | null {
  const projectsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
  );
  const expectedPath = path.join(projectsDir, '-workspace-group', `${sessionId}.jsonl`);

  if (fs.existsSync(expectedPath)) return expectedPath;
  if (!fs.existsSync(projectsDir)) return null;

  return findTranscriptByFileName(projectsDir, sessionId);
}

export function archiveSessionTranscript(
  input: ArchiveSessionTranscriptInput,
): string | null {
  const { groupFolder, sessionId, assistantName } = input;

  try {
    const transcriptPath = findTranscriptPath(groupFolder, sessionId);
    if (!transcriptPath) {
      logger.info(
        { groupFolder, sessionId },
        'No transcript found while archiving session',
      );
      return null;
    }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) {
      logger.info(
        { groupFolder, sessionId, transcriptPath },
        'Transcript had no user/assistant text to archive',
      );
      return null;
    }

    const summary = getSessionSummary(sessionId, transcriptPath);
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const safeName = summary ? sanitizeFilename(summary) : generateTimestampName(now);

    const groupPath = resolveGroupFolderPath(groupFolder);
    const conversationsDir = path.join(groupPath, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const filePath = path.join(conversationsDir, `${date}-${safeName}.md`);
    const markdown = formatTranscriptMarkdown(messages, summary, assistantName, now);
    fs.writeFileSync(filePath, markdown);
    logger.info({ groupFolder, sessionId, filePath }, 'Archived session transcript');

    return filePath;
  } catch (err) {
    logger.warn(
      { groupFolder, sessionId, err },
      'Failed to archive session transcript',
    );
    return null;
  }
}
