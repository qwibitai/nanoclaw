/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via JSON-RPC over stdio
 *
 * Input protocol:
 *   JSON-RPC initialize request with ContainerInput as params
 *   Follow-up messages arrive as JSON-RPC 'input' notifications
 *   Session end signaled by JSON-RPC 'close' notification
 *
 * Output protocol:
 *   JSON-RPC notifications: 'output' (results), 'ipc' (MCP tool calls), 'log' (debug)
 */

// MUST be first import — intercepts stdout before SDK or anything else captures it
import { JsonRpcTransport } from './jsonrpc-transport.js';

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcpServer } from './ipc-mcp-inprocess.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  /** Return any unconsumed messages still in the queue. */
  remaining(): string[] {
    return this.queue.splice(0).map(m => m.message.content);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
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
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
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
 * Run a single query and stream results via transport notifications.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also drains transport events (follow-up input, close) during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServer: ReturnType<typeof createIpcMcpServer>,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  transport: JsonRpcTransport,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Drain transport events during query
  let draining = true;
  let closedDuringQuery = false;
  const drainLoop = async () => {
    while (draining) {
      const event = await transport.nextEvent();
      if (!event) break;
      if (event.type === 'close') {
        log('Close received during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        draining = false;
        break;
      }
      if (event.type === 'input') {
        log(`Piping input into active query (${event.text.length} chars)`);
        stream.push(event.text);
      }
    }
  };
  drainLoop().catch((err) => {
    log(`drainLoop error: ${err instanceof Error ? err.message : String(err)}`);
  });

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: mcpServer,
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      transport.sendNotification('output', {
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  draining = false;
  transport.cancelWait();

  // Re-queue any input that drainLoop pushed to stream but the SDK never consumed.
  // Without this, a follow-up arriving as the query finishes would be silently dropped.
  const leftover = stream.remaining();
  if (leftover.length > 0) {
    log(`Re-queuing ${leftover.length} unconsumed message(s) back to transport`);
    transport.unshift(...leftover.map(text => ({ type: 'input' as const, text })));
  }

  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  // Transport must be created first (stdout interception already active from import)
  const transport = new JsonRpcTransport();

  // Wait for host to send initialize request with ContainerInput
  const INIT_TIMEOUT_MS = 30_000;
  let initTimer: ReturnType<typeof setTimeout>;
  const containerInput: ContainerInput = await Promise.race([
    transport.initialized,
    new Promise<never>((_, reject) => {
      initTimer = setTimeout(() => reject(new Error('No initialize request received')), INIT_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(initTimer!));
  log(`Received input for group: ${containerInput.groupFolder}`);

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  // Create in-process MCP server
  const mcpServer = createIpcMcpServer(transport, {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isMain: containerInput.isMain,
  });

  let sessionId = containerInput.sessionId;

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Slash command handling — runs in isolation (no tools, no MCP)
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  if (KNOWN_SESSION_COMMANDS.has(trimmedPrompt)) {
    log(`Session command detected: ${trimmedPrompt}`);

    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    for await (const message of query({
      prompt: trimmedPrompt,
      options: {
        cwd: '/workspace/group',
        resume: sessionId,
        allowedTools: [],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        },
      }
    })) {
      const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
      log(`[slash-cmd] type=${msgType}`);

      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        log(`Session initialized: ${sessionId}`);
      }

      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        compactBoundarySeen = true;
        log('Compact boundary observed');
      }

      if (message.type === 'result') {
        const resultSubtype = message.subtype;
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        log(`Slash result: subtype=${resultSubtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

        if (resultSubtype?.startsWith('error')) {
          hadError = true;
          transport.sendNotification('output', {
            status: 'error', result: textResult || null, newSessionId: sessionId,
          });
        } else {
          transport.sendNotification('output', {
            status: 'success', result: textResult || null, newSessionId: sessionId,
          });
        }
        resultEmitted = true;
      }
    }

    if (!compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed');
    }
    if (!resultEmitted) {
      transport.sendNotification('output', {
        status: hadError ? 'error' : 'success',
        result: compactBoundarySeen ? null : 'compact_boundary was not observed',
        newSessionId: sessionId,
      });
    }

    return;
  }

  // Query loop: run query → wait for transport event → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServer, containerInput, sdkEnv, transport, resumeAt);
      if (queryResult.newSessionId) sessionId = queryResult.newSessionId;
      if (queryResult.lastAssistantUuid) resumeAt = queryResult.lastAssistantUuid;

      if (queryResult.closedDuringQuery) {
        log('Close received during query, exiting');
        break;
      }

      // Emit session update so host can track it
      transport.sendNotification('output', { status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next input...');

      const nextEvent = await transport.nextEvent();
      if (!nextEvent || nextEvent.type === 'close') {
        log('Close received, exiting');
        break;
      }

      log(`Got new message (${nextEvent.text.length} chars), starting new query`);
      prompt = nextEvent.text;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    transport.sendNotification('output', {
      status: 'error', result: null, newSessionId: sessionId, error: errorMessage
    });
    process.exit(1);
  }
}

main().then(() => process.exit(0));
