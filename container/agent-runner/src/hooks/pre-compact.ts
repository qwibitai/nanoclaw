/**
 * PreCompact hook for Claude CLI.
 * Archives the full transcript to conversations/ before context compaction.
 * Standalone script — reads hook input from stdin JSON, exits with 0.
 */

import fs from 'fs';
import path from 'path';

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}

interface SessionsIndex {
  entries: Array<{ sessionId: string; summary: string }>;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function log(message: string): void {
  console.error(`[pre-compact] ${message}`);
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const indexPath = path.join(
    path.dirname(transcriptPath),
    'sessions-index.json',
  );
  if (!fs.existsSync(indexPath)) return null;
  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    return (
      index.entries.find((e) => e.sessionId === sessionId)?.summary ?? null
    );
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const t = new Date();
  return `conversation-${t.getHours().toString().padStart(2, '0')}${t.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
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

  const lines: string[] = [
    `# ${title || 'Conversation'}`,
    '',
    `Archived: ${formatDateTime(now)}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const input: HookInput = JSON.parse(await readStdin());
  const { transcript_path, session_id } = input;

  if (!transcript_path || !fs.existsSync(transcript_path)) process.exit(0);

  const content = fs.readFileSync(transcript_path, 'utf-8');
  const messages = parseTranscript(content);
  if (messages.length === 0) process.exit(0);

  const summary = getSessionSummary(session_id, transcript_path);
  const name = summary ? sanitizeFilename(summary) : generateFallbackName();

  const conversationsDir = '/workspace/group/conversations';
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const filePath = path.join(conversationsDir, `${date}-${name}.md`);

  // Read assistant name written at container init
  const assistantNameFile = '/workspace/group/.assistant-name';
  const assistantName = fs.existsSync(assistantNameFile)
    ? fs.readFileSync(assistantNameFile, 'utf-8').trim()
    : undefined;

  fs.writeFileSync(
    filePath,
    formatTranscriptMarkdown(messages, summary, assistantName),
  );
  log(`Archived to ${filePath}`);
}

main().catch((err) => {
  console.error(`[pre-compact] Error: ${err}`);
  process.exit(0); // Don't fail the hook
});
