/**
 * NanoClaw Agent Runner
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
import { execFile } from 'child_process';
import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  workspacePaths: {
    group: string;
    project?: string;
    global?: string;
    ipc: string;
    extra?: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** progress 消息的子类型 */
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  /** 可折叠面板的展开内容（markdown 格式） */
  detail?: string;
  /** token 用量（仅 result 消息） */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    /** 各模型的实际 context window 大小（tokens），key 为模型名 */
    modelContextWindows?: Record<string, number>;
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

const IPC_POLL_MS = 500;

// 工作目录路径 — 在 stdin 解析后初始化
let PATHS: {
  group: string;
  project?: string;
  global?: string;
  ipc: string;
  extra?: string;
  ipcInput: string;
  ipcClose: string;
  conversations: string;
  globalClaudeMd?: string;
};

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

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

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

      const conversationsDir = PATHS.conversations;
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

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(PATHS.ipcClose)) {
    try {
      fs.unlinkSync(PATHS.ipcClose);
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
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(PATHS.ipcInput, { recursive: true });
    const files = fs
      .readdirSync(PATHS.ipcInput)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(PATHS.ipcInput, file);
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
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

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

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = PATHS.globalClaudeMd;
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && globalClaudeMdPath && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories at extra workspace path
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = PATHS.extra;
  if (extraBase && fs.existsSync(extraBase)) {
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
      cwd: PATHS.group,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
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
            NANOCLAW_IPC_DIR: PATHS.ipc,
          },
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    // 工具调用进度输出 — 让宿主机能显示进度卡片
    if (message.type === 'assistant') {
      const msg = message as Record<string, unknown>;
      const innerMsg = msg.message as Record<string, unknown> | undefined;
      const innerContent = innerMsg?.content as Array<{ type: string; name?: string; input?: unknown; text?: string }> | undefined;
      const outerContent = msg.content as Array<{ type: string; name?: string; input?: unknown; text?: string }> | undefined;
      const content = innerContent || outerContent;
      log(`[assistant] innerKeys=${innerMsg ? Object.keys(innerMsg).join(',') : 'N/A'}, contentTypes=${Array.isArray(content) ? content.map(b => b.type).join(',') : 'none'}`);
      if (Array.isArray(content)) {
        for (const block of content) {
          // 工具调用 — 提取工具名、输入摘要、详情
          if (block.type === 'tool_use' && block.name) {
            const input = block.input as Record<string, unknown> | null;
            const emoji = block.name === 'Bash' ? '🔧' :
                          block.name === 'Read' ? '📖' :
                          block.name === 'Write' || block.name === 'Edit' ? '✏️' :
                          block.name === 'Grep' ? '🔍' :
                          block.name === 'Glob' ? '📋' :
                          block.name === 'WebSearch' ? '🌐' :
                          block.name === 'WebFetch' ? '🌐' :
                          block.name === 'ListDir' ? '📋' : '⚙️';
            const inputStr = input
              ? (input.command as string || input.file_path as string || input.query as string || input.pattern as string || block.name)
              : block.name;
            const shortInput = typeof inputStr === 'string' ? inputStr.slice(0, 60) : block.name;

            let detail: string | undefined;
            if (input) {
              if (block.name === 'Edit' && input.old_string && input.new_string) {
                const file = (input.file_path as string || '').split('/').pop() || 'file';
                const oldLines = (input.old_string as string).slice(0, 300).split('\n').map((l: string) => `- ${l}`).join('\n');
                const newLines = (input.new_string as string).slice(0, 300).split('\n').map((l: string) => `+ ${l}`).join('\n');
                detail = `**${file}**\n${oldLines}\n${newLines}`;
              } else if (block.name === 'Bash' && input.command) {
                detail = `\`\`\`bash\n${(input.command as string).slice(0, 500)}\n\`\`\``;
              } else if (block.name === 'Write' && input.file_path) {
                const c = (input.content as string || '').slice(0, 300);
                detail = `**${input.file_path}**\n\`\`\`\n${c}${c.length >= 300 ? '\n...' : ''}\n\`\`\``;
              }
            }

            writeOutput({
              status: 'progress',
              result: `${emoji} ${block.name}: ${shortInput}`,
              progressType: 'tool_use',
              detail,
              newSessionId: undefined,
            });
          }

          // 推理文本
          if (block.type === 'text' && block.text) {
            const trimmed = block.text.trim();
            if (trimmed.length > 5) {
              const short = trimmed.slice(0, 80) + (trimmed.length > 80 ? '...' : '');
              writeOutput({
                status: 'progress',
                result: `💭 ${short}`,
                progressType: 'thinking',
                detail: trimmed.length > 80 ? trimmed : undefined,
                newSessionId: undefined,
              });
            }
          }
        }
      }
    }

    // 工具执行结果 — 从 user 消息的 content 中提取 tool_result
    if (message.type === 'user') {
      const userMsg = message as { message?: { content?: unknown[] } };
      const content = userMsg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type?: string; content?: unknown };
          if (b.type === 'tool_result' && b.content) {
            let resultText = '';
            if (typeof b.content === 'string') {
              resultText = b.content;
            } else if (Array.isArray(b.content)) {
              resultText = (b.content as Array<{ type?: string; text?: string }>)
                .filter(c => c.type === 'text' && c.text)
                .map(c => c.text!)
                .join('\n');
            }
            if (resultText && resultText.trim().length > 0) {
              const short = resultText.trim().slice(0, 60) + (resultText.trim().length > 60 ? '...' : '');
              writeOutput({
                status: 'progress',
                result: `✅ 结果: ${short}`,
                progressType: 'tool_result',
                detail: resultText.trim().length > 60 ? resultText.trim().slice(0, 1000) : undefined,
                newSessionId: undefined,
              });
            }
          }
        }
      }
    }

    // 工具调用摘要
    if (message.type === 'tool_use_summary') {
      const summary = (message as { summary?: string }).summary;
      if (summary) {
        writeOutput({
          status: 'progress',
          result: `📊 ${summary.slice(0, 80)}`,
          progressType: 'tool_result',
          detail: summary.length > 80 ? summary : undefined,
          newSessionId: undefined,
        });
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const tn = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;

      // 提取 token 用量
      const msg = message as Record<string, unknown>;
      const rawUsage = msg.usage as Record<string, number> | undefined;
      // 提取各模型的 contextWindow（SDK 返回 modelUsage: Record<string, ModelUsage>）
      const rawModelUsage = msg.modelUsage as
        | Record<string, { contextWindow?: number }>
        | undefined;
      const modelContextWindows = rawModelUsage
        ? Object.fromEntries(
            Object.entries(rawModelUsage)
              .filter(([, v]) => v.contextWindow != null)
              .map(([k, v]) => [k, v.contextWindow as number]),
          )
        : undefined;
      const usage = rawUsage
        ? {
            inputTokens: rawUsage.input_tokens ?? 0,
            outputTokens: rawUsage.output_tokens ?? 0,
            cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
            numTurns: (msg.num_turns as number) ?? 0,
            durationMs: (msg.duration_ms as number) ?? 0,
            totalCostUsd: (msg.total_cost_usd as number) ?? 0,
            modelContextWindows,
          }
        : undefined;

      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        usage,
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);

    // 初始化工作目录路径
    const wp = containerInput.workspacePaths;
    PATHS = {
      group: wp.group,
      project: wp.project,
      global: wp.global,
      ipc: wp.ipc,
      extra: wp.extra,
      ipcInput: path.join(wp.ipc, 'input'),
      ipcClose: path.join(wp.ipc, 'input', '_close'),
      conversations: path.join(wp.group, 'conversations'),
      globalClaudeMd: wp.global ? path.join(wp.global, 'CLAUDE.md') : undefined,
    };

    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(PATHS.ipcInput, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(PATHS.ipcClose);
  } catch {
    /* ignore */
  }

  // LLM 请求日志：flag 文件由编排层管理（/llmlog on/off 或 /clear），这里不重置
  const llmlogFlagFile = path.join(PATHS.group, '.llmlog_enabled');
  const llmlogDir = path.join(PATHS.group, 'llmlogs');

  // 拦截全局 fetch，当 .llmlog_enabled 存在时记录 Anthropic API 请求和响应
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function llmlogFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const isAnthropicApi = url.includes('anthropic.com') || url.includes('/v1/messages');

    // 检查是否启用了日志（每次请求都检查，支持动态开关）
    let loggingEnabled = false;
    if (isAnthropicApi) {
      try {
        fs.accessSync(llmlogFlagFile);
        loggingEnabled = true;
      } catch {
        /* 标志文件不存在，日志关闭 */
      }
    }

    if (!loggingEnabled) {
      return originalFetch(input, init);
    }

    // 读取请求体
    let requestBody: unknown = undefined;
    if (init?.body) {
      try {
        requestBody = JSON.parse(init.body as string);
      } catch {
        requestBody = String(init.body);
      }
    }

    const requestTime = new Date().toISOString();
    const logId = requestTime.replace(/[:.]/g, '-');

    // 执行原始请求
    const response = await originalFetch(input, init);

    // 克隆响应以读取内容（原始 response 继续返回给调用方）
    const cloned = response.clone();
    const contentType = cloned.headers.get('content-type') || '';

    let responseBody: unknown;
    if (contentType.includes('text/event-stream')) {
      // 流式响应：收集所有 SSE 事件
      const chunks: string[] = [];
      try {
        const text = await cloned.text();
        chunks.push(text);
      } catch {
        chunks.push('<stream read error>');
      }
      responseBody = chunks.join('');
    } else {
      try {
        responseBody = await cloned.json();
      } catch {
        try {
          responseBody = await cloned.text();
        } catch {
          responseBody = '<read error>';
        }
      }
    }

    // 保存日志
    try {
      fs.mkdirSync(llmlogDir, { recursive: true });
      const logEntry = {
        time: requestTime,
        url,
        method: init?.method || 'POST',
        requestHeaders: Object.fromEntries(
          Object.entries((init?.headers as Record<string, string>) || {}).map(
            ([k, v]) => [k, k.toLowerCase() === 'x-api-key' || k.toLowerCase() === 'authorization' ? '[REDACTED]' : v],
          ),
        ),
        request: requestBody,
        responseStatus: response.status,
        response: responseBody,
      };
      const logFile = path.join(llmlogDir, `${logId}.json`);
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2), 'utf-8');
      log(`[llmlog] Saved: ${logFile}`);
    } catch (err) {
      log(`[llmlog] Failed to save log: ${err}`);
    }

    return response;
  };

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

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult
        ? 'wakeAgent=false'
        : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
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
