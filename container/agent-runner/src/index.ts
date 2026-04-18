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
  isTrusted?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  replyToMessageId?: string;
  /**
   * Which per-group session this container run belongs to. Mirrors the
   * orchestrator-side `ContainerInput.sessionName` in `src/container-runner.ts`.
   *
   * Consumed here to set the `NANOCLAW_SESSION_NAME` env var on the MCP
   * stdio server (see the `mcpServersConfig.nanoclaw.env` block below),
   * which stamps `sessionName` onto every TASKS_DIR IPC request so the
   * host responder routes `_script_result_*` replies back to THIS
   * session's `input-<session>/` dir. Mount-based session isolation
   * (`groupSessionsDir`, `input/` overlay) is set up by the orchestrator
   * before spawn; this value flows through to the MCP env at runtime.
   */
  sessionName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamText?: string;
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
 * Effort levels the SDK's `query()` accepts (as of
 * `@anthropic-ai/claude-agent-sdk` 0.2.112). Kept here as a runtime
 * whitelist so a typo in `AGENT_EFFORT` doesn't propagate to the API
 * as a 400 — we fall back to the default and log.
 */
const VALID_AGENT_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
type AgentEffort = (typeof VALID_AGENT_EFFORTS)[number];
const DEFAULT_AGENT_EFFORT: AgentEffort = 'xhigh';

function resolveAgentEffort(raw: string | undefined): AgentEffort {
  if (!raw) return DEFAULT_AGENT_EFFORT;
  if ((VALID_AGENT_EFFORTS as readonly string[]).includes(raw)) {
    return raw as AgentEffort;
  }
  console.error(
    `[agent-runner] Invalid AGENT_EFFORT="${raw}" — falling back to ` +
      `"${DEFAULT_AGENT_EFFORT}". Valid values: ${VALID_AGENT_EFFORTS.join(', ')}.`,
  );
  return DEFAULT_AGENT_EFFORT;
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
 * Tracks consumed files in memory so read-only mounts don't cause infinite loops.
 */
const REPLY_TO_FILE = path.join(IPC_INPUT_DIR, '_reply_to');
const consumedInputFiles = new Set<string>();

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_script_result_') && !consumedInputFiles.has(f))
      .sort();

    const messages: string[] = [];
    let latestReplyTo: string | undefined;
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        consumedInputFiles.add(file);
        try { fs.unlinkSync(filePath); } catch (e: any) {
          if (e.code !== 'EROFS' && e.code !== 'EACCES') throw e;
        }
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
          if (data.replyToMessageId) {
            latestReplyTo = data.replyToMessageId;
          }
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        consumedInputFiles.add(file);
        try { fs.unlinkSync(filePath); } catch (e: any) {
          if (e.code !== 'EROFS' && e.code !== 'EACCES' && e.code !== 'ENOENT') throw e;
        }
      }
    }
    // Write the latest replyToMessageId so the MCP server can pick it up
    if (latestReplyTo) {
      try { fs.writeFileSync(REPLY_TO_FILE, latestReplyTo); } catch { /* ignore */ }
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

  // Streaming preview: accumulate assistant text and emit throttled
  let streamingTextAccum = '';
  let lastStreamEmit = 0;
  const STREAM_THROTTLE_MS = 300;

  // Load SOUL.md and global CLAUDE.md into systemPrompt.append so they survive
  // compaction. The SDK re-injects system prompt content every turn — behavioral
  // instructions placed here won't drift after long conversations or compaction.
  // NOTE: /workspace/global/SOUL.md resolves to the correct file per trust tier —
  // trusted containers mount the full SOUL.md, untrusted mount SOUL-untrusted.md
  // at the same path. No trust check needed here; the mount layer handles it.
  const soulMdPath = '/workspace/global/SOUL.md';
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  const appendParts: string[] = [];
  if (fs.existsSync(soulMdPath)) {
    appendParts.push(fs.readFileSync(soulMdPath, 'utf-8'));
  }
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    appendParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
  }
  const systemPromptAppend =
    appendParts.length > 0 ? appendParts.join('\n\n---\n\n') : undefined;

  // Rules are loaded by the SDK via the tessl chain: CLAUDE.md → AGENTS.md → .tessl/RULES.md
  // For untrusted groups, the orchestrator copies .tessl from a main group's session.

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

  // Discover installed skill names for subagent definitions.
  // Subagents spawned via TeamCreate don't inherit the parent's skills
  // or settingSources — they only get what's explicitly defined here.
  const skillsDir = '/home/node/.claude/skills';
  const installedSkills: string[] = [];
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      if (fs.statSync(path.join(skillsDir, entry)).isDirectory()) {
        installedSkills.push(entry);
      }
    }
  }
  if (installedSkills.length > 0) {
    log(`Discovered ${installedSkills.length} skills for subagent definitions`);
  }

  // MCP servers config — shared between main agent and subagents
  const mcpServersConfig = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        // Session identity. The MCP stdio server stamps this onto every
        // IPC request so the host responder knows which session's
        // `input-<session>/` dir should receive the `_script_result_*`
        // reply. Without it, responses to a maintenance container's
        // requests would land in `input-default/` and never be seen.
        NANOCLAW_SESSION_NAME: containerInput.sessionName || 'default',
        ...(containerInput.replyToMessageId
          ? { NANOCLAW_REPLY_TO_MESSAGE_ID: containerInput.replyToMessageId }
          : {}),
      },
    },
    ...(process.env.COMPOSIO_API_KEY
      ? {
          composio: {
            type: 'http' as const,
            url: 'https://connect.composio.dev/mcp',
            headers: {
              'x-consumer-api-key': process.env.COMPOSIO_API_KEY,
            },
          },
        }
      : {}),
    ...(fs.existsSync('/home/node/.tessl/api-credentials.json')
      ? {
          tessl: {
            command: 'tessl',
            args: ['mcp', 'start'],
          },
        }
      : {}),
  };

  // Subagent tools — same as parent minus TeamCreate/TeamDelete (no nesting)
  const subagentTools = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch',
    'Skill', 'NotebookEdit', 'mcp__nanoclaw__*',
  ];

  // Define a general-purpose subagent that inherits all skills and MCP
  // servers. When the main agent uses TeamCreate, it can reference this
  // agent type and the subagent will have full access to skills/rules.
  // Build subagent prompt with all rules and behavioral instructions.
  // Subagents don't inherit settingSources, CLAUDE.md, or .tessl/RULES.md
  // from the parent — they only get what's in their prompt + skills array.
  // Read all rule/context files and inject them into the subagent prompt.
  const subagentPromptParts: string[] = [
    'You are a background agent with the same capabilities as the main agent.',
    'Follow ALL rules below. Use skills via the Skill tool.',
    'Report results via mcp__nanoclaw__send_message.',
  ];

  // Load rules chain: CLAUDE.md → AGENTS.md → .tessl/RULES.md
  const ruleFiles = [
    '/workspace/group/CLAUDE.md',
    '/workspace/group/.tessl/RULES.md',
    soulMdPath,
    globalClaudeMdPath,
  ];
  for (const rulePath of ruleFiles) {
    if (fs.existsSync(rulePath)) {
      const content = fs.readFileSync(rulePath, 'utf-8').trim();
      if (content) {
        subagentPromptParts.push(`\n---\n# ${path.basename(rulePath)}\n${content}`);
      }
    }
  }

  // Also load individual rule files referenced in RULES.md
  const tesslTilesDir = '/home/node/.claude/.tessl/tiles';
  if (fs.existsSync(tesslTilesDir)) {
    const walkRules = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walkRules(fullPath);
        } else if (entry.endsWith('.md') && fullPath.includes('/rules/')) {
          const content = fs.readFileSync(fullPath, 'utf-8').trim();
          if (content) {
            subagentPromptParts.push(`\n---\n# Rule: ${entry}\n${content}`);
          }
        }
      }
    };
    walkRules(tesslTilesDir);
  }

  const subagentPrompt = subagentPromptParts.join('\n');
  log(`Subagent prompt built: ${subagentPrompt.length} chars, ${installedSkills.length} skills`);

  const agentDefinitions = {
    'general-purpose': {
      description:
        'General-purpose agent with full access to all skills, MCP tools, ' +
        'and rules. Use for any background task that needs the same ' +
        'capabilities as the main agent (heartbeat, research, analysis, etc.).',
      prompt: subagentPrompt,
      tools: subagentTools,
      skills: installedSkills,
      mcpServers: Object.keys(mcpServersConfig),
    },
  };

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: systemPromptAppend
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: systemPromptAppend,
          }
        : undefined,
      // AGENT_MODEL is set by the orchestrator (`src/container-runner.ts`)
      // so the model can be bumped without rebuilding the agent-runner image.
      // Fallback matches the historical hardcoded value.
      model: process.env.AGENT_MODEL || 'opus[1m]',
      // Opus 4.7 rejects the old `thinking.type=enabled` shape entirely
      // and runs with thinking OFF unless adaptive is explicitly requested.
      // Adaptive also auto-enables interleaved thinking, which matters for
      // our multi-tool-call agentic workflow. Safe on 4.6/Sonnet 4.6 (both
      // support adaptive and will use it over the deprecated manual mode).
      // See https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
      thinking: { type: 'adaptive' as const },
      // AGENT_EFFORT is set by the orchestrator alongside AGENT_MODEL so
      // cost/latency can be tuned per deploy without rebuilding this image.
      // xhigh is Opus 4.7's recommended default for coding/agentic work
      // (Anthropic docs: "recommended starting point for coding and agentic
      // work"). On 4.6 and Sonnet 4.6 the SDK silently falls back to `high`.
      // Dropped from `max` — Anthropic recommends against max on 4.7 unless
      // evals show measurable headroom; xhigh is the sweet spot.
      //
      // NOTE: `thinking` is deliberately NOT env-configurable — its valid
      // shape is coupled to the model family (4.7 rejects `type: 'enabled'`,
      // older models require it), so independent config would let the two
      // drift and silently reproduce the 400-error outage. Model-family
      // changes are a code review, not a redeploy knob.
      effort: resolveAgentEffort(process.env.AGENT_EFFORT),
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
      agents: agentDefinitions,
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: mcpServersConfig,
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
      // Extract text content for streaming preview
      const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
      if (content) {
        const text = content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('');
        if (text) {
          streamingTextAccum = text;
          const now = Date.now();
          if (now - lastStreamEmit >= STREAM_THROTTLE_MS) {
            writeOutput({ status: 'success', result: null, streamText: streamingTextAccum, newSessionId });
            lastStreamEmit = now;
          }
        }
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
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
      // Break out of the for-await loop after receiving the result.
      // Without this, the iterator hangs waiting for more SDK messages
      // that will never come, and follow-up IPC messages are lost.
      // The outer while(true) loop handles follow-ups via waitForIpcMessage().
      // See: https://github.com/qwibitai/nanoclaw/issues/233
      break;
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
  const sdkEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = prompt.trim();
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(trimmedPrompt);

  if (isSessionSlashCommand) {
    log(`Handling session command: ${trimmedPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: trimmedPrompt,
        options: {
          cwd: '/workspace/group',
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          env: sdkEnv,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType = message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === 'system' && message.subtype === 'init') {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          compactBoundarySeen = true;
          log('Compact boundary observed — compaction completed');
        }

        if (message.type === 'result') {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith('error')) {
            hadError = true;
            writeOutput({
              status: 'error',
              result: null,
              error: textResult || 'Session command failed.',
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: 'success',
              result: textResult || 'Conversation compacted.',
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: 'error', result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log('WARNING: compact_boundary was not observed. Compaction may not have completed.');
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: 'success',
        result: compactBoundarySeen
          ? 'Conversation compacted.'
          : 'Compaction requested but compact_boundary was not observed.',
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: 'success', result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

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

  // Tag untrusted group prompts with origin markers so the model (and compaction)
  // can distinguish user instructions from untrusted input. Trusted and main group
  // prompts are left untagged — they carry the same authority as system instructions.
  if (!containerInput.isMain && !containerInput.isTrusted) {
    prompt = `<untrusted-input source="${containerInput.groupFolder}">\n${prompt}\n</untrusted-input>`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      let queryResult;
      try {
        queryResult = await runQuery(
          prompt,
          sessionId,
          mcpServerPath,
          containerInput,
          sdkEnv,
          resumeAt,
        );
      } catch (resumeErr) {
        const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        if (sessionId && /session|conversation not found|resume/i.test(msg)) {
          log(`Session resume failed (${msg}), retrying with fresh session`);
          sessionId = undefined;
          resumeAt = undefined;
          queryResult = await runQuery(prompt, undefined, mcpServerPath, containerInput, sdkEnv, undefined);
        } else {
          throw resumeErr;
        }
      }
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

main().then(() => process.exit(0));
