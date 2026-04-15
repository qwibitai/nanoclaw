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
import { runVercelQuery } from './vercel-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Safe Gmail MCP tool suffixes — destructive tools (delete_email,
 * batch_delete_emails, delete_label, delete_filter) are intentionally
 * excluded so the agent cannot permanently destroy emails.
 */
const SAFE_GMAIL_TOOL_SUFFIXES = [
  'search_emails',
  'read_email',
  'draft_email',
  'send_email',
  'modify_email',
  'batch_modify_emails',
  'list_email_labels',
  'download_attachment',
  'create_label',
  'update_label',
  'create_filter',
  'create_filter_from_template',
  'get_filter',
  'get_or_create_label',
  'list_filters',
] as const;

const GMAIL_ACCOUNT_NAMES = [
  'gmail',
  'gmail-personal',
  'gmail-whoisxml',
  'gmail-attaxion',
  'gmail-dev',
] as const;

/** Expand safe Gmail tools for all accounts into allowedTools entries */
function safeGmailTools(): string[] {
  return GMAIL_ACCOUNT_NAMES.flatMap((acct) =>
    SAFE_GMAIL_TOOL_SUFFIXES.map((suffix) => `mcp__${acct}__${suffix}`),
  );
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  verbose?: boolean;
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq' | 'together';
  model?: string;
  providerBaseUrl?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Real API cost reported by the SDK's result message (USD). */
  totalCostUsd?: number;
  /** Token usage reported by the SDK's result message. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Number of turns in this SDK query (for diagnostics). */
  numTurns?: number;
  /**
   * Short human-readable label for in-flight work (e.g. "Reading Gmail
   * thread", "Searching knowledge base"). Emitted when the agent starts
   * a tool call. Host uses this to update the in-place "⏳ working" message.
   * Never carries a final result — always paired with result=null.
   */
  progressLabel?: string;
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
const IPC_POLL_MS = 500;

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

/**
 * Human-friendly one-liner for a tool name, used in live progress updates.
 * Avoids leaking raw SDK names like `mcp__superpilot__get_triaged_emails`.
 *
 * When `toolInput` is provided, tool-specific details are extracted:
 * - Bash: uses the `description` field (e.g. "Running tests")
 * - MCP tools: prefixes with the server name for context
 */
function formatToolLabel(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  // Bash: prefer the description field authored by the agent
  if (toolName === 'Bash' && toolInput?.description) {
    return String(toolInput.description);
  }

  // MCP tools: extract server name for context (mcp__gmail-personal__search_emails)
  const mcpMatch = toolName.match(/^mcp__([^_]+(?:-[^_]+)*)__(.+)$/);
  if (mcpMatch) {
    const server = mcpMatch[1];
    const tool = mcpMatch[2];
    const toolWords = tool
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const prettyTool = toolWords
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    // Use the heuristic map for known MCP tool names
    const mcpMap: Record<string, string> = {
      'Search Emails': 'Searching emails',
      'Read Email': 'Reading email',
      'Send Email': 'Drafting email',
      'Get Triaged Emails': 'Fetching triaged emails',
      'Get Thread Summary': 'Summarizing thread',
      'Generate Reply': 'Generating reply',
      'Search Kb': 'Searching KB',
      'Upload To Kb': 'Saving to KB',
      'Get Awaiting Reply': 'Fetching awaiting replies',
      'Send Message': 'Sending message',
    };
    const action = mcpMap[prettyTool] || prettyTool;
    return `${action} (${server})`;
  }

  // Built-in tools: snake_case/camelCase → Title Case
  const words = toolName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const pretty = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  const map: Record<string, string> = {
    Read: 'Reading file',
    Write: 'Writing file',
    Edit: 'Editing file',
    Bash: 'Running command',
    Glob: 'Searching files',
    Grep: 'Searching code',
    'Task Create': 'Creating task',
    'Task List': 'Listing tasks',
  };
  return map[pretty] || pretty;
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
function drainIpcInput(): string[] {
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
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Append model escalation instructions to the system prompt
  const escalationInstruction = `\n\n## Model Escalation
You run as Sonnet for speed. For complex tasks, delegate to the \`deep-work\` agent (Opus) using the Agent tool.

**Escalate to deep-work when:**
- Multi-file code changes, refactors, or new features touching 2+ files
- Debugging that requires hypothesis testing across multiple files
- PR creation or code review
- Security analysis
- Architecture or design decisions

**Handle directly (do NOT escalate):**
- Simple Q&A, status checks, greetings
- Single-file edits that are straightforward
- Scheduling, reminders, routine tool use
- Email triage and simple replies
- Reading files, searching code, running commands

**When escalating:**
1. Send a brief acknowledgment to the user via \`send_message\` — always include "⚡ Opus" so the user knows the model switched. Example: "⚡ Opus — investigating the auth middleware..."
2. Dispatch to the \`deep-work\` agent with a clear, complete prompt describing the task
3. Relay the agent's result to the user

**When handling directly (no escalation):**
- Just respond normally. No model label needed — the user knows Sonnet is the default.

**Progress reporting for multi-step work:**
- For tasks with multiple independent subtasks (e.g. fixing 5 repos), send incremental progress via \`send_message\` as each subtask completes. Don't wait for all to finish.
- Format: "✅ 1/5 — fixed auth bug in repo-x (PR #123)" as each one lands.
- If a subtask fails, report immediately: "❌ Failed: repo-y — GitHub auth error (details...)"
- When all done, send a summary.`;
  globalClaudeMd = globalClaudeMd
    ? globalClaudeMd + escalationInstruction
    : escalationInstruction;

  // Append fact-classification discipline for self-check verification
  const factClassification = `\n\n## Fact Classification

Before stating any fact in a response, classify it internally:
- KNOWN: directly observed in this session (tool result, file content, message text)
- REMEMBERED: from memory files or prior conversation
- INFERRED: reasoned from other facts, not directly confirmed

In your final response, prefix claims with a confidence marker:
- ✓ Verified: [claim] (source: [where you saw it])
- ~ Unverified: [claim] (source: memory)
- ? Unknown: [claim] (not confirmed)

Only use ✓ for KNOWN facts with a named source. Use ~ for REMEMBERED claims. Use ? when you cannot confirm. Omit markers entirely for routine, conversational phrases that carry no factual claim.`;
  globalClaudeMd += factClassification;

  // When verbose mode is on, append thinking instruction to the system prompt
  if (containerInput.verbose) {
    const thinkingInstruction = `\n\n## Verbose Mode (Active)\nBefore each response, include a brief 1-2 sentence summary of your reasoning approach as a blockquote. Format:\n> Considering X, checking Y...\n\nKeep the thinking summary concise — one or two lines max. Then continue with your normal response. Do NOT use this for trivial responses (greetings, confirmations). Only include it when there is genuine reasoning or decision-making to surface.`;
    globalClaudeMd += thinkingInstruction;
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
      maxThinkingTokens: 16384,
      systemPrompt: globalClaudeMd
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: globalClaudeMd,
          }
        : undefined,
      allowedTools: [
        'Agent',
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
        'mcp__notion__*',
        'mcp__superpilot__*',
        ...safeGmailTools(),
      ],
      agents: {
        'deep-work': {
          description:
            'Use for complex tasks requiring deep reasoning: multi-file code changes, debugging, PR creation/review, security analysis, architecture decisions. Do NOT use for simple Q&A, scheduling, single-file edits, or routine tool use.',
          model: 'opus' as const,
          tools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'WebSearch',
            'WebFetch',
            'TodoWrite',
            'mcp__nanoclaw__*',
            'mcp__notion__*',
            'mcp__superpilot__*',
            ...safeGmailTools(),
          ],
          prompt:
            'You are a deep reasoning agent handling complex development and analysis tasks. Think through problems carefully — check cross-file impacts, consider edge cases, verify assumptions. Your output will be relayed to the user. Write your response as if speaking directly to them.',
        },
      },
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: (() => {
        const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
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

        // Register a Gmail MCP server per account that has credentials mounted.
        // Each gets its own server name so the agent can distinguish accounts.
        const gmailAccounts = [
          { name: 'gmail-personal', dir: '.gmail-mcp' },
          { name: 'gmail-whoisxml', dir: '.gmail-mcp-jonathan' },
          { name: 'gmail-attaxion', dir: '.gmail-mcp-attaxion' },
          { name: 'gmail-dev', dir: '.gmail-mcp-dev' },
        ];
        for (const acct of gmailAccounts) {
          const credsPath = `/home/node/${acct.dir}/credentials.json`;
          const oauthPath = `/home/node/${acct.dir}/gcp-oauth.keys.json`;
          if (fs.existsSync(credsPath)) {
            servers[acct.name] = {
              command: 'npx',
              args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
              env: {
                GMAIL_OAUTH_PATH: oauthPath,
                GMAIL_CREDENTIALS_PATH: credsPath,
              },
            };
            log(`Gmail account ${acct.name} registered (${acct.dir})`);
          }
        }
        // Backwards compat: also register as plain "gmail" pointing to personal
        if (servers['gmail-personal']) {
          servers['gmail'] = servers['gmail-personal'];
        }

        // Notion MCP server — requires NOTION_TOKEN env var (integration token)
        const notionToken = process.env.NOTION_TOKEN || process.env.NOTION_API_KEY;
        if (notionToken) {
          servers['notion'] = {
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
            env: {
              OPENAPI_MCP_HEADERS: JSON.stringify({
                Authorization: `Bearer ${notionToken}`,
                'Notion-Version': '2022-06-28',
              }),
            },
          };
          log('Notion MCP server registered');
        }

        // SuperPilot MCP — local stdio server that proxies to production API
        const superpilotApiUrl = process.env.SUPERPILOT_API_URL;
        const serviceToken = process.env.NANOCLAW_SERVICE_TOKEN;
        if (superpilotApiUrl && serviceToken) {
          const superpilotMcpPath = path.join(__dirname, 'superpilot-mcp.js');
          if (fs.existsSync(superpilotMcpPath)) {
            servers['superpilot'] = {
              command: 'node',
              args: [superpilotMcpPath],
              env: {
                SUPERPILOT_API_URL: superpilotApiUrl,
                NANOCLAW_SERVICE_TOKEN: serviceToken,
              },
            };
            log('SuperPilot MCP server registered');
          }
        }

        return servers;
      })(),
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

      // Extract any tool_use blocks from this assistant message and emit
      // a short progress label so the host can update its in-place status
      // line. Tool calls are where latency lives — surfacing the current
      // tool makes the spinner feel alive instead of stalled.
      try {
        const asstMsg = message as {
          message?: {
            content?: Array<{
              type?: string;
              name?: string;
              input?: Record<string, unknown>;
            }>;
          };
        };
        const blocks = asstMsg.message?.content || [];
        const toolBlocks = blocks.filter(
          (b) => b?.type === 'tool_use' && typeof b.name === 'string',
        );
        if (toolBlocks.length > 0) {
          const label = toolBlocks
            .map((b) => formatToolLabel(b.name as string, b.input))
            .join(' · ');
          writeOutput({
            status: 'success',
            result: null,
            newSessionId,
            progressLabel: label,
          });
        }
      } catch (err) {
        log(
          `Failed to extract tool_use for progress: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Extract progress info from subagent task_progress messages
    // to keep the live status line updated during parallel agent work.
    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_progress'
    ) {
      try {
        const tp = message as {
          tool_name?: string;
          task_id?: string;
        };
        if (tp.tool_name) {
          const label = formatToolLabel(tp.tool_name);
          writeOutput({
            status: 'success',
            result: null,
            newSessionId,
            progressLabel: `⚡ ${label}`,
          });
        }
      } catch {
        /* best-effort */
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

      // Forward subagent failures to the user immediately via IPC
      if (tn.status === 'failed' && tn.summary) {
        const truncatedSummary =
          tn.summary.length > 200
            ? tn.summary.slice(0, 200) + '...'
            : tn.summary;
        const errorIpc = {
          type: 'message',
          chatJid: containerInput.chatJid,
          text: `❌ Subagent failed: ${truncatedSummary}`,
          groupFolder: containerInput.groupFolder,
          timestamp: new Date().toISOString(),
        };
        const ipcDir = '/workspace/ipc/messages';
        try {
          fs.mkdirSync(ipcDir, { recursive: true });
          const filename = `${Date.now()}-err-${Math.random().toString(36).slice(2, 6)}.json`;
          const tmpPath = path.join(ipcDir, `${filename}.tmp`);
          fs.writeFileSync(tmpPath, JSON.stringify(errorIpc));
          fs.renameSync(tmpPath, path.join(ipcDir, filename));
        } catch (err) {
          log(
            `Failed to write error IPC: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      const resultMsg = message as {
        total_cost_usd?: number;
        usage?: ContainerOutput['usage'];
        num_turns?: number;
      };
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''} cost=${resultMsg.total_cost_usd ?? 'n/a'} turns=${resultMsg.num_turns ?? 'n/a'}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        totalCostUsd: resultMsg.total_cost_usd,
        usage: resultMsg.usage,
        numTurns: resultMsg.num_turns,
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
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
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
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

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

  const provider = containerInput.provider ?? 'anthropic';

  if (provider !== 'anthropic') {
    log(`Using Vercel AI SDK (provider: ${provider}, model: ${containerInput.model ?? 'default'})`);
    const result = await runVercelQuery(prompt, containerInput);
    writeOutput(result);
    process.exit(0);
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
