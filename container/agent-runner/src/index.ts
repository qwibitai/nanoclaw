/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Supports two providers selected via AGENT_PROVIDER:
 * - codex:  uses `codex exec` / `codex exec resume`
 * - claude: uses `@anthropic-ai/claude-agent-sdk`
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

type AgentProvider = 'codex' | 'claude';

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

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  item?: {
    type?: string;
    message?: string;
  };
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

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

const AGENT_PROVIDER: AgentProvider =
  process.env.AGENT_PROVIDER === 'claude' ? 'claude' : 'codex';

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const CODEX_HOME = process.env.CODEX_HOME || '/home/node/.codex';
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
const MEMORY_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const NANOCLAW_CONFIG_START = '# nanoclaw-managed-start';
const NANOCLAW_CONFIG_END = '# nanoclaw-managed-end';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

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

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(resolve => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise(resolve => {
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

function readFirstExistingFile(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    return fs.readFileSync(candidate, 'utf-8').trim();
  }
  return undefined;
}

function loadMemoryContext(containerInput: ContainerInput): string[] {
  const sections: string[] = [];

  const groupMemory = readFirstExistingFile(
    MEMORY_FILENAMES.map(name => path.join('/workspace/group', name)),
  );
  if (groupMemory) {
    sections.push(['Group memory and local instructions:', groupMemory].join('\n'));
  }

  if (!containerInput.isMain) {
    const globalMemory = readFirstExistingFile(
      MEMORY_FILENAMES.map(name => path.join('/workspace/global', name)),
    );
    if (globalMemory) {
      sections.push(['Global shared memory:', globalMemory].join('\n'));
    }
  }

  return sections;
}

function buildCodexPrompt(
  basePrompt: string,
  containerInput: ContainerInput,
): string {
  const sections = loadMemoryContext(containerInput);
  if (sections.length === 0) return basePrompt;

  return [
    'Additional NanoClaw context:',
    ...sections,
    '',
    'Current user message context:',
    basePrompt,
  ].join('\n\n');
}

function escapeTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function encodeTomlArray(values: string[]): string {
  return `[${values.map(escapeTomlString).join(', ')}]`;
}

function encodeTomlInlineTable(entries: Record<string, string>): string {
  const parts = Object.entries(entries).map(
    ([key, value]) => `${escapeTomlString(key)} = ${escapeTomlString(value)}`,
  );
  return `{ ${parts.join(', ')} }`;
}

function writeCodexConfig(
  mcpServerPath: string,
  containerInput: ContainerInput,
): void {
  fs.mkdirSync(CODEX_HOME, { recursive: true });

  const managedBlock = [
    NANOCLAW_CONFIG_START,
    '[features]',
    'rmcp_client = true',
    '',
    '[mcp_servers.nanoclaw]',
    `command = ${escapeTomlString('node')}`,
    `args = ${encodeTomlArray([mcpServerPath])}`,
    `env = ${encodeTomlInlineTable({
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    })}`,
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 120',
    NANOCLAW_CONFIG_END,
  ].join('\n');

  const existing = fs.existsSync(CODEX_CONFIG_PATH)
    ? fs.readFileSync(CODEX_CONFIG_PATH, 'utf-8')
    : '';
  const preserved = existing
    .replace(
      new RegExp(
        `${NANOCLAW_CONFIG_START}[\\s\\S]*?${NANOCLAW_CONFIG_END}\\n?`,
        'g',
      ),
      '',
    )
    .trim();

  fs.writeFileSync(
    CODEX_CONFIG_PATH,
    [preserved, managedBlock].filter(Boolean).join('\n\n') + '\n',
  );
}

function makeOutputFilePath(): string {
  return path.join(
    os.tmpdir(),
    `nanoclaw-codex-last-message-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
}

function parseCodexEvent(
  line: string,
  state: {
    newSessionId?: string;
    errorMessages: string[];
  },
): void {
  let event: CodexJsonEvent;
  try {
    event = JSON.parse(line) as CodexJsonEvent;
  } catch {
    return;
  }

  if (event.type === 'thread.started' && event.thread_id) {
    state.newSessionId = event.thread_id;
    return;
  }

  if (event.type === 'error' && event.message) {
    state.errorMessages.push(event.message);
    return;
  }

  if (
    event.type === 'item.completed' &&
    event.item?.type === 'error' &&
    event.item.message
  ) {
    state.errorMessages.push(event.item.message);
  }
}

async function runCodexTurn(
  prompt: string,
  sessionId: string | undefined,
): Promise<{
  exitCode: number | null;
  newSessionId?: string;
  result: string | null;
  stderr: string;
  errorMessages: string[];
}> {
  const outputFile = makeOutputFilePath();
  const eventState: { newSessionId?: string; errorMessages: string[] } = {
    errorMessages: [],
  };

  const args = sessionId
    ? [
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        '/workspace/group',
        '-o',
        outputFile,
        sessionId,
        '-',
      ]
    : [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-C',
        '/workspace/group',
        '-o',
        outputFile,
        '-',
      ];

  log(`Starting Codex turn (${sessionId ? `resume ${sessionId}` : 'new session'})`);

  return new Promise((resolve, reject) => {
    const proc = spawn('codex', args, {
      env: {
        ...process.env,
        CODEX_HOME,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) parseCodexEvent(line, eventState);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', chunk => {
      stderr += chunk;
      for (const line of chunk.split('\n')) {
        if (line.trim()) log(`codex stderr: ${line.trim()}`);
      }
    });

    proc.on('error', reject);
    proc.on('close', code => {
      if (stdoutBuffer.trim()) {
        parseCodexEvent(stdoutBuffer.trim(), eventState);
      }

      let result: string | null = null;
      try {
        if (fs.existsSync(outputFile)) {
          const content = fs.readFileSync(outputFile, 'utf-8').trim();
          result = content || null;
        }
      } catch (err) {
        eventState.errorMessages.push(
          `Failed to read Codex output file: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        try {
          fs.unlinkSync(outputFile);
        } catch {
          /* ignore */
        }
      }

      resolve({
        exitCode: code,
        newSessionId: eventState.newSessionId,
        result,
        stderr,
        errorMessages: eventState.errorMessages,
      });
    });

    proc.stdin.end(prompt);
  });
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
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
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
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
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* ignore bad lines */
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
    const content =
      msg.content.length > 2000 ? `${msg.content.slice(0, 2000)}...` : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async input => {
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
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

async function runClaudeQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

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

  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

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
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    },
  })) {
    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
    }

    if (message.type === 'result') {
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  resumeAt?: string,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  if (AGENT_PROVIDER === 'claude') {
    return runClaudeQuery(
      prompt,
      sessionId,
      mcpServerPath,
      containerInput,
      { ...process.env },
      resumeAt,
    );
  }

  writeCodexConfig(mcpServerPath, containerInput);
  const turnResult = await runCodexTurn(
    buildCodexPrompt(prompt, containerInput),
    sessionId,
  );
  const nextSessionId = turnResult.newSessionId || sessionId;

  if (turnResult.exitCode !== 0) {
    const details = [...turnResult.errorMessages, turnResult.stderr.trim()]
      .filter(Boolean)
      .join('\n');
    throw new Error(details || `Codex exited with code ${turnResult.exitCode}`);
  }

  writeOutput({
    status: 'success',
    result: turnResult.result,
    newSessionId: nextSessionId,
  });

  return {
    newSessionId: nextSessionId,
    closedDuringQuery: false,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(
      `Received input for group: ${containerInput.groupFolder} (provider: ${AGENT_PROVIDER})`,
    );
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  if (AGENT_PROVIDER === 'codex') {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
  }

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += `\n${pending.join('\n')}`;
  }

  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (provider: ${AGENT_PROVIDER}, session: ${sessionId || 'new'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      if (AGENT_PROVIDER === 'claude') {
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      }

      if (shouldClose()) {
        log('Close sentinel received after query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');
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
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
