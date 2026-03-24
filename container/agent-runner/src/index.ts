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
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ImageAttachment {
  data: string;  // base64
  mediaType: string; // e.g. "image/png"
  name?: string;
}

interface ContainerInput {
  prompt: string;
  images?: ImageAttachment[];
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  debugQuery?: {
    id: string;
    question: string;
  };
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

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

const GOAL_SYSTEM_PROMPT = `
You are working on an autonomous goal. Work independently to completion.

- Break the goal into subtasks and use agent teams to parallelize when beneficial
- For simple goals, just do the work directly without decomposition overhead
- If you encounter a blocker you cannot resolve, report it via send_message and continue with other subtasks
- If the user requested progress updates, use send_message at the requested interval
- When complete, send final results via send_message
- Do not ask clarifying questions unless truly stuck — make reasonable decisions and proceed
`.trim();

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_PAUSE_SENTINEL = path.join(IPC_INPUT_DIR, '_pause');
const IPC_INPUT_RESUME_SENTINEL = path.join(IPC_INPUT_DIR, '_resume');
const IPC_POLL_MS = 500;
const IPC_PAUSE_POLL_MS = 5000;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: ImageAttachment[]): boolean {
    if (this.done) return false;
    let content: string | ContentBlock[];
    if (images && images.length > 0) {
      content = [
        { type: 'text', text },
        ...images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
        })),
      ];
    } else {
      content = text;
    }
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
    return true;
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

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function writeIpcStatus(status: 'paused' | 'resumed'): void {
  const queueDir = '/workspace/ipc/queue';
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(queueDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: status, timestamp: new Date().toISOString() }));
    fs.renameSync(tempPath, filepath);
    log(`Wrote IPC status: ${status}`);
  } catch (err) {
    log(`Failed to write IPC status: ${err instanceof Error ? err.message : String(err)}`);
  }
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
 * Extract structured knowledge from parsed conversation messages.
 */
function extractKnowledge(messages: ParsedMessage[]): {
  topics: string[];
  people: string[];
  decisions: string[];
  actionItems: string[];
  briefSummary: string;
  keyPoints: string[];
} {
  const allText = messages.map(m => m.content).join('\n');

  // Extract people: @mentions and capitalized names (2+ words like "John Smith")
  const peopleSet = new Set<string>();
  const mentionMatches = allText.match(/@[\w]+/g);
  if (mentionMatches) {
    for (const m of mentionMatches) peopleSet.add(m);
  }
  const nameMatches = allText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g);
  if (nameMatches) {
    // Filter out common non-name phrases
    const ignore = new Set(['Key Points', 'Action Items', 'Summary', 'TODO', 'Let Us', 'Read Only']);
    for (const n of nameMatches) {
      if (!ignore.has(n) && n.length < 40) peopleSet.add(n);
    }
  }

  // Extract decisions
  const decisions: string[] = [];
  const decisionPatterns = [
    /(?:decided|agreed|let'?s go with|will use|going with|chose|chosen|we'll use|settled on)\s+(.{5,80}?)(?:\.|$)/gi,
  ];
  for (const pattern of decisionPatterns) {
    let match;
    while ((match = pattern.exec(allText)) !== null) {
      const decision = match[0].trim().replace(/\.$/, '');
      if (decision.length > 10) decisions.push(decision);
    }
  }

  // Extract action items
  const actionItems: string[] = [];
  const actionPatterns = [
    /(?:TODO|FIXME|HACK)[\s:]+(.{5,100}?)(?:\n|$)/gi,
    /(?:need to|should|will do|action item[\s:]*|must)\s+(.{5,100}?)(?:\.|$)/gi,
  ];
  for (const pattern of actionPatterns) {
    let match;
    while ((match = pattern.exec(allText)) !== null) {
      const item = match[1]?.trim() || match[0].trim();
      if (item.length > 5) actionItems.push(item.replace(/\.$/, ''));
    }
  }

  // Extract topics from first user message keywords + summary context
  const firstUserMsg = messages.find(m => m.role === 'user')?.content || '';
  const topicWords = firstUserMsg
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !['this', 'that', 'with', 'from', 'have', 'been', 'will', 'what', 'when', 'where', 'your', 'about', 'please', 'could', 'would', 'should', 'there', 'their', 'which', 'these', 'those', 'them', 'they', 'some', 'into', 'just', 'also', 'than', 'then', 'here', 'very', 'after', 'before', 'other', 'more', 'much', 'each', 'make', 'like', 'know', 'take', 'come', 'want', 'does', 'help'].includes(w));
  // Deduplicate and take top 5
  const topics = [...new Set(topicWords)].slice(0, 5);

  // Brief summary: first user message, truncated
  const briefSummary = firstUserMsg.length > 200
    ? firstUserMsg.slice(0, 200).trim() + '...'
    : firstUserMsg;

  // Key points: extract from assistant messages (first sentence of each, up to 5)
  const keyPoints = messages
    .filter(m => m.role === 'assistant')
    .map(m => {
      const firstSentence = m.content.match(/^[^.!?\n]{10,150}[.!?]?/);
      return firstSentence ? firstSentence[0].trim() : '';
    })
    .filter(s => s.length > 10)
    .slice(0, 5);

  return {
    topics,
    people: [...peopleSet],
    decisions: [...new Set(decisions)].slice(0, 10),
    actionItems: [...new Set(actionItems)].slice(0, 10),
    briefSummary,
    keyPoints,
  };
}

function escapeYamlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function formatYamlArray(arr: string[]): string {
  if (arr.length === 0) return '[]';
  return '[' + arr.map(escapeYamlString).join(', ') + ']';
}

/**
 * Generate a structured summary markdown file with YAML frontmatter.
 */
function generateStructuredSummary(
  messages: ParsedMessage[],
  title: string | null,
  date: string,
  transcriptFilename: string,
): string {
  const knowledge = extractKnowledge(messages);

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${escapeYamlString(title || 'Conversation')}`);
  lines.push(`date: ${date}`);
  lines.push(`topics: ${formatYamlArray(knowledge.topics)}`);
  lines.push(`people: ${formatYamlArray(knowledge.people)}`);
  lines.push(`decisions: ${formatYamlArray(knowledge.decisions)}`);
  lines.push(`action_items: ${formatYamlArray(knowledge.actionItems)}`);
  lines.push('related_knowledge: []');
  lines.push(`transcript: "[[../${transcriptFilename}]]"`);
  lines.push('---');
  lines.push('');
  lines.push('# Summary');
  lines.push('');
  lines.push(knowledge.briefSummary || 'No summary available.');
  lines.push('');

  if (knowledge.keyPoints.length > 0) {
    lines.push('## Key Points');
    lines.push('');
    for (const point of knowledge.keyPoints) {
      lines.push(`- ${point}`);
    }
    lines.push('');
  }

  if (knowledge.decisions.length > 0) {
    lines.push('## Decisions Made');
    lines.push('');
    for (const decision of knowledge.decisions) {
      lines.push(`- ${decision}`);
    }
    lines.push('');
  }

  if (knowledge.actionItems.length > 0) {
    lines.push('## Action Items');
    lines.push('');
    for (const item of knowledge.actionItems) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n');
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

      // Generate structured summary
      try {
        const summariesDir = path.join(conversationsDir, '_summaries');
        fs.mkdirSync(summariesDir, { recursive: true });

        const summaryContent = generateStructuredSummary(messages, summary, date, filename);
        const summaryPath = path.join(summariesDir, filename);
        fs.writeFileSync(summaryPath, summaryContent);
        log(`Wrote structured summary to ${summaryPath}`);
      } catch (summaryErr) {
        log(`Failed to write structured summary: ${summaryErr instanceof Error ? summaryErr.message : String(summaryErr)}`);
      }
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
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
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
 * Check for _pause sentinel. If found, enter pause loop.
 * Returns true if close was requested during pause.
 */
async function checkAndHandlePause(): Promise<boolean> {
  if (!fs.existsSync(IPC_INPUT_PAUSE_SENTINEL)) return false;

  try { fs.unlinkSync(IPC_INPUT_PAUSE_SENTINEL); } catch { /* ignore */ }
  log('Pause sentinel detected, entering pause mode');
  writeIpcStatus('paused');

  // Sleep loop until _resume or _close
  while (true) {
    await new Promise(resolve => setTimeout(resolve, IPC_PAUSE_POLL_MS));

    if (shouldClose()) {
      log('Close sentinel during pause, exiting');
      return true;
    }

    if (fs.existsSync(IPC_INPUT_RESUME_SENTINEL)) {
      try { fs.unlinkSync(IPC_INPUT_RESUME_SENTINEL); } catch { /* ignore */ }
      log('Resume sentinel detected, resuming');
      writeIpcStatus('resumed');
      return false;
    }
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = async () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      // Check for pause sentinel between turns
      const closedDuringPause = await checkAndHandlePause();
      if (closedDuringPause) {
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
  images: ImageAttachment[] | undefined,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; leftoverMessages: string[] }> {
  const stream = new MessageStream();
  stream.push(prompt, images);

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
      if (!stream.push(text)) {
        log('Stream ended, stopping IPC poll');
        ipcPolling = false;
        return;
      }
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
      systemPrompt: (() => {
        const isGoal = process.env.CONTAINER_PRIORITY === 'goal';
        const appendText = [globalClaudeMd, isGoal ? GOAL_SYSTEM_PROMPT : ''].filter(Boolean).join('\n\n') || undefined;
        return appendText
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: appendText }
          : undefined;
      })(),
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
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant') {
      const msg = message as any;
      // SDK assistant messages may use 'content' (raw API) or 'message.content' (wrapped)
      const content = msg.content ?? msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const inputStr = JSON.stringify(block.input).slice(0, 300);
            log(`[tool] ${block.name} ${inputStr}`);
          }
        }
      }
    }

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
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  stream.end(); // Prevent late IPC poll from pushing into the dead SDK transport

  // Drain any IPC messages that arrived after the SDK finished but before
  // we stopped polling. Without this, messages consumed by pollIpcDuringQuery
  // (pushed into the now-dead stream) or sitting on disk would be lost until
  // the next user message triggers waitForIpcMessage.
  const leftover = drainIpcInput();
  if (leftover.length > 0) {
    log(`Recovered ${leftover.length} IPC message(s) after query ended`);
  }

  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, leftoverMessages: leftover };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
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

  // Prevent EPIPE from crashing the process when SDK subprocess exits.
  // The SDK spawns a CLI subprocess; if it dies mid-write, the stdin pipe
  // emits an unhandled 'error' event that would otherwise crash Node.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('uncaughtException', (err) => {
    if ('code' in err && (err as NodeJS.ErrnoException).code === 'EPIPE') {
      log('Caught EPIPE — SDK subprocess exited, continuing');
      return; // Swallow EPIPE, let the query catch block handle the error
    }
    if (err.message?.includes('ProcessTransport is not ready')) {
      log('Caught ProcessTransport error — SDK subprocess exited, continuing');
      return; // Same root cause as EPIPE — transport dead after subprocess exit
    }
    // Re-throw non-EPIPE errors
    throw err;
  });

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

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

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  // Images are only sent with the first query, not follow-ups
  let initialImages = containerInput.images;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      let queryResult: Awaited<ReturnType<typeof runQuery>>;
      try {
        queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, initialImages, sdkEnv, resumeAt);
      } catch (queryErr) {
        const msg = queryErr instanceof Error ? queryErr.message : String(queryErr);
        const isStaleSession = msg.includes('No conversation found with session ID');
        const isProcessCrash = msg.includes('exited with code') || msg.includes('EPIPE');
        if ((isStaleSession || isProcessCrash) && sessionId) {
          log(`Session error (${isStaleSession ? 'stale' : 'crash'}) — retrying with fresh session`);
          sessionId = undefined;
          resumeAt = undefined;
          initialImages = containerInput.images; // Re-include images on retry
          queryResult = await runQuery(prompt, undefined, mcpServerPath, containerInput, initialImages, sdkEnv, undefined);
        } else {
          throw queryErr;
        }
      }

      // Clear images after first query — don't resend on follow-ups
      initialImages = undefined;

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

      // Use leftover messages from the query if any were consumed but not processed
      let nextMessage: string | null;
      if (queryResult.leftoverMessages.length > 0) {
        nextMessage = queryResult.leftoverMessages.join('\n');
        log(`Using ${queryResult.leftoverMessages.length} leftover message(s) from previous query`);
      } else {
        log('Query ended, waiting for next IPC message...');
        // Wait for the next message or _close sentinel
        nextMessage = await waitForIpcMessage();
      }

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
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
