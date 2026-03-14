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
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
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
  secrets?: Record<string, string>;
  tools?: string[];
  attachments?: ContainerAttachment[];
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorType?: 'prompt_too_long' | 'general';
  idle?: boolean;
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

// Content block types for Claude vision (defined inline since SDK types aren't directly importable)
type TextBlock = { type: 'text'; text: string };
type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
type ContentBlock = TextBlock | ImageBlock;

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_SUBDIR = process.env.IPC_INPUT_SUBDIR;
if (!IPC_INPUT_SUBDIR) {
  console.error('[agent-runner] FATAL: IPC_INPUT_SUBDIR env var is required');
  process.exit(1);
}
const IPC_INPUT_DIR = `/workspace/ipc/input/${IPC_INPUT_SUBDIR}`;
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

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

  push(content: string | ContentBlock[]): void {
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
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

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

/** True when tools has scoped entries (e.g. 'gmail:illysium') but no bare entry ('gmail'). */
function isToolScoped(tools: string[] | undefined, name: string): boolean {
  if (!tools) return false;
  return tools.some(t => t.startsWith(name + ':')) && !tools.includes(name);
}

// Read-only Gmail tools — scoped groups (e.g. gmail:illysium) get these instead of mcp__gmail__*
// Excluded write tools: send_email, draft_email, modify_email, delete_email,
// batch_modify_emails, batch_delete_emails, create_label, update_label, delete_label,
// get_or_create_label, create_filter, create_filter_from_template, delete_filter
const GMAIL_READ_TOOLS = [
  'mcp__gmail__search_emails',
  'mcp__gmail__read_email',
  'mcp__gmail__list_email_labels',
  'mcp__gmail__list_filters',
  'mcp__gmail__get_filter',
  'mcp__gmail__download_attachment',
] as const;

// Read-only Calendar tools — scoped groups get these instead of mcp__google-calendar__*
// Excluded write tools: create-event, create-events, delete-event, update-event, respond-to-event
const CALENDAR_READ_TOOLS = [
  'mcp__google-calendar__list-events',
  'mcp__google-calendar__get-event',
  'mcp__google-calendar__search-events',
  'mcp__google-calendar__list-calendars',
  'mcp__google-calendar__list-colors',
  'mcp__google-calendar__get-current-time',
  'mcp__google-calendar__get-freebusy',
] as const;

// Read-only Google Workspace tools — scoped groups get these instead of mcp__google-workspace__*
// Excluded write tools: batch_update_doc, batch_update_presentation, copy_drive_file,
// create_*, delete_*, export_doc_to_pdf, find_and_replace_doc, format_sheet_range,
// import_to_google_doc, insert_*, manage_*, modify_*, set_drive_file_permissions,
// update_*, manage_drive_access, manage_*_comment, create_table_with_data
const GOOGLE_WORKSPACE_READ_TOOLS = [
  // Drive
  'mcp__google-workspace__search_drive_files',
  'mcp__google-workspace__list_drive_items',
  'mcp__google-workspace__get_drive_file_content',
  'mcp__google-workspace__get_drive_file_download_url',
  'mcp__google-workspace__get_drive_file_permissions',
  'mcp__google-workspace__get_drive_shareable_link',
  'mcp__google-workspace__check_drive_file_public_access',
  // Sheets
  'mcp__google-workspace__get_spreadsheet_info',
  'mcp__google-workspace__read_sheet_values',
  'mcp__google-workspace__list_spreadsheets',
  'mcp__google-workspace__list_spreadsheet_comments',
  // Docs
  'mcp__google-workspace__get_doc_content',
  'mcp__google-workspace__get_doc_as_markdown',
  'mcp__google-workspace__inspect_doc_structure',
  'mcp__google-workspace__list_docs_in_folder',
  'mcp__google-workspace__list_document_comments',
  'mcp__google-workspace__search_docs',
  // Slides
  'mcp__google-workspace__get_presentation',
  'mcp__google-workspace__get_page',
  'mcp__google-workspace__get_page_thumbnail',
  'mcp__google-workspace__list_presentation_comments',
  // Auth (always needed)
  'mcp__google-workspace__start_google_auth',
] as const;

function buildAllowedTools(tools: string[] | undefined): string[] {
  const allowed = [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
  ];
  if (isToolEnabled(tools, 'gmail')) {
    if (isToolScoped(tools, 'gmail')) {
      // Scoped = read-only access (shared group, e.g. Slack with coworkers)
      allowed.push(...GMAIL_READ_TOOLS);
    } else {
      allowed.push('mcp__gmail__*');
      // Also allow additional Gmail account MCP servers (gmail-sunday, gmail-illysium, etc.)
      allowed.push('mcp__gmail-*__*');
    }
  }
  if (isToolEnabled(tools, 'granola')) allowed.push('mcp__granola__*');
  if (isToolEnabled(tools, 'google-workspace')) {
    if (isToolScoped(tools, 'google-workspace')) {
      allowed.push(...GOOGLE_WORKSPACE_READ_TOOLS);
    } else {
      allowed.push('mcp__google-workspace__*');
    }
  }
  if (isToolEnabled(tools, 'calendar')) {
    if (isToolScoped(tools, 'calendar')) {
      allowed.push(...CALENDAR_READ_TOOLS);
    } else {
      allowed.push('mcp__google-calendar__*');
    }
  }
  return allowed;
}

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
      },
    },
  };
  if (isToolEnabled(tools, 'gmail')) {
    // Primary account
    const primaryDir = '/home/node/.gmail-mcp';
    servers.gmail = {
      command: 'gmail-mcp',
      args: [],
      env: {
        GMAIL_OAUTH_PATH: `${primaryDir}/gcp-oauth.keys.json`,
        GMAIL_CREDENTIALS_PATH: `${primaryDir}/credentials.json`,
      },
    };
    // Additional accounts: mount dirs like /home/node/.gmail-mcp-sunday
    try {
      const entries = fs.readdirSync('/home/node');
      for (const entry of entries) {
        if (!entry.startsWith('.gmail-mcp-')) continue;
        const accountName = entry.replace('.gmail-mcp-', '');
        const dir = `/home/node/${entry}`;
        servers[`gmail-${accountName}`] = {
          command: 'gmail-mcp',
          args: [],
          env: {
            GMAIL_OAUTH_PATH: `${dir}/gcp-oauth.keys.json`,
            GMAIL_CREDENTIALS_PATH: `${dir}/credentials.json`,
          },
        };
      }
    } catch {
      // ignore readdir errors
    }
  }
  if (isToolEnabled(tools, 'calendar')) {
    servers['google-calendar'] = {
      command: 'google-calendar-mcp',
      args: [],
      env: {
        GOOGLE_OAUTH_CREDENTIALS: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
        GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/home/node/.config/google-calendar-mcp/tokens.json',
      },
    };
  }
  if (isToolEnabled(tools, 'granola')) {
    const granolaToken = containerInput.secrets?.GRANOLA_ACCESS_TOKEN;
    if (granolaToken) {
      servers.granola = {
        type: 'http',
        url: 'https://mcp.granola.ai/mcp',
        headers: { Authorization: `Bearer ${granolaToken}` },
      };
    }
  }
  if (isToolEnabled(tools, 'google-workspace')) {
    servers['google-workspace'] = {
      command: 'workspace-mcp',
      args: ['--tools', 'drive', 'sheets', 'slides', 'docs'],
      env: {
        GOOGLE_OAUTH_CLIENT_ID:
          containerInput.secrets?.GOOGLE_OAUTH_CLIENT_ID || '',
        GOOGLE_OAUTH_CLIENT_SECRET:
          containerInput.secrets?.GOOGLE_OAUTH_CLIENT_SECRET || '',
        WORKSPACE_MCP_CREDENTIALS_DIR:
          '/home/node/.google_workspace_mcp/credentials',
      },
    };
  }
  return servers;
}

// Supported image MIME types for Claude vision
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

/**
 * Detect actual image MIME type from file magic bytes.
 * Falls back to the provided mimeType if detection fails.
 */
function detectImageMimeType(data: Buffer, declaredMime: string): string {
  if (data.length < 8) return declaredMime;
  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  // WebP: RIFF....WEBP
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
  return declaredMime;
}

/**
 * Build prompt content with interleaved image content blocks.
 * If there are no image attachments, returns the plain text prompt.
 * Otherwise, returns a ContentBlock[] with text and image blocks.
 *
 * Document attachments are referenced as file paths (agent reads with tools).
 */
function buildPromptContent(
  prompt: string,
  attachments?: ContainerAttachment[],
): string | ContentBlock[] {
  if (!attachments || attachments.length === 0) return prompt;

  const blocks: ContentBlock[] = [];
  let hasImageBlocks = false;

  // Start with the text prompt
  blocks.push({ type: 'text', text: prompt });

  for (const att of attachments) {
    if (IMAGE_MIME_TYPES.has(att.mimeType)) {
      // Read file and base64-encode for Claude vision
      try {
        if (!fs.existsSync(att.containerPath)) {
          log(`Attachment file not found: ${att.containerPath}`);
          blocks.push({
            type: 'text',
            text: `[Image attachment "${att.filename}" not available]`,
          });
          continue;
        }
        const data = fs.readFileSync(att.containerPath);
        const actualMime = detectImageMimeType(data, att.mimeType);
        if (actualMime !== att.mimeType) {
          log(`MIME type mismatch: declared=${att.mimeType}, actual=${actualMime} for ${att.filename}`);
        }
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: actualMime,
            data: data.toString('base64'),
          },
        });
        hasImageBlocks = true;
      } catch (err) {
        log(`Failed to read image attachment ${att.containerPath}: ${err}`);
        blocks.push({
          type: 'text',
          text: `[Image attachment "${att.filename}" could not be loaded]`,
        });
      }
    } else {
      // Non-image attachments: reference as file path for agent to read
      blocks.push({
        type: 'text',
        text: `[Attached file "${att.filename}" available at: ${att.containerPath}]`,
      });
    }
  }

  // If no actual image blocks were created, fall back to plain text
  if (!hasImageBlocks) {
    return blocks.map(b => b.type === 'text' ? b.text : '').join('\n');
  }

  return blocks;
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string | ContentBlock[],
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  systemPromptOption: { type: 'preset'; preset: 'claude_code'; append: string } | undefined,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
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
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars)`);
      const content = buildPromptContent(msg.text, msg.attachments);
      stream.push(content);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

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

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: systemPromptOption,
      allowedTools: buildAllowedTools(containerInput.tools),
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: buildMcpServers(containerInput, mcpServerPath),
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName, containerInput.threadId)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
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
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
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

  // Set model for this container run (per-message flag > session sticky > per-group > global default)
  if (containerInput.model) {
    sdkEnv['CLAUDE_CODE_USE_MODEL'] = containerInput.model;
    log(`Using model: ${containerInput.model}`);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Build systemPrompt once — chatJid and global CLAUDE.md are invariant for the container lifetime.
  // channelFormatting is placed AFTER globalClaudeMd so it overrides the WA/Telegram formatting
  // rule in global CLAUDE.md for Slack/Discord groups. This also ensures globalContext:false groups
  // (no /workspace/global mount) still receive channel-appropriate formatting guidance.
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  const globalClaudeMd = !containerInput.isMain && fs.existsSync(globalClaudeMdPath)
    ? fs.readFileSync(globalClaudeMdPath, 'utf-8')
    : undefined;
  const channelFormatting = getChannelFormattingInstructions(containerInput.chatJid);
  // Inject model identity so the agent can report it accurately
  const modelNote = containerInput.model
    ? `You are running on model: ${containerInput.model}. If the user asks what model you are using, report this accurately.`
    : undefined;
  const systemPromptParts = [globalClaudeMd, channelFormatting, modelNote].filter(Boolean);
  const systemPromptOption = systemPromptParts.length > 0
    ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptParts.join('\n\n') }
    : undefined;

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

  // Build initial prompt content with attachments (images → base64 content blocks)
  let prompt: string | ContentBlock[] = buildPromptContent(
    promptText,
    allAttachments.length > 0 ? allAttachments : undefined,
  );

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, systemPromptOption, resumeAt);
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
