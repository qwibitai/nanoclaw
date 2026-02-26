/**
 * CamBot-Agent Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  ipcToken?: string;
}

interface ContainerTelemetry {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: { inputTokens: number; outputTokens: number };
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  toolInvocations: Array<{
    toolName: string;
    durationMs?: number;
    status: 'success' | 'error';
    inputSummary?: string;
    outputSummary?: string;
    error?: string;
  }>;
}

interface ToolInvocationEntry {
  toolName: string;
  startTime: number;
  durationMs?: number;
  status: 'success' | 'error';
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  telemetry?: ContainerTelemetry;
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

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_OWNER_FILE = '/workspace/ipc/_owner';
const IPC_POLL_MS = 500;

/** Token identifying this container instance. Set from ContainerInput. */
let ipcToken: string | undefined;

/**
 * Check whether this container is still the designated owner of the IPC
 * directory.  When a new container is spawned for the same group, the host
 * overwrites the _owner file with the new container's token.  Orphaned
 * containers detect the mismatch and exit gracefully.
 */
function isStillOwner(): boolean {
  if (!ipcToken) return true; // No token → backwards-compat, skip check
  try {
    const owner = fs.readFileSync(IPC_OWNER_FILE, 'utf-8').trim();
    return owner === ipcToken;
  } catch {
    return true; // File missing → assume still owner
  }
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

  /** Return any messages pushed but never consumed by the SDK. */
  drain(): string[] {
    const texts: string[] = [];
    for (const msg of this.queue) {
      const text = typeof msg.message.content === 'string' ? msg.message.content : '';
      if (text) texts.push(text);
    }
    this.queue.length = 0;
    return texts;
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

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---CAMBOT_AGENT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CAMBOT_AGENT_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
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
function createPreCompactHook(): HookCallback {
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

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function truncate(str: string | undefined, maxLen: number): string | undefined {
  if (!str) return undefined;
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function createPostToolUseHook(invocations: ToolInvocationEntry[], startTimes: Map<string, number>): HookCallback {
  return async (input, toolUseId, _context) => {
    const postInput = input as PostToolUseHookInput;
    const endTime = Date.now();
    const startTime = toolUseId ? startTimes.get(toolUseId) : undefined;

    invocations.push({
      toolName: postInput.tool_name,
      startTime: startTime ?? endTime,
      durationMs: startTime ? endTime - startTime : undefined,
      status: 'success',
      inputSummary: truncate(
        typeof postInput.tool_input === 'string'
          ? postInput.tool_input
          : JSON.stringify(postInput.tool_input),
        200,
      ),
      outputSummary: truncate(
        typeof postInput.tool_response === 'string'
          ? postInput.tool_response
          : JSON.stringify(postInput.tool_response),
        500,
      ),
    });

    return {};
  };
}

function createPostToolUseFailureHook(invocations: ToolInvocationEntry[]): HookCallback {
  return async (input, _toolUseId, _context) => {
    const failInput = input as { hook_event_name: string; tool_name: string; tool_input: unknown; error: string };

    invocations.push({
      toolName: failInput.tool_name,
      startTime: Date.now(),
      status: 'error',
      inputSummary: truncate(
        typeof failInput.tool_input === 'string'
          ? failInput.tool_input
          : JSON.stringify(failInput.tool_input),
        200,
      ),
      error: truncate(failInput.error, 500),
    });

    return {};
  };
}

function createPreToolUseTimingHook(startTimes: Map<string, number>): HookCallback {
  return async (_input, toolUseId, _context) => {
    if (toolUseId) {
      startTimes.set(toolUseId, Date.now());
    }
    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
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

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
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
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel or owner revocation.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  if (!isStillOwner()) {
    log('Owner token changed — this container has been superseded, exiting');
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Capture the message BEFORE unlinking — on Windows Docker bind
        // mounts, unlinkSync can throw ENOENT even after a successful read.
        if (data.type === 'message' && data.text) {
          // If message has a containerTag, only process if it matches our token.
          // Messages without a tag (initial prompt) are always accepted.
          // Do NOT delete non-matching files — the correct container must consume them.
          if (data.containerTag && ipcToken && data.containerTag !== ipcToken) {
            continue;
          }
          messages.push(data.text);
        }
        try { fs.unlinkSync(filePath); } catch { /* ignore ENOENT on bind mounts */ }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function buildModelUsage(
  raw: Record<string, Record<string, unknown>> | undefined,
): Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> {
  if (!raw) return {};
  const result: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
  for (const [model, usage] of Object.entries(raw)) {
    result[model] = {
      inputTokens: (usage.inputTokens as number) ?? 0,
      outputTokens: (usage.outputTokens as number) ?? 0,
      costUSD: (usage.costUSD as number) ?? 0,
    };
  }
  return result;
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; unconsumedMessages: string[]; telemetry?: ContainerTelemetry }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Telemetry: collect tool invocations during the query
  const toolInvocations: ToolInvocationEntry[] = [];
  const toolStartTimes = new Map<string, number>();

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let lastResultText: string | null = null;
  let queryTelemetry: ContainerTelemetry | undefined;

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
        'mcp__cambot-agent__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        'cambot-agent': {
          command: 'node',
          args: [mcpServerPath],
          env: {
            CAMBOT_AGENT_CHAT_JID: containerInput.chatJid,
            CAMBOT_AGENT_GROUP_FOLDER: containerInput.groupFolder,
            CAMBOT_AGENT_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [createSanitizeBashHook()] },
          { hooks: [createPreToolUseTimingHook(toolStartTimes)] },
        ],
        PostToolUse: [{ hooks: [createPostToolUseHook(toolInvocations, toolStartTimes)] }],
        PostToolUseFailure: [{ hooks: [createPostToolUseFailureHook(toolInvocations)] }],
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
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      // Suppress duplicate results (same text emitted twice by SDK/agent-teams)
      if (textResult && textResult === lastResultText) {
        log(`Result: suppressed duplicate of result #${resultCount}`);
        continue;
      }
      lastResultText = textResult || null;
      resultCount++;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // Extract telemetry from SDK result message
      const resultMsg = message as Record<string, unknown>;
      if (typeof resultMsg.total_cost_usd === 'number') {
        queryTelemetry = {
          totalCostUsd: resultMsg.total_cost_usd as number,
          durationMs: (resultMsg.duration_ms as number) ?? 0,
          durationApiMs: (resultMsg.duration_api_ms as number) ?? 0,
          numTurns: (resultMsg.num_turns as number) ?? 0,
          usage: {
            inputTokens: ((resultMsg.usage as Record<string, number>)?.input_tokens) ?? 0,
            outputTokens: ((resultMsg.usage as Record<string, number>)?.output_tokens) ?? 0,
          },
          modelUsage: buildModelUsage(resultMsg.modelUsage as Record<string, Record<string, unknown>> | undefined),
          toolInvocations: toolInvocations.map(t => ({
            toolName: t.toolName,
            durationMs: t.durationMs,
            status: t.status,
            inputSummary: t.inputSummary,
            outputSummary: t.outputSummary,
            error: t.error,
          })),
        };
        log(`Telemetry: cost=$${queryTelemetry.totalCostUsd.toFixed(4)}, turns=${queryTelemetry.numTurns}, tools=${toolInvocations.length}`);
      }

      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;

  // Drain any messages that pollIpcDuringQuery consumed from disk but the SDK
  // never read (race: IPC file arrived just as the query was ending).
  const unconsumedMessages = stream.drain();
  if (unconsumedMessages.length > 0) {
    log(`Recovered ${unconsumedMessages.length} unconsumed message(s) from stream`);
  }

  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, unconsumedMessages, telemetry: queryTelemetry };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Register IPC owner token for orphan detection
  ipcToken = containerInput.ipcToken;
  if (ipcToken) {
    if (!isStillOwner()) {
      log(`Owner mismatch at startup — this container is an orphan, exiting`);
      process.exit(0);
    }
    log(`IPC owner token: ${ipcToken}`);
  }

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Cumulative telemetry across all queries in this container session
  const cumulativeTelemetry: ContainerTelemetry = {
    totalCostUsd: 0,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    modelUsage: {},
    toolInvocations: [],
  };
  let queryCount = 0;

  function accumulateTelemetry(t: ContainerTelemetry): void {
    cumulativeTelemetry.totalCostUsd += t.totalCostUsd;
    cumulativeTelemetry.durationMs += t.durationMs;
    cumulativeTelemetry.durationApiMs += t.durationApiMs;
    cumulativeTelemetry.numTurns += t.numTurns;
    cumulativeTelemetry.usage.inputTokens += t.usage.inputTokens;
    cumulativeTelemetry.usage.outputTokens += t.usage.outputTokens;
    cumulativeTelemetry.toolInvocations.push(...t.toolInvocations);
    // Merge per-model usage
    for (const [model, usage] of Object.entries(t.modelUsage)) {
      const existing = cumulativeTelemetry.modelUsage[model];
      if (existing) {
        existing.inputTokens += usage.inputTokens;
        existing.outputTokens += usage.outputTokens;
        existing.costUSD += usage.costUSD;
      } else {
        cumulativeTelemetry.modelUsage[model] = { ...usage };
      }
    }
    queryCount++;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Emit per-query telemetry and accumulate for session total
      if (queryResult.telemetry) {
        accumulateTelemetry(queryResult.telemetry);
        writeOutput({ status: 'success', result: null, newSessionId: sessionId, telemetry: queryResult.telemetry });
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      // Check for messages consumed from IPC by pollIpcDuringQuery but never
      // read by the SDK (race: file arrived as the query was ending).
      // Also drain any IPC files that arrived after polling stopped.
      const recovered = queryResult.unconsumedMessages;
      const freshIpc = drainIpcInput();
      const pendingMessages = [...recovered, ...freshIpc];

      if (pendingMessages.length > 0) {
        log(`Immediate follow-up: ${pendingMessages.length} pending message(s)`);
        prompt = pendingMessages.join('\n');
        continue;
      }

      // Check for close sentinel before blocking on waitForIpcMessage
      if (shouldClose()) {
        log('Close sentinel received after query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    // Emit accumulated telemetry even on error so partial work isn't lost
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
      telemetry: queryCount > 0 ? cumulativeTelemetry : undefined,
    });
    process.exit(1);
  }

  // Emit cumulative session telemetry when multiple queries ran
  if (queryCount > 1) {
    log(`Session cumulative: queries=${queryCount}, cost=$${cumulativeTelemetry.totalCostUsd.toFixed(4)}, turns=${cumulativeTelemetry.numTurns}, tools=${cumulativeTelemetry.toolInvocations.length}`);
    writeOutput({ status: 'success', result: null, newSessionId: sessionId, telemetry: cumulativeTelemetry });
  }
}

main();
