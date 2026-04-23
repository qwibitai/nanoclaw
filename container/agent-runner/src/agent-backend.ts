import fs from 'fs';
import path from 'path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  query,
  type HookCallback,
  type PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

export const AGENT_BACKEND_TYPES = ['claudeCode', 'codex'] as const;
export type AgentBackendType = (typeof AGENT_BACKEND_TYPES)[number];

export interface ClaudeCodeBackendOptions {
  type: 'claudeCode';
}

export interface CodexBackendOptions {
  type: 'codex';
}

export type AgentBackendOptions =
  | ClaudeCodeBackendOptions
  | CodexBackendOptions;

export interface McpServerRuntimeConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RuntimeContainerInput {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName?: string;
  mcpServers?: Record<string, McpServerRuntimeConfig> | null;
  actionsAuth?: { url: string; token: string } | null;
}

export interface RuntimeQueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

export interface QueryRunnerInput<
  TContainerInput extends RuntimeContainerInput = RuntimeContainerInput,
> {
  prompt: string;
  sessionId: string | undefined;
  mcpServerPath: string;
  containerInput: TContainerInput;
  sdkEnv: Record<string, string | undefined>;
  resumeAt?: string;
}

export interface QueryRunner<
  TContainerInput extends RuntimeContainerInput = RuntimeContainerInput,
> {
  run(input: QueryRunnerInput<TContainerInput>): Promise<RuntimeQueryResult>;
}

export interface QueryRunnerDependencies<
  TContainerInput extends RuntimeContainerInput = RuntimeContainerInput,
> {
  log: (message: string) => void;
  writeOutput: (output: RuntimeOutput) => void;
}

export interface AgentBackendRunnerFactory {
  create<TContainerInput extends RuntimeContainerInput>(
    agentBackend: AgentBackendOptions,
    deps: QueryRunnerDependencies<TContainerInput>,
  ): QueryRunner<TContainerInput>;
}

interface InstructionContext {
  agentInstructions?: string;
  globalInstructions?: string;
  hasGlobalMemory: boolean;
}

interface RuntimeStateOutput {
  type: 'state';
  state: 'active';
  newSessionId?: string;
  reason: 'query_started';
}

interface RuntimeResultOutput {
  type: 'result';
  result: string | null;
  newSessionId?: string;
}

interface RuntimeSdkMessageOutput {
  type: 'sdk_message';
  sdkType: string;
  sdkSubtype?: string;
  message: unknown;
}

export type RuntimeOutput =
  | RuntimeStateOutput
  | RuntimeResultOutput
  | RuntimeSdkMessageOutput;

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
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

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

const WORKSPACE_AGENT_DIR = '/workspace/agent';
const WORKSPACE_GLOBAL_DIR = '/workspace/global';
const WORKSPACE_EXTRA_DIR = '/workspace/extra';
export const WORKSPACE_GROUP_DIR = '/workspace/group';
export const IPC_INPUT_DIR = '/workspace/ipc/input';
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;
const CODEX_HOME_DIR = '/home/node/.codex';
const PRIMARY_INSTRUCTION_FILE = 'CLAUDE.md';
const COMPAT_INSTRUCTION_FILE = 'AGENTS.md';
const INSTRUCTION_FILE_NAMES = [
  PRIMARY_INSTRUCTION_FILE,
  COMPAT_INSTRUCTION_FILE,
] as const;
const CODEX_INSTRUCTION_FILE_NAMES = [
  COMPAT_INSTRUCTION_FILE,
  PRIMARY_INSTRUCTION_FILE,
] as const;

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

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * Check for _close sentinel.
 */
export function shouldClose(): boolean {
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

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
export function drainIpcInput(log: (message: string) => void): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
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

/**
 * Consume any IPC input that is already ready right now.
 * Returns:
 * - null when a close sentinel was consumed
 * - string when buffered messages were found
 * - undefined when nothing is ready yet
 */
export function takeReadyIpcInput(
  log: (message: string) => void,
): string | null | undefined {
  if (shouldClose()) {
    return null;
  }

  const messages = drainIpcInput(log);
  if (messages.length > 0) {
    return messages.join('\n');
  }

  return undefined;
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
export function waitForIpcMessage(
  log: (message: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      const nextInput = takeReadyIpcInput(log);
      if (nextInput === null) {
        resolve(null);
        return;
      }
      if (nextInput !== undefined) {
        resolve(nextInput);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
  log: (message: string) => void,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
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

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(
  log: (message: string) => void,
  assistantName?: string,
): HookCallback {
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

      const summary = getSessionSummary(sessionId, transcriptPath, log);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
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
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function readInstructionsFile(
  baseDir: string,
  orderedNames: readonly string[],
): string | undefined {
  for (const name of orderedNames) {
    const filePath = path.join(baseDir, name);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  }
  return undefined;
}

function getInstructionContext(
  containerInput: RuntimeContainerInput,
  orderedNames: readonly string[] = INSTRUCTION_FILE_NAMES,
): InstructionContext {
  const agentInstructions = readInstructionsFile(
    WORKSPACE_AGENT_DIR,
    orderedNames,
  );
  const globalInstructions = !containerInput.isMain
    ? readInstructionsFile(WORKSPACE_GLOBAL_DIR, orderedNames)
    : undefined;

  return {
    agentInstructions,
    globalInstructions,
    hasGlobalMemory:
      !containerInput.isMain &&
      INSTRUCTION_FILE_NAMES.some((name) =>
        fs.existsSync(path.join(WORKSPACE_GLOBAL_DIR, name)),
      ),
  };
}

export function discoverAdditionalDirectories(): string[] {
  const extraDirs: string[] = [];
  if (!fs.existsSync(WORKSPACE_EXTRA_DIR)) return extraDirs;

  for (const entry of fs.readdirSync(WORKSPACE_EXTRA_DIR)) {
    const fullPath = path.join(WORKSPACE_EXTRA_DIR, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      extraDirs.push(fullPath);
    }
  }
  return extraDirs;
}

export function buildClaudeSystemPrompt(
  containerInput: RuntimeContainerInput,
): string | undefined {
  const instructionContext = getInstructionContext(
    containerInput,
    INSTRUCTION_FILE_NAMES,
  );
  const systemPromptParts: string[] = [];
  if (instructionContext.agentInstructions) {
    systemPromptParts.push(
      `# Agent Instructions (immutable — takes precedence over group memory)\n\n${instructionContext.agentInstructions}`,
    );
  }

  if (instructionContext.globalInstructions) {
    systemPromptParts.push(instructionContext.globalInstructions);
  }

  return systemPromptParts.length > 0
    ? systemPromptParts.join('\n\n---\n\n')
    : undefined;
}

function buildCodexPrompt(
  prompt: string,
  containerInput: RuntimeContainerInput,
): string {
  const instructionContext = getInstructionContext(
    containerInput,
    CODEX_INSTRUCTION_FILE_NAMES,
  );
  const promptParts: string[] = [];
  if (instructionContext.agentInstructions) {
    promptParts.push(
      [
        'Operator instructions below are higher priority than repository guidance and conversation memory.',
        '',
        '<agent_instructions>',
        instructionContext.agentInstructions,
        '</agent_instructions>',
      ].join('\n'),
    );
  }

  if (instructionContext.globalInstructions) {
    promptParts.push(
      [
        'Shared read-only group memory:',
        '',
        '<global_memory>',
        instructionContext.globalInstructions,
        '</global_memory>',
      ].join('\n'),
    );
  }

  const memoryHints = [
    'Conversation memory lives in `/workspace/group/AGENTS.md` (symlinked to `CLAUDE.md` when present).',
  ];
  if (instructionContext.hasGlobalMemory) {
    memoryHints.push(
      'Shared read-only memory is also available at `/workspace/global/AGENTS.md`.',
    );
  }
  promptParts.push(memoryHints.join('\n'));
  promptParts.push(prompt);

  return promptParts.join('\n\n');
}

export function buildContainerMcpServers(
  mcpServerPath: string,
  containerInput: RuntimeContainerInput,
): Record<string, McpServerRuntimeConfig> {
  return {
    agentlite: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        AGENTLITE_CHAT_JID: containerInput.chatJid,
        AGENTLITE_GROUP_FOLDER: containerInput.groupFolder,
        AGENTLITE_IS_MAIN: containerInput.isMain ? '1' : '0',
        ...(containerInput.actionsAuth
          ? {
              AGENTLITE_ACTIONS_URL: containerInput.actionsAuth.url,
              AGENTLITE_ACTIONS_TOKEN: containerInput.actionsAuth.token,
            }
          : {}),
      },
    },
    ...(containerInput.mcpServers ?? {}),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}

function writeCodexConfig(
  mcpServerPath: string,
  containerInput: RuntimeContainerInput,
): void {
  fs.mkdirSync(CODEX_HOME_DIR, { recursive: true });

  const servers = buildContainerMcpServers(mcpServerPath, containerInput);

  const lines: string[] = [
    `[projects.${tomlKey(WORKSPACE_GROUP_DIR)}]`,
    'trust_level = "trusted"',
    '',
  ];

  for (const [name, server] of Object.entries(servers).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${tomlArray(server.args)}`);
    }
    lines.push('');

    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`[mcp_servers.${tomlKey(name)}.env]`);
      for (const [key, value] of Object.entries(server.env).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
      }
      lines.push('');
    }
  }

  fs.writeFileSync(path.join(CODEX_HOME_DIR, 'config.toml'), lines.join('\n'));
}

/**
 * Run Claude Code and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
class ClaudeCodeQueryRunner<
  TContainerInput extends RuntimeContainerInput,
> implements QueryRunner<TContainerInput> {
  constructor(
    private readonly deps: QueryRunnerDependencies<TContainerInput>,
  ) {}

  async run({
    prompt,
    sessionId,
    mcpServerPath,
    containerInput,
    sdkEnv,
    resumeAt,
  }: QueryRunnerInput<TContainerInput>): Promise<RuntimeQueryResult> {
    const stream = new MessageStream();
    stream.push(prompt);
    this.deps.writeOutput({
      type: 'state',
      state: 'active',
      newSessionId: sessionId,
      reason: 'query_started',
    });

    // Poll IPC for follow-up messages and _close sentinel during the query
    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        this.deps.log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput(this.deps.log);
      for (const text of messages) {
        this.deps.log(
          `Piping IPC message into active query (${text.length} chars)`,
        );
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
    };
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;
    let resultCount = 0;
    const appendedSystemPrompt = buildClaudeSystemPrompt(containerInput);
    const extraDirs = discoverAdditionalDirectories();
    if (extraDirs.length > 0) {
      this.deps.log(`Additional directories: ${extraDirs.join(', ')}`);
    }

    for await (const message of query({
      prompt: stream,
      options: {
        includePartialMessages: true,
        cwd: WORKSPACE_GROUP_DIR,
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: appendedSystemPrompt
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: appendedSystemPrompt,
            }
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
          'mcp__agentlite__*',
          // Allow tools from all custom MCP servers
          ...Object.keys(containerInput.mcpServers ?? {}).map(
            (name) => `mcp__${name}__*`,
          ),
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: buildContainerMcpServers(mcpServerPath, containerInput),
        hooks: {
          PreCompact: [
            {
              hooks: [
                createPreCompactHook(
                  this.deps.log,
                  containerInput.assistantName,
                ),
              ],
            },
          ],
        },
      },
    })) {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      this.deps.log(`[msg #${messageCount}] type=${msgType}`);

      // ── Internal bookkeeping (not forwarded) ────────────────────
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        this.deps.log(`Session initialized: ${newSessionId}`);
      }

      // ── Forward every SDK message raw ─────────────────────────
      const sdkSubtype =
        message.type === 'system'
          ? (message as { subtype?: string }).subtype
          : undefined;
      this.deps.writeOutput({
        type: 'sdk_message',
        sdkType: message.type,
        sdkSubtype,
        message,
      });

      // ── Backward-compat: emit result for host message delivery ─
      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        this.deps.log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        this.deps.writeOutput({
          type: 'result',
          result: textResult || null,
          newSessionId,
        });
      }
    }

    ipcPolling = false;
    this.deps.log(
      `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
    );
    return { newSessionId, lastAssistantUuid, closedDuringQuery };
  }
}

class CodexQueryRunner<
  TContainerInput extends RuntimeContainerInput,
> implements QueryRunner<TContainerInput> {
  constructor(
    private readonly deps: Pick<
      QueryRunnerDependencies<TContainerInput>,
      'log' | 'writeOutput'
    >,
  ) {}

  run({
    prompt,
    sessionId,
    mcpServerPath,
    containerInput,
    sdkEnv,
  }: QueryRunnerInput<TContainerInput>): Promise<RuntimeQueryResult> {
    this.deps.writeOutput({
      type: 'state',
      state: 'active',
      newSessionId: sessionId,
      reason: 'query_started',
    });

    writeCodexConfig(mcpServerPath, containerInput);

    const codexPrompt = buildCodexPrompt(prompt, containerInput);
    const args = sessionId
      ? [
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          sessionId,
          '-',
        ]
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '-',
        ];

    let newSessionId = sessionId;
    let messageCount = 0;
    let resultCount = 0;

    return new Promise<RuntimeQueryResult>((resolve, reject) => {
      const child = spawn('codex', args, {
        cwd: WORKSPACE_GROUP_DIR,
        env: {
          ...sdkEnv,
          HOME: '/home/node',
          CODEX_HOME: CODEX_HOME_DIR,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.end(codexPrompt);

      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });

      stdout.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let message: any;
        try {
          message = JSON.parse(trimmed);
        } catch (err) {
          this.deps.log(
            `Failed to parse Codex JSON line: ${err instanceof Error ? err.message : String(err)} (${trimmed.slice(0, 200)})`,
          );
          return;
        }

        messageCount++;
        if (
          message.type === 'thread.started' &&
          typeof message.thread_id === 'string'
        ) {
          newSessionId = message.thread_id;
        }

        this.deps.writeOutput({
          type: 'sdk_message',
          sdkType:
            typeof message.type === 'string' ? message.type : 'unknown_event',
          sdkSubtype:
            message.type === 'item.started' || message.type === 'item.completed'
              ? message.item?.type
              : undefined,
          message,
        });

        if (
          message.type === 'item.completed' &&
          message.item?.type === 'agent_message'
        ) {
          resultCount++;
          const text =
            typeof message.item.text === 'string' ? message.item.text : null;
          this.deps.writeOutput({
            type: 'result',
            result: text,
            newSessionId,
          });
        }
      });

      stderr.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this.deps.log(`[codex] ${trimmed}`);
      });

      child.once('error', (err) => {
        stdout.close();
        stderr.close();
        reject(err);
      });

      child.once('close', (code, signal) => {
        stdout.close();
        stderr.close();
        if (code !== 0) {
          reject(
            new Error(
              `Codex exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
            ),
          );
          return;
        }

        this.deps.log(
          `Codex query done. Messages: ${messageCount}, results: ${resultCount}`,
        );
        resolve({
          newSessionId,
          lastAssistantUuid: undefined,
          closedDuringQuery: false,
        });
      });
    });
  }
}

class DefaultAgentBackendRunnerFactory implements AgentBackendRunnerFactory {
  create<TContainerInput extends RuntimeContainerInput>(
    agentBackend: AgentBackendOptions,
    deps: QueryRunnerDependencies<TContainerInput>,
  ): QueryRunner<TContainerInput> {
    switch (agentBackend.type) {
      case 'codex':
        return new CodexQueryRunner(deps);
      case 'claudeCode':
        return new ClaudeCodeQueryRunner(deps);
      default: {
        const exhaustiveCheck: never = agentBackend;
        return exhaustiveCheck;
      }
    }
  }
}

export const agentBackendRunnerFactory: AgentBackendRunnerFactory =
  new DefaultAgentBackendRunnerFactory();

export function createQueryRunner<
  TContainerInput extends RuntimeContainerInput,
>(
  agentBackend: AgentBackendOptions,
  deps: QueryRunnerDependencies<TContainerInput>,
): QueryRunner<TContainerInput> {
  return agentBackendRunnerFactory.create(agentBackend, deps);
}
