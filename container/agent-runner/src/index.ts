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
import { query, Query, HookCallback, PreCompactHookInput, PreToolUseHookInput, EffortLevel, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerAttachment {
  filename: string;
  mimeType: string;
  containerPath: string;
  messageId: string;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  threadId?: string;
  assistantName?: string;
  model?: string;
  effort?: string;
  tone?: string;
  secrets?: Record<string, string>;
  tools?: string[];
  attachments?: ContainerAttachment[];
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorType?: 'prompt_too_long' | 'general';
  idle?: boolean;
  /**
   * Models that produced output during the turn this result represents.
   * Computed from the SDK's cumulative `modelUsage` field by diffing against
   * the previously observed totals — only models whose outputTokens grew
   * since the last result are included. The host uses this to verify that
   * a `-m`/`-m1` model switch actually took effect before sending the
   * "✅ Switched to ..." confirmation message to the user.
   */
  modelsUsedThisTurn?: string[];
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

// Supported image MIME types (used to identify image attachments)
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

const IPC_INPUT_SUBDIR = process.env.IPC_INPUT_SUBDIR;
if (!IPC_INPUT_SUBDIR) {
  console.error('[agent-runner] FATAL: IPC_INPUT_SUBDIR env var is required');
  process.exit(1);
}
const IPC_INPUT_DIR = `/workspace/ipc/input/${IPC_INPUT_SUBDIR}`;
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// Module-level reference to sdkEnv so IPC handlers can apply model/effort switches.
// Set once in main() before the query loop starts.
let sdkEnvRef: Record<string, string | undefined> = {};
// Tracks the previous model for one-shot switches (revert after query completes).
let pendingOneshotRevert: string | null | undefined;
// Active Query handle for mid-query setModel() calls via IPC.
let activeQuery: Query | null = null;
// Last model alias sent via setModel() — skip redundant calls when unchanged.
let lastSetModelAlias: string | undefined;

/**
 * Convert a full model ID to the CLI alias that setModel() expects.
 * The SDK subprocess recognises short aliases (opus, sonnet[1m], haiku)
 * but may silently ignore full IDs like "claude-opus-4-6[1m]".
 */
function toCliAlias(model: string): string {
  if (model.startsWith('claude-opus-4')) return model.includes('[1m]') ? 'opus[1m]' : 'opus';
  if (model.startsWith('claude-sonnet-4')) return model.includes('[1m]') ? 'sonnet[1m]' : 'sonnet';
  if (model.startsWith('claude-haiku')) return 'haiku';
  log(`toCliAlias: unrecognized model "${model}", passing through as-is`);
  return model;
}

/**
 * Returns channel-type-specific message formatting instructions based on the JID prefix.
 *
 * This is injected into the system prompt on every invocation so that even groups with
 * globalContext:false (no /workspace/global mount) get correct formatting guidance.
 *
 * Note: for WhatsApp and Telegram, MAIN groups access the global CLAUDE.md via the
 * /workspace/project SDK auto-load (entire groups/ dir is mounted there). Non-MAIN
 * WhatsApp/Telegram groups with globalContext:true also get it via the /workspace/global
 * mount. This function covers Slack and Discord explicitly; a future non-MAIN
 * WhatsApp/Telegram group with globalContext:false would need entries added here.
 *
 * Returns undefined for unrecognised JID prefixes — no formatting injection.
 */
function getChannelFormattingInstructions(chatJid: string): string | undefined {
  if (chatJid.startsWith('slack:')) {
    return `## Response Style

Structure every response for scannability:
- Use emoji + *bold* section headers to anchor major sections (e.g. 🔑 *Decisions*, ✅ *Action Items*, 📋 *Summary*). Pick emojis contextually — informative, not decorative.
- Bullet points for lists, not paragraphs
- Bold key terms inline
- Short paragraphs — no walls of text

## Message Formatting

You are responding in a Slack channel. Use Slack mrkdwn syntax:
- *single asterisks* for bold
- _underscores_ for italic
- \`backticks\` for inline code
- \`\`\`triple backticks\`\`\` for code blocks
- - for bullet points

Do NOT use: **double asterisks**, ## headings, --- horizontal rules, [text](url) link syntax, or markdown tables. These do not render in Slack.`;
  }
  if (chatJid.startsWith('dc:')) {
    return `## Message Formatting

You are responding in a Discord channel. Use Discord markdown syntax:
- **double asterisks** for bold
- *single asterisks* for italic
- \`backticks\` for inline code
- \`\`\`triple backticks\`\`\` for code blocks
- - or * for bullet points
- > for blockquotes

Do NOT use: \`---\` horizontal rules (they appear as literal "---" in Discord, not dividers), [text](url) link syntax, or ## markdown headings.

Structure every response for scannability:
- Use **bold** section headers to separate major sections. Where emoji adds clarity or helps the reader scan (e.g. ✅ **Action Items**, 🔑 **Key Decisions**, ⚠️ **Issues**), include it — but only when it genuinely fits, not as decoration.
- Bullet points for lists, not paragraphs
- Short paragraphs — no walls of text`;
  }
  // WhatsApp/Telegram JIDs reach here intentionally — they use global CLAUDE.md for formatting.
  return undefined;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(content: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
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

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const PROGRESS_START_MARKER = '---NANOCLAW_PROGRESS_START---';
const PROGRESS_END_MARKER = '---NANOCLAW_PROGRESS_END---';
let progressSeq = 0;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function writeProgress(eventType: string, data: Record<string, string | undefined>): void {
  progressSeq++;
  console.log(PROGRESS_START_MARKER);
  console.log(JSON.stringify({ eventType, data, seq: progressSeq, ts: Date.now() }));
  console.log(PROGRESS_END_MARKER);
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
 * For thread sessions, also archives to /workspace/thread/conversations/
 * and writes a summary.txt for future Plan C indexing.
 */
function createPreCompactHook(assistantName?: string, threadId?: string): HookCallback {
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
      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);

      // Always archive to group conversations
      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filePath = path.join(conversationsDir, filename);
      fs.writeFileSync(filePath, markdown);
      log(`Archived conversation to ${filePath}`);

      // Thread-scoped archival: also archive to thread workspace
      if (threadId) {
        const threadConvDir = '/workspace/thread/conversations';
        fs.mkdirSync(threadConvDir, { recursive: true });
        const threadFilePath = path.join(threadConvDir, filename);
        fs.writeFileSync(threadFilePath, markdown);

        // Write summary.txt for future Plan C FTS5 indexing
        if (summary) {
          fs.writeFileSync(
            '/workspace/thread/summary.txt',
            summary,
          );
        }
        log(`Archived thread conversation to ${threadFilePath}`);
      }
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY_2',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GMAIL_OAUTH_PATH',
  'GMAIL_CREDENTIALS_PATH',
];

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

// Block ad-hoc use of Python's snowflake.connector.
// The snow CLI is gated by destructive-operation controls; the Python
// connector bypasses them.  Only blocks direct python execution — grep,
// echo, pip install, and existing scripts are unaffected.
const SNOWFLAKE_CONNECTOR_EXEC_RE =
  /\bpython[23]?\b.*\bsnowflake[._]connector\b/i;

function createBlockSnowflakeConnectorHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    if (SNOWFLAKE_CONNECTOR_EXEC_RE.test(command)) {
      return deny(
        'Direct use of Python snowflake.connector is blocked. ' +
        'Use the `snow sql` CLI for ad-hoc queries. If snow is not working, ' +
        'report the error to Dave instead of falling back to Python.',
      );
    }
    return {};
  };
}

// Self-approval prevention. The plugin hook (block-destructive.ts) handles all
// detection and gating. This hook only prevents the agent from bypassing the
// gate by writing approval files directly via Bash.
function createSelfApprovalBlockHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};
    if (/\.claude-destructive-gate/.test(command)) {
      return deny(
        'Self-approval of destructive operation gates is not allowed. ' +
        'Approval must come from the user via the chat channel.',
      );
    }
    return {};
  };
}

function deny(reason: string) {
  return {
    systemMessage: reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
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
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
interface IpcMessage {
  text: string;
  attachments?: ContainerAttachment[];
}

function drainIpcInput(): IpcMessage[] {
  try {
    // Dir already created in main() at startup
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.type === 'message' && data.text) {
          messages.push({
            text: data.text,
            attachments: data.attachments,
          });
        } else if (data.type === 'model_switch' && data.model) {
          if (data.oneshot && pendingOneshotRevert === undefined) {
            // Save previous model for revert after next query (only if not already pending)
            pendingOneshotRevert = sdkEnvRef['CLAUDE_CODE_USE_MODEL'] || null;
          }
          sdkEnvRef['CLAUDE_CODE_USE_MODEL'] = data.model;
          if (activeQuery) {
            const alias = toCliAlias(data.model);
            activeQuery.setModel(alias).catch(err =>
              log(`setModel(${alias}) failed: ${err instanceof Error ? err.message : String(err)}`),
            );
            lastSetModelAlias = alias;
          }
          log(`Model switched via IPC: ${data.model}${data.oneshot ? ' (one-shot)' : ''}`);
        } else if (data.type === 'effort_switch' && data.effort) {
          sdkEnvRef['CLAUDE_CODE_USE_EFFORT'] = data.effort;
          if (activeQuery) {
            activeQuery.applyFlagSettings({ effortLevel: data.effort }).catch(err =>
              log(`applyFlagSettings(effort=${data.effort}) failed: ${err instanceof Error ? err.message : String(err)}`),
            );
          }
          log(`Effort switched via IPC: ${data.effort}`);
        }
        try { fs.unlinkSync(filePath); } catch { /* ignore delete failures */ }
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
 * Returns the combined content (text + optional attachments), or null if _close.
 */
function waitForIpcMessage(): Promise<{ text: string; attachments?: ContainerAttachment[] } | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        const text = messages.map(m => m.text).join('\n');
        // Merge attachments from all drained messages
        const allAttachments: ContainerAttachment[] = [];
        for (const m of messages) {
          if (m.attachments) allAttachments.push(...m.attachments);
        }
        resolve({
          text,
          attachments: allAttachments.length > 0 ? allAttachments : undefined,
        });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function isToolEnabled(tools: string[] | undefined, name: string): boolean {
  if (!tools) return true;
  return tools.some(t => t === name || t.startsWith(name + ':'));
}

// Gmail, Calendar, and Workspace tools are now provided by gws CLI (Google Workspace CLI)
// via Bash + container skills (gws-gmail-*, gws-calendar-*).
// No MCP tool arrays needed — access is controlled by credential mounting.

/**
 * Build a runtime capability manifest from the per-group tools list,
 * for injection into the system prompt.
 *
 * `tools === undefined` means "all tools available" (NanoClaw's legacy
 * default for unrestricted groups) — emit the full manifest in that case.
 * `tools === []` means "no tools" — return undefined.
 */
function buildCapabilityManifest(
  tools: string[] | undefined,
): string | undefined {
  if (tools && tools.length === 0) return undefined;

  const capabilities: string[] = [];

  // Google Workspace services (gws CLI)
  if (isToolEnabled(tools, 'gmail')) {
    capabilities.push(
      '- **Gmail (read + send)** — `gws gmail` CLI. Skills: gws-gmail-read, gws-gmail-send, gws-gmail-reply, gws-gmail-forward, gws-gmail-triage, gws-gmail-watch.',
    );
  } else if (isToolEnabled(tools, 'gmail-readonly')) {
    capabilities.push(
      '- **Gmail (read-only)** — `gws gmail` CLI. Skills: gws-gmail-read, gws-gmail-triage.',
    );
  }
  if (isToolEnabled(tools, 'calendar')) {
    capabilities.push(
      '- **Google Calendar** — `gws calendar` CLI. Skills: gws-calendar-agenda, gws-calendar-insert.',
    );
  }
  if (isToolEnabled(tools, 'google-workspace')) {
    capabilities.push(
      '- **Google Drive / Sheets / Docs / Slides** — `gws drive|sheets|docs|slides` CLI.',
    );
  }

  // Data tools
  if (isToolEnabled(tools, 'snowflake')) {
    capabilities.push('- **Snowflake** — `snowsql` CLI and dbt profiles.');
  }
  if (isToolEnabled(tools, 'dbt')) {
    capabilities.push('- **dbt** — `dbt` CLI with profiles in `~/.dbt/profiles.yml`.');
  }

  // Cloud
  if (isToolEnabled(tools, 'aws')) {
    capabilities.push('- **AWS** — `aws` CLI with configured credentials.');
  }
  if (isToolEnabled(tools, 'gcloud')) {
    capabilities.push('- **Google Cloud** — `gcloud` CLI with configured credentials.');
  }

  // VCS / code review
  if (isToolEnabled(tools, 'github')) {
    capabilities.push(
      '- **GitHub** — `gh` CLI and `git push` with configured credentials.',
    );
  }

  // PaaS / infra
  if (isToolEnabled(tools, 'render')) {
    capabilities.push('- **Render** — Render API access via `RENDER_API_KEY`.');
  }
  if (isToolEnabled(tools, 'railway')) {
    capabilities.push(
      '- **Railway** — Railway API access via `RAILWAY_API_TOKEN`.',
    );
  }

  // Observability / analytics
  if (isToolEnabled(tools, 'braintrust')) {
    capabilities.push(
      '- **Braintrust** — evals and experiments via Braintrust API.',
    );
  }
  if (isToolEnabled(tools, 'omni')) {
    capabilities.push('- **Omni** — dashboards and queries via Omni API.');
  }

  // Browser automation
  if (isToolEnabled(tools, 'browser-auth')) {
    capabilities.push(
      '- **Browser Auth** — headless browser login flow via Playwright.',
    );
  }

  // Search / research
  if (isToolEnabled(tools, 'exa')) {
    capabilities.push(
      '- **Exa** — web search, research, and crawling via MCP tools.',
    );
  }

  // Meetings
  if (isToolEnabled(tools, 'granola')) {
    capabilities.push(
      '- **Granola** — meeting transcripts and notes via MCP tools.',
    );
  }

  if (capabilities.length === 0) return undefined;

  return `## Runtime Capabilities\n\nThe following tools and services are configured for this session. If a tool fails at runtime (auth error, missing credential, network issue), surface the error rather than retrying blindly.\n\n${capabilities.join('\n')}`;
}

/**
 * Document the per-thread scratch + host-direct-mount workspace semantics
 * so the agent knows what persists and where to write thread-local state.
 * Always included regardless of tool config.
 */
function buildWorkspacePersistenceNote(): string {
  return `## Workspace Persistence

Your cwd is \`/workspace/group\`. Semantics differ by channel.

**Threaded channels (Slack/Discord threads):** \`/workspace/group\` is a per-thread scratch directory. On prepare, every top-level entry from the host group folder is copied in so you can read \`.context/\`, \`.claude/\`, plan files, screenshots, etc. Sensitive filenames (auth, token, secret, .env, .pem, .key, id_rsa, etc.) are excluded and invisible to you.

**Existing group repos in threaded channels** (e.g. \`/workspace/group/XZO-BACKEND\`) are **git worktrees** sharing the host repo's \`.git\`, not fresh clones. They start in **detached HEAD** mode at the tip of origin's default branch. **This is normal — the worktree is NOT broken.**

Group worktrees have a **read-only \`.git\` directory** inside the container (the host bind-mount is ro for security — a rw mount would enable agent-planted git hooks to execute on the host). This means:

- ✅ **Read operations work**: \`git status\`, \`git log\`, \`git diff\`, \`git blame\`, \`git show\`, \`gitnexus analyze\`, and any other pure-read git command.
- ❌ **Write operations will fail with EROFS**: \`git add\`, \`git commit\`, \`git checkout -b\`, \`git branch\`, \`git stash\`, \`git push\`, \`git config --local\`, \`git worktree prune/remove\`. Don't try; git will error.
- ✅ **Working-tree file edits are preserved**: edit files normally under \`/workspace/group/<repo>/\`. At thread cleanup the host runs \`git add -A && git commit -m "rescue: ..."\` via host-side rescue (which has rw access) and pushes a rescue branch to origin. Your edits survive.
- 🔀 **If you need multiple in-session commits or branch management** on an existing group repo, \`git clone\` the repo into \`/workspace/thread/<name>\` first. That's a full clone with its own rw \`.git\`, and \`/workspace/thread/\` is writable. Clones inside \`/workspace/thread/\` persist across turns in this thread; they do NOT automatically promote to the host group folder.

**Cross-thread ref namespace:** sibling threads in the same group share the source repo's \`.git/refs\` and \`.git/objects\` via the shared read-only bind mount. Branches and commits from other threads' \`git clone\`-then-commit workflows are visible via \`git log --all\` and \`git branch -a\`, but you can't delete/modify them (ro) and MUST NOT run \`git worktree prune\` or \`git worktree remove\` against sibling thread entries even if the commands were allowed.

**Fresh clones you create in \`/workspace/group/\`** (\`git clone ...\` at the workspace root) are promoted to the host group folder via atomic rename at cleanup. For existing-repo work that needs rw git, prefer \`/workspace/thread/\` instead (see above).

**Write boundary:** only \`/workspace/group\` and \`/workspace/thread\` are writable to you. The rest of \`/workspace/*\` is read-only (owned by a different uid on the host). Don't try to \`mkdir\` or \`git clone\` outside those two paths — it will fail with EACCES.

**Non-repo scratch:** agent-created new files at the top of \`/workspace/group\` land on the host at cleanup. Edits to pre-existing *loose* host files (outside any repo) are DROPPED at cleanup (host wins on collision). Edits to files *inside* any git repo are rescued, not dropped.

**Non-threaded channels (DMs, main group):** direct mount of the host group folder. All writes persist immediately.

**\`/workspace/thread/\`** is a per-thread persistent directory for intermediate work, scratch notes, draft documents, and any state you want preserved between user turns in this thread but not published to the group. Survives across messages in the same thread. Use it for plan drafts, scratch analysis, and thread-local state.`;
}

function buildAllowedTools(tools: string[] | undefined): string[] {
  const allowed = [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    // TaskCreate / TaskList / TaskUpdate / TaskGet are required by the
    // bootstrap workflow plugin (team-build skill registers tasks per
    // builder group, then polls TaskList for spawn verification). Without
    // these, the lead agent in /team-build silently fails to register
    // tasks and the spawn-verification poll cannot run. Confirmed root
    // cause of the illie 2026-04-08 build stall.
    'TaskCreate', 'TaskList', 'TaskUpdate', 'TaskGet',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
  ];
  // Gmail and Calendar: handled by gws CLI via Bash (no MCP tools to allow)
  if (isToolEnabled(tools, 'exa')) {
    allowed.push('mcp__exa__*');
    allowed.push('mcp__exa-websets__*');
  }
  if (isToolEnabled(tools, 'granola')) allowed.push('mcp__granola__*');
  if (isToolEnabled(tools, 'braintrust')) allowed.push('mcp__braintrust__*');
  if (isToolEnabled(tools, 'omni')) allowed.push('mcp__omni__*');
  // Google Workspace (Drive, Sheets, Docs, Slides): handled by gws CLI via Bash
  allowed.push('mcp__ollama__*');
  allowed.push('mcp__gitnexus__*');
  return allowed;
}

// Gmail/Calendar disallowed tools no longer needed — gws CLI access is
// controlled by credential mounting (no credentials = no access).
function buildDisallowedTools(_tools: string[] | undefined): string[] {
  return [];
}

const EXA_TOOLS = [
  'web_search_exa', 'web_search_advanced_exa', 'get_code_context_exa',
  'crawling_exa', 'company_research_exa', 'people_search_exa',
  'deep_researcher_start', 'deep_researcher_check', 'deep_search_exa',
] as const;

type StdioServer = { command: string; args: string[]; env?: Record<string, string> };
type HttpServer = { type: 'http'; url: string; headers?: Record<string, string> };
type McpServer = StdioServer | HttpServer;

function buildMcpServers(
  containerInput: ContainerInput,
  mcpServerPath: string,
) {
  const tools = containerInput.tools;
  const servers: Record<string, McpServer> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        ...(containerInput.threadId
          ? { NANOCLAW_THREAD_ID: containerInput.threadId }
          : {}),
      },
    },
  };
  // Gmail and Calendar: no MCP servers — agent uses gws CLI via Bash.
  // Credentials are mounted at /home/node/.gmail-mcp*/ and converted
  // to gws authorized_user format by entrypoint.sh at container startup.
  if (isToolEnabled(tools, 'exa')) {
    // Exa uses query-param auth (?exaApiKey=), not HTTP headers,
    // so the OneCLI proxy can't inject it. Key comes via secrets.
    const exaKey = containerInput.secrets?.EXA_API_KEY;
    const exaUrl = new URL('https://mcp.exa.ai/mcp');
    exaUrl.searchParams.set('tools', EXA_TOOLS.join(','));
    if (exaKey) exaUrl.searchParams.set('exaApiKey', exaKey);
    servers.exa = { type: 'http', url: exaUrl.toString() };
    const websetsUrl = new URL('https://websetsmcp.exa.ai/mcp');
    if (exaKey) websetsUrl.searchParams.set('exaApiKey', exaKey);
    servers['exa-websets'] = { type: 'http', url: websetsUrl.toString() };
  }
  if (isToolEnabled(tools, 'granola')) {
    // Auth header is injected by the OneCLI HTTPS proxy at request time.
    // No explicit token needed — the proxy matches mcp.granola.ai and injects Bearer credentials.
    servers.granola = {
      type: 'http',
      url: 'https://mcp.granola.ai/mcp',
    };
  }
  if (isToolEnabled(tools, 'braintrust')) {
    // Proxy doesn't reliably inject auth for MCP/SSE endpoints,
    // so pass the API key directly in the header config.
    const btKey = containerInput.secrets?.BRAINTRUST_API_KEY;
    servers.braintrust = {
      type: 'http',
      url: 'https://api.braintrust.dev/mcp',
      headers: {
        'Accept': 'application/json, text/event-stream',
        ...(btKey ? { 'Authorization': `Bearer ${btKey}` } : {}),
      },
    };
  }
  if (isToolEnabled(tools, 'omni')) {
    // Auth (Bearer) injected by OneCLI HTTPS proxy (matches sunday.omniapp.co).
    servers.omni = {
      type: 'http',
      url: 'https://sunday.omniapp.co/mcp/https',
    };
  }
  // Google Workspace: no MCP server — agent uses gws CLI via Bash.
  if (isToolEnabled(tools, 'ollama')) {
    servers.ollama = {
      command: 'node',
      args: [path.join(path.dirname(mcpServerPath), 'ollama-mcp-stdio.js')],
    };
  }
  servers.gitnexus = {
    command: 'gitnexus',
    args: ['mcp'],
  };
  return servers;
}

/**
 * Builds the prompt with attachment references.
 * All attachments (images and documents) are referenced as file paths so the
 * agent reads them via the Read tool. This is the pattern Claude Code supports
 * natively — the SDK/CLI does not reliably pass base64 image content blocks
 * in user messages through to the API.
 */
function buildPromptContent(
  prompt: string,
  attachments?: ContainerAttachment[],
): string {
  log(`buildPromptContent called: attachments=${attachments?.length ?? 0}`);
  if (!attachments || attachments.length === 0) return prompt;

  const parts: string[] = [prompt];

  for (const att of attachments) {
    if (IMAGE_MIME_TYPES.has(att.mimeType)) {
      // Reference image file path — agent uses the Read tool (which supports images natively)
      if (!fs.existsSync(att.containerPath)) {
        log(`Attachment file not found: ${att.containerPath}`);
        parts.push(`[Image attachment "${att.filename}" not available]`);
      } else {
        parts.push(`[Image "${att.filename}" attached at: ${att.containerPath} — use the Read tool to view it]`);
      }
    } else {
      // Non-image attachments: reference as file path for agent to read
      parts.push(`[Attached file "${att.filename}" available at: ${att.containerPath}]`);
    }
  }

  return parts.join('\n');
}

/**
 * Discover SDK plugins from /workspace/plugins/.
 * Each mounted repo is checked for:
 *   - Direct plugin: has .claude-plugin/plugin.json at root (e.g. impeccable, omni-claude-skills)
 *   - Multi-plugin repo: has plugins/ subdir with individual plugins (e.g. bootstrap)
 */
function discoverPlugins(): { plugins: Array<{ type: 'local'; path: string }>; errors: string[] } {
  const pluginsRoot = process.env.CLAUDE_PLUGINS_ROOT || '/workspace/plugins';
  if (!fs.existsSync(pluginsRoot)) return { plugins: [], errors: [] };
  const plugins: Array<{ type: 'local'; path: string }> = [];
  const errors: string[] = [];
  try {
    for (const entry of fs.readdirSync(pluginsRoot)) {
      const repoPath = path.join(pluginsRoot, entry);
      try {
        if (!fs.statSync(repoPath).isDirectory()) continue;
      } catch (e) {
        errors.push(`${entry}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // Direct plugin (has .claude-plugin/plugin.json at root)
      if (fs.existsSync(path.join(repoPath, '.claude-plugin', 'plugin.json'))) {
        plugins.push({ type: 'local', path: repoPath });
        continue;
      }
      // Multi-plugin repo (has plugins/ subdir with individual plugins)
      const subPluginsDir = path.join(repoPath, 'plugins');
      if (!fs.existsSync(subPluginsDir)) continue;
      for (const sub of fs.readdirSync(subPluginsDir)) {
        const subPath = path.join(subPluginsDir, sub);
        try {
          if (!fs.statSync(subPath).isDirectory()) continue;
        } catch (e) {
          errors.push(`${entry}/plugins/${sub}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        if (fs.existsSync(path.join(subPath, '.claude-plugin', 'plugin.json'))) {
          plugins.push({ type: 'local', path: subPath });
        }
      }
    }
  } catch (e) {
    errors.push(`readdir ${pluginsRoot}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { plugins, errors };
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
/** Invariant context for the container's query loop (set once in main). */
interface QueryContext {
  mcpServerPath: string;
  containerInput: ContainerInput;
  sdkEnv: Record<string, string | undefined>;
  buildSystemPrompt: (model?: string) => { type: 'preset'; preset: 'claude_code'; append: string } | undefined;
  plugins: Array<{ type: 'local'; path: string }>;
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  ctx: QueryContext,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const { mcpServerPath, containerInput, sdkEnv, buildSystemPrompt, plugins } = ctx;
  // Rebuild system prompt with current model (may differ from startup if IPC switched it)
  const currentModel = sdkEnv['CLAUDE_CODE_USE_MODEL'] || containerInput.model;
  const systemPromptOption = buildSystemPrompt(currentModel);
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  // Track whether a user message was piped in since the last writeOutput.
  // When true, the next assistant text block is treated as a user-facing
  // response and emitted via writeOutput (so the host sends it to Discord),
  // not just as a progress event.
  let hasPipedSinceLastOutput = false;
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
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars, attachments=${msg.attachments?.length ?? 0})`);
      const content = buildPromptContent(msg.text, msg.attachments);
      stream.push(content);
      hasPipedSinceLastOutput = true;
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let lastAssistantText = ''; // accumulate text from assistant content blocks
  let messageCount = 0;
  let resultCount = 0;
  // Per-runQuery cumulative outputTokens snapshot, used to detect which
  // model(s) actually produced output in the latest result (we diff against
  // the prior snapshot since `modelUsage` is cumulative across the turns of
  // a single Query). Local to runQuery so each new query starts from a
  // clean slate — the SDK may or may not reset modelUsage between Query
  // objects, and a stale snapshot would mask growth (curr<prev → no flag).
  const cumulativeOutputTokensByModel = new Map<string, number>();

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

  // Thread workspace: if running in a thread session, add /workspace/thread
  // as an additional directory so the agent can access thread-specific files
  const threadDir = '/workspace/thread';
  if (containerInput.threadId && fs.existsSync(threadDir)) {
    extraDirs.push(threadDir);
  }

  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Effort level for this run (per-message flag > session sticky > default 'high')
  const effort = containerInput.effort as
    | 'low'
    | 'medium'
    | 'high'
    | 'max'
    | undefined;
  if (effort) {
    log(`Using effort: ${effort}`);
  }

  // Capture the Query handle so drainIpcInput() can call setModel() mid-query.
  const q: Query = query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: systemPromptOption,
      allowedTools: buildAllowedTools(containerInput.tools),
      disallowedTools: buildDisallowedTools(containerInput.tools),
      env: sdkEnv,
      // Only pass model on fresh sessions — the SDK rejects model changes on
      // resumed sessions via the options.  setModel() handles mid-session switches.
      ...(!sessionId && sdkEnv['CLAUDE_CODE_USE_MODEL'] ? { model: sdkEnv['CLAUDE_CODE_USE_MODEL'] } : {}),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: buildMcpServers(containerInput, mcpServerPath),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(sdkEnv['CLAUDE_CODE_USE_EFFORT'] || effort ? { effort: (sdkEnv['CLAUDE_CODE_USE_EFFORT'] || effort) as EffortLevel } : {}),
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName, containerInput.threadId)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSelfApprovalBlockHook(), createBlockSnowflakeConnectorHook(), createSanitizeBashHook()] }],
      },
    },
  });

  activeQuery = q;

  // Apply model to the subprocess if it changed since the last setModel() call.
  if (currentModel) {
    const alias = toCliAlias(currentModel);
    if (alias !== lastSetModelAlias) {
      await q.setModel(alias);
      lastSetModelAlias = alias;
      log(`setModel(${alias}) applied at query start`);
    }
  }

  for await (const message of q) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    // Emit progress events for real-time web UI streaming
    if (message.type === 'assistant' && 'message' in message) {
      const content = (message as { message: { content: Array<{ type: string; text?: string; thinking?: string; name?: string; input?: unknown; id?: string }> } }).message.content;
      if (Array.isArray(content)) {
        // Piped check-in reply: emit text via writeOutput so the host sends
        // it to Discord now, rather than waiting for the turn's `result`
        // (which may never come if tool_use continues the turn).
        // Only emit when tool_use is also present — text-only turns produce
        // a `result` shortly, so the normal path handles those.
        if (hasPipedSinceLastOutput) {
          let hasText = false;
          let hasToolUse = false;
          const textParts: string[] = [];
          for (const b of content) {
            if (b.type === 'text' && b.text) { textParts.push(b.text); hasText = true; }
            else if (b.type === 'tool_use') { hasToolUse = true; }
          }
          if (hasText && hasToolUse) {
            const intermediateText = textParts.join('\n');
            log(`Emitting intermediate text as output (piped reply, ${intermediateText.length} chars)`);
            writeOutput({
              status: 'success',
              result: intermediateText,
              newSessionId,
            });
          }
          // Reset on any assistant message — text-only will be delivered via
          // the result path; tool-use-only means the agent chose not to reply.
          if (hasText || hasToolUse) {
            hasPipedSinceLastOutput = false;
          }
        }

        // Accumulate text for fallback when result.result is null
        const textBlocks = content.filter((b) => b.type === 'text' && b.text);
        if (textBlocks.length > 0) {
          lastAssistantText = textBlocks.map((b) => b.text!).join('\n');
        }

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            writeProgress('text', { text: block.text });
          } else if (block.type === 'tool_use') {
            writeProgress('tool_use', {
              name: block.name,
              input: JSON.stringify(block.input).slice(0, 2000),
              id: block.id,
            });
          } else if (block.type === 'thinking' && block.thinking) {
            writeProgress('thinking', { text: block.thinking.slice(0, 1000) });
          }
        }
      }
    }

    if (message.type === 'system') {
      const subtype = (message as { subtype?: string }).subtype || 'unknown';
      writeProgress('system', {
        subtype,
        info: (message as { session_id?: string }).session_id ||
              (message as { summary?: string }).summary,
      });
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);

      // Log SDK-loaded plugins for diagnostics
      const loadedPlugins = (message as { plugins?: Array<{ name: string; path?: string }> }).plugins || [];
      if (loadedPlugins.length > 0) {
        log(`SDK init plugins (${loadedPlugins.length}): ${loadedPlugins.map(p => p.name).join(', ')}`);
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      // Log full result message keys and modelUsage to discover the actual shape
      const msgAny = message as Record<string, unknown>;
      if (msgAny.modelUsage) {
        log(`Model usage: ${JSON.stringify(msgAny.modelUsage)}`);
      } else {
        // Check all top-level keys for usage-related fields
        const usageKeys = Object.keys(msgAny).filter(k => k !== 'type' && k !== 'subtype' && k !== 'result');
        if (usageKeys.length > 0) {
          log(`Result extra keys: ${usageKeys.join(', ')} = ${JSON.stringify(Object.fromEntries(usageKeys.map(k => [k, msgAny[k]])))}`);
        }
      }
      // Diff modelUsage against the prior cumulative snapshot to figure out
      // which model(s) actually produced output in this turn. The host uses
      // this to verify that an `-m`/`-m1` switch took effect before
      // confirming to the user.
      let modelsUsedThisTurn: string[] | undefined;
      if (msgAny.modelUsage && typeof msgAny.modelUsage === 'object') {
        const usage = msgAny.modelUsage as Record<string, { outputTokens?: number }>;
        const grew: string[] = [];
        for (const [modelId, m] of Object.entries(usage)) {
          const curr = typeof m?.outputTokens === 'number' ? m.outputTokens : 0;
          const prev = cumulativeOutputTokensByModel.get(modelId) || 0;
          if (curr > prev) grew.push(modelId);
          cumulativeOutputTokensByModel.set(modelId, curr);
        }
        if (grew.length > 0) modelsUsedThisTurn = grew;
      }
      // Claude Code SDK may return result: null when text was only sent via
      // streaming events. Fall back to the last assistant text block content.
      writeOutput({
        status: 'success',
        result: textResult || lastAssistantText || null,
        newSessionId,
        modelsUsedThisTurn
      });
      lastAssistantText = '';
      hasPipedSinceLastOutput = false;

      // Revert one-shot model switch after the turn's result is emitted.
      if (pendingOneshotRevert !== undefined) {
        sdkEnvRef['CLAUDE_CODE_USE_MODEL'] = pendingOneshotRevert || undefined;
        const revertAlias = pendingOneshotRevert ? toCliAlias(pendingOneshotRevert) : 'default';
        activeQuery?.setModel(revertAlias).catch(err =>
          log(`setModel revert failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        lastSetModelAlias = revertAlias;
        log(`One-shot model reverted to: ${revertAlias}`);
        pendingOneshotRevert = undefined;
      }
    }
  }

  ipcPolling = false;
  activeQuery = null;

  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
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
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
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
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
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

  // Expose IPC routing env vars so plugin hooks (child processes) can detect
  // NanoClaw mode and write IPC queries for gate approval.
  process.env.NANOCLAW_IPC_DIR = '/workspace/ipc';
  process.env.NANOCLAW_CHAT_JID = containerInput.chatJid;
  if (containerInput.threadId) {
    process.env.NANOCLAW_THREAD_ID = containerInput.threadId;
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  // CLI tools that previously needed secrets exported to process.env now get
  // credentials injected by the OneCLI HTTPS proxy at request time. Only
  // non-HTTP secrets (dbt login, gcloud/gws credential paths) remain in
  // containerInput.secrets. Export these so CLI tools can read them as env vars.
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    if (key.startsWith('DBT_CLOUD_') || key.startsWith('OMNI_') || key.startsWith('BROWSER_AUTH_') || key === 'GOOGLE_APPLICATION_CREDENTIALS' || key === 'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE' || key === 'RAILWAY_API_TOKEN') {
      process.env[key] = value;
    }
  }

  // Set the per-run model in sdkEnv. drainIpcInput() reads this as the
  // baseline for one-shot downgrade reverts; runQuery() suppresses the
  // SDK `model` option on resumed sessions so passing it here is safe.
  if (containerInput.model) {
    sdkEnv['CLAUDE_CODE_USE_MODEL'] = containerInput.model;
    log(`Using model: ${containerInput.model}`);
  }

  // Expose sdkEnv to IPC handlers so model/effort switches can be applied mid-session
  sdkEnvRef = sdkEnv;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Discover SDK plugins from mounted bootstrap directory
  const { plugins, errors: pluginErrors } = discoverPlugins();
  if (pluginErrors.length > 0) {
    log(`WARNING: Plugin discovery errors: ${pluginErrors.join('; ')}`);
  }
  if (plugins.length > 0) {
    log(`Discovered ${plugins.length} plugin(s): ${plugins.map(p => path.basename(p.path)).join(', ')}`);
  }

  // Warn if the workflow plugin (block-destructive hook) was not discovered.
  if (!plugins.some(p => path.basename(p.path) === 'workflow')) {
    log('WARNING: workflow plugin (block-destructive hook) NOT discovered — destructive commands will not be gated');
    writeOutput({
      status: 'success',
      result: '\u26a0\ufe0f Safety notice: The destructive-command guard plugin failed to load. ' +
        'Destructive operations (DROP TABLE, terraform destroy, etc.) will not be gated for approval.',
    });
  }

  // Build systemPrompt once — chatJid and global CLAUDE.md are invariant for the container lifetime.
  // channelFormatting is placed AFTER globalClaudeMd so it overrides the WA/Telegram formatting
  // rule in global CLAUDE.md for Slack/Discord groups. This also ensures globalContext:false groups
  // (no /workspace/global mount) still receive channel-appropriate formatting guidance.
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  const globalClaudeMd = !containerInput.isMain && fs.existsSync(globalClaudeMdPath)
    ? fs.readFileSync(globalClaudeMdPath, 'utf-8')
    : undefined;
  const channelFormatting = getChannelFormattingInstructions(containerInput.chatJid);
  // Inject agent identity so the agent knows its own name and can distinguish itself from other bots
  const identityNote = containerInput.assistantName
    ? `Your name is ${containerInput.assistantName}. Messages in the conversation history may include is_from_me="true" (your own previous messages) and is_bot="true" (messages from any bot). A message with is_bot="true" but without is_from_me="true" is from a different bot — not you. When referencing or tagging yourself, always use the name "${containerInput.assistantName}".`
    : undefined;
  // Inject default tone profile at boot — full file content, read once.
  // Same pattern as claude.ai's Personalize instructions: static system prompt block.
  // The get_tone_profile tool is still available for overrides (loading a different profile)
  // and email drafts (Dave-voice profiles via selection guide).
  let toneNote: string | undefined;
  if (containerInput.tone) {
    const toneProfilePath = `/workspace/tone-profiles/${containerInput.tone}.md`;
    if (fs.existsSync(toneProfilePath)) {
      const toneContent = fs.readFileSync(toneProfilePath, 'utf-8');
      toneNote = `## Default Tone Profile: ${containerInput.tone}\n\n${toneContent}\n\nThis is your default tone for this session. Use the get_tone_profile tool to load a different profile when drafting emails or when the user requests a tone override ("use X tone"). If the user says "use X tone" and no profile file exists, interpret X as an ad-hoc style hint. Per-response overrides revert to this default on the next message. Per-session overrides ("switch to X tone") persist for the thread.`;
    } else {
      toneNote = `Your default tone profile is "${containerInput.tone}" (no profile file found — use this as a style hint). Use the get_tone_profile tool to load profiles for email drafts or tone overrides.`;
    }
  }
  // Runtime capability manifest — tells the agent what tools/services are actually
  // available in this session, derived from containerInput.tools.  Placed last so it
  // takes precedence over any contradictory static CLAUDE.md claims.
  const capabilityManifest = buildCapabilityManifest(containerInput.tools);

  // Document /workspace/group vs /workspace/thread persistence semantics
  // so the agent knows where to write thread-local state.
  const workspacePersistenceNote = buildWorkspacePersistenceNote();

  // Static system prompt parts (everything except model identity, which changes per query)
  const staticPromptParts = [
    globalClaudeMd,
    channelFormatting,
    identityNote,
    toneNote,
    capabilityManifest,
    workspacePersistenceNote,
  ].filter(Boolean);

  // Build the full system prompt with the current model identity.
  // Called per runQuery() so the model note reflects IPC model switches.
  function buildSystemPrompt(model?: string) {
    const modelNote = model
      ? `You are running on model: ${model}. If the user asks what model you are using, report this accurately.`
      : undefined;
    const parts = [...staticPromptParts, ...(modelNote ? [modelNote] : [])];
    return parts.length > 0
      ? { type: 'preset' as const, preset: 'claude_code' as const, append: parts.join('\n\n') }
      : undefined;
  }
  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let promptText = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    promptText = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${promptText}`;
  }
  // Merge any pending IPC messages (and their attachments) into the initial prompt
  const allAttachments = containerInput.attachments ? [...containerInput.attachments] : [];
  log(`Attachments from stdin: ${containerInput.attachments?.length ?? 0}, paths: ${(containerInput.attachments || []).map(a => a.containerPath).join(', ') || 'none'}`);
  for (const att of allAttachments) {
    log(`  ${att.filename} (${att.mimeType}) exists=${fs.existsSync(att.containerPath)} path=${att.containerPath}`);
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    promptText += '\n' + pending.map(m => m.text).join('\n');
    for (const m of pending) {
      if (m.attachments) allAttachments.push(...m.attachments);
    }
  }

  // --- Slash command handling ---
  // Only known session slash commands are handled here. This prevents
  // accidental interception of user prompts that happen to start with '/'.
  const KNOWN_SESSION_COMMANDS = new Set(['/compact']);
  const trimmedPrompt = promptText.trim();
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
          ...(containerInput.model ? { model: containerInput.model } : {}),
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'] as const,
          ...(plugins.length > 0 ? { plugins } : {}),
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

  // Build initial prompt content with attachments (images → base64 content blocks)
  let prompt: string = buildPromptContent(
    promptText,
    allAttachments.length > 0 ? allAttachments : undefined,
  );

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
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
  const queryCtx: QueryContext = { mcpServerPath, containerInput, sdkEnv, buildSystemPrompt, plugins };
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult;
      try {
        queryResult = await runQuery(prompt, sessionId, queryCtx, resumeAt);
      } catch (runErr) {
        const runErrMsg = runErr instanceof Error ? runErr.message : String(runErr);
        const isPromptTooLong = runErrMsg.includes('prompt is too long') || runErrMsg.includes('prompt_too_long') || runErrMsg.includes('maximum context length');
        const isRetryable = !isPromptTooLong && (
          runErrMsg.includes('429') ||
          /rate.?limit/i.test(runErrMsg) ||
          /overloaded/i.test(runErrMsg) ||
          runErrMsg.includes('upstream_error') ||
          runErrMsg.includes('External provider returned')
        );
        const backupKey = sdkEnv['ANTHROPIC_API_KEY_2'];
        if (isRetryable && backupKey && sdkEnv['ANTHROPIC_API_KEY'] !== backupKey) {
          log(`retryable error detected (${runErrMsg.slice(0, 80)}), rotating to ANTHROPIC_API_KEY_2`);
          sdkEnv['ANTHROPIC_API_KEY'] = backupKey;
          queryResult = await runQuery(prompt, sessionId, queryCtx, resumeAt);
        } else {
          throw runErr;
        }
      }
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Revert one-shot model switch after query completes
      if (pendingOneshotRevert !== undefined) {
        sdkEnvRef['CLAUDE_CODE_USE_MODEL'] = pendingOneshotRevert || undefined;
        log(`One-shot model reverted to: ${pendingOneshotRevert || 'default'}`);
        pendingOneshotRevert = undefined;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it.
      // idle: true tells the host the agent is waiting for new input and can
      // be safely preempted.  Intermediate results (text or null) within a
      // query do NOT carry this flag, preventing premature closeStdin while
      // piped messages are still being processed.
      writeOutput({ status: 'success', result: null, newSessionId: sessionId, idle: true });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars), starting new query`);
      prompt = buildPromptContent(nextMessage.text, nextMessage.attachments);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);

    // Detect prompt_too_long errors for auto-recovery by the host
    const isPromptTooLong =
      errorMessage.includes('prompt is too long') ||
      errorMessage.includes('prompt_too_long') ||
      errorMessage.includes('maximum context length');

    // Try to retrieve session summary for recovery context
    let summary: string | undefined;
    if (isPromptTooLong && sessionId) {
      const claudeDir = '/home/node/.claude';
      const indexPath = path.join(claudeDir, 'projects', 'default', 'sessions-index.json');
      summary = getSessionSummary(sessionId, indexPath) || undefined;
    }

    writeOutput({
      status: 'error',
      result: summary ? `[Previous context summary]: ${summary}` : null,
      newSessionId: sessionId,
      error: errorMessage,
      errorType: isPromptTooLong ? 'prompt_too_long' : 'general',
    });
    process.exit(1);
  }
}

main();
