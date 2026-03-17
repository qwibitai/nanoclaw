/**
 * Extracted pure/testable functions from the agent runner.
 * These were previously embedded in index.ts's monolithic runQuery().
 */

import fs from 'fs';
import path from 'path';

// Types
export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface UsageData {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: UsageData;
}

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Pure functions

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function generateFallbackName(now: Date = new Date()): string {
  return `conversation-${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}`;
}

export function parseTranscript(content: string): ParsedMessage[] {
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
      // Skip malformed lines
    }
  }

  return messages;
}

export function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
  now: Date = new Date(),
): string {
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
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

/**
 * Load global CLAUDE.md policy from a given path.
 * Returns the file contents, or undefined if the file doesn't exist.
 */
export function loadGlobalPolicy(globalClaudeMdPath: string): string | undefined {
  if (fs.existsSync(globalClaudeMdPath)) {
    return fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  return undefined;
}

/**
 * Discover additional directories mounted at a base path.
 * Returns an array of absolute directory paths.
 */
export function discoverExtraDirs(extraBase: string): string[] {
  const dirs: string[] = [];
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        dirs.push(fullPath);
      }
    }
  }
  return dirs;
}

/**
 * Build the system prompt option for the SDK.
 */
export function buildSystemPrompt(globalClaudeMd: string | undefined): { type: 'preset'; preset: 'claude_code'; append: string } | undefined {
  if (globalClaudeMd) {
    return { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd };
  }
  return undefined;
}

/**
 * Build the MCP server config for the SDK.
 */
export function buildMcpConfig(mcpServerPath: string, containerInput: ContainerInput) {
  return {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      },
    },
  };
}

/**
 * The static allowed tools list for the SDK.
 */
export const ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*'
] as const;

/**
 * Build the initial prompt, prepending scheduled task header and draining pending IPC.
 */
export function buildInitialPrompt(
  basePrompt: string,
  isScheduledTask: boolean | undefined,
  pendingMessages: string[],
): string {
  let prompt = basePrompt;
  if (isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  if (pendingMessages.length > 0) {
    prompt += '\n' + pendingMessages.join('\n');
  }
  return prompt;
}

/**
 * Look up a session summary from the sessions index file.
 */
export function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
  readFileSync: typeof fs.readFileSync = fs.readFileSync,
  existsSync: typeof fs.existsSync = fs.existsSync,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(readFileSync(indexPath, 'utf-8') as string);
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch {
    // Failed to read sessions index
  }

  return null;
}

/**
 * Drain all pending IPC input messages from a directory.
 * Returns message texts found, or empty array.
 */
export function drainIpcInput(
  inputDir: string,
  fsModule: { mkdirSync: typeof fs.mkdirSync; readdirSync: typeof fs.readdirSync; readFileSync: typeof fs.readFileSync; unlinkSync: typeof fs.unlinkSync } = fs,
): string[] {
  try {
    fsModule.mkdirSync(inputDir, { recursive: true });
    const files = fsModule.readdirSync(inputDir)
      .filter(f => typeof f === 'string' && f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(inputDir, typeof file === 'string' ? file : String(file));
      try {
        const data = JSON.parse(fsModule.readFileSync(filePath, 'utf-8') as string);
        fsModule.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch {
        try { fsModule.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

/**
 * Check for _close sentinel file. Removes it if found.
 */
export function shouldClose(
  sentinelPath: string,
  fsModule: { existsSync: typeof fs.existsSync; unlinkSync: typeof fs.unlinkSync } = fs,
): boolean {
  if (fsModule.existsSync(sentinelPath)) {
    try { fsModule.unlinkSync(sentinelPath); } catch { /* ignore */ }
    return true;
  }
  return false;
}
