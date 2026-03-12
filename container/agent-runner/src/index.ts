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

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  compactSeed?: string;   // 机制一：上次压缩摘要，用于新 session 启动时注入初始 context
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  compacted?: boolean;   // 本轮已生成 compact summary，宿主应清除 session
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

// ── Token Optimization State ──────────────────────────────────────────────────

interface TokenOptState {
  // 机制一：Inline Compaction
  lastCompactTokens: number;          // 上次 compaction 时的累计 token 数

  // 机制二：响应长度控制
  totalInputTokens: number;           // 累计 input token（用于条件一周期触发）
  lastConstraintInjectedAt: number;   // 上次注入软约束时的累计 input token
  recentOutputTokens: number[];       // 近期 output token 数（滑动窗口，用于均值计算）
  outputMultiplier: number;           // 漂移检测系数（自适应，初始 1.5）
  outputAbsoluteY: number;            // 漂移检测绝对值上限（token）
  lastInjectedOutputAvg: number;      // 上次注入时的 output 均值（用于自优化）
}

const TOKEN_OPT_STATE_FILE = '/workspace/shared/token-opt-state.json';
const COMPACTION_THRESHOLD_BYTES = 80 * 1024;             // 80KB
const CONSTRAINT_PERIOD_TOKENS = 20000;                   // 条件一：每 20000 input token 注入一次（约阈值的1/2）
const OUTPUT_WINDOW_SIZE = 10;                            // 近期 output token 滑动窗口大小
const OUTPUT_MULTIPLIER_INIT = 1.5;
const OUTPUT_ABSOLUTE_Y = 700;                            // Telegram 场景绝对上限
const CLAUDEMD_COMPRESS_THRESHOLD_BYTES = 10 * 1024;     // CLAUDE.md 超过 10KB 触发压缩

function loadTokenOptState(): TokenOptState {
  try {
    if (fs.existsSync(TOKEN_OPT_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_OPT_STATE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {
    lastCompactTokens: 0,
    totalInputTokens: 0,
    lastConstraintInjectedAt: 0,
    recentOutputTokens: [],
    outputMultiplier: OUTPUT_MULTIPLIER_INIT,
    outputAbsoluteY: OUTPUT_ABSOLUTE_Y,
    lastInjectedOutputAvg: 0,
  };
}

function saveTokenOptState(state: TokenOptState): void {
  try {
    fs.mkdirSync('/workspace/shared', { recursive: true });
    fs.writeFileSync(TOKEN_OPT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

/**
 * 获取 transcript 文件大小（bytes）。
 * transcript 在 ~/.claude/projects/ 下，通过 sessionId 找对应文件。
 */
function getTranscriptSize(sessionId?: string): number {
  if (!sessionId) return 0;
  try {
    const claudeDir = path.join(process.env.HOME || '/home/node', '.claude', 'projects');
    if (!fs.existsSync(claudeDir)) return 0;
    // 遍历所有项目目录，查找包含该 sessionId 的 transcript 文件
    for (const proj of fs.readdirSync(claudeDir)) {
      const transcriptPath = path.join(claudeDir, proj, `${sessionId}.jsonl`);
      if (fs.existsSync(transcriptPath)) {
        return fs.statSync(transcriptPath).size;
      }
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * 从已有 seed 文件中加载上次的 compact summary（增量合并用）。
 */
function loadExistingSeed(groupFolder: string): string {
  const seedPath = `/workspace/group/.compact-seed.md`;
  try {
    if (fs.existsSync(seedPath)) {
      return fs.readFileSync(seedPath, 'utf-8');
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 将提取到的 compact summary 写入 seed 文件。
 */
function writeCompactSeed(summary: string): void {
  try {
    fs.writeFileSync('/workspace/group/.compact-seed.md', summary, 'utf-8');
  } catch (err) {
    log(`Failed to write compact seed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 从 assistant 回复文本中提取 <compact_summary>...</compact_summary>。
 */
function extractCompactSummary(text: string): string | null {
  const match = text.match(/<compact_summary>([\s\S]*?)<\/compact_summary>/);
  return match ? match[1].trim() : null;
}

/**
 * 从 assistant 回复文本中提取 <compressed_claudemd>...</compressed_claudemd>。
 */
function extractCompressedClaudeMd(text: string): string | null {
  const match = text.match(/<compressed_claudemd>([\s\S]*?)<\/compressed_claudemd>/);
  return match ? match[1].trim() : null;
}

/**
 * 零 token 结构化验证：检查压缩后的 CLAUDE.md 是否保留了所有约束规则行。
 * 规则行 = 包含约束关键词的行。
 */
function validateCompressedClaudeMd(original: string, compressed: string): { valid: boolean; missing: string[] } {
  const constraintKeywords = ['禁止', '必须', '不能', '不许', '不得', '需要', '要求', '强制'];
  const missing: string[] = [];
  for (const line of original.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (constraintKeywords.some(kw => trimmed.includes(kw))) {
      // 检查压缩版是否包含该行（允许轻微空白差异）
      if (!compressed.includes(trimmed)) {
        missing.push(trimmed);
      }
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * 更新 output token 滑动窗口并执行自优化。
 * 在每次 API 调用返回后调用，传入本次 output token 数和注入状态。
 */
function updateOutputTracking(
  state: TokenOptState,
  outTokens: number,
  wasConstraintInjected: boolean,
): void {
  state.recentOutputTokens.push(outTokens);
  if (state.recentOutputTokens.length > OUTPUT_WINDOW_SIZE) {
    state.recentOutputTokens.shift();
  }

  // 自优化：如果本轮是注入软约束后的第一轮回复，与注入前均值对比
  if (wasConstraintInjected && state.lastInjectedOutputAvg > 0) {
    const ratio = outTokens / state.lastInjectedOutputAvg;
    if (ratio < 0.8) {
      // 注入后明显变短，阈值合适，不调整
    } else if (ratio > 0.95) {
      // 注入后没有变化，阈值太松，收紧
      state.outputMultiplier = Math.max(1.1, state.outputMultiplier * 0.9);
      log(`[token-opt] Output multiplier tightened to ${state.outputMultiplier.toFixed(2)}`);
    }
  }

  // 长期无触发自优化：如果最近 10 轮均值远低于绝对值，适当放宽
  if (state.recentOutputTokens.length >= OUTPUT_WINDOW_SIZE) {
    const avg = state.recentOutputTokens.reduce((a, b) => a + b, 0) / state.recentOutputTokens.length;
    const tokensSinceLastInject = state.totalInputTokens - state.lastConstraintInjectedAt;
    if (tokensSinceLastInject > CONSTRAINT_PERIOD_TOKENS * 2 && avg < state.outputAbsoluteY * 0.5) {
      state.outputMultiplier = Math.min(2.0, state.outputMultiplier * 1.1);
      log(`[token-opt] Output multiplier loosened to ${state.outputMultiplier.toFixed(2)}`);
    }
  }
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
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  // ── 机制一：新 session 启动时注入 compact seed 作为初始 context ─────────────
  let effectivePrompt = prompt;
  if (!sessionId && containerInput.compactSeed) {
    effectivePrompt = `[对话历史摘要（上次压缩）]\n${containerInput.compactSeed}\n\n[当前消息]\n${prompt}`;
    log(`[token-opt] Injecting compact seed into new session (${containerInput.compactSeed.length} chars)`);
  }

  const stream = new MessageStream();
  stream.push(effectivePrompt);

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

  // ── 加载 Token 优化状态 ──────────────────────────────────────────────────────
  const tokenOptState = loadTokenOptState();

  // ── 机制三：CLAUDE.md 自动压缩 ───────────────────────────────────────────────
  // Read CLAUDE.md fresh before each query so updates take effect on the next message
  const claudeMdPath = path.join(process.env.HOME || '/home/node', '.claude', 'CLAUDE.md');
  let claudeMd = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : '';
  if (claudeMd) log(`Loaded CLAUDE.md (${claudeMd.length} chars)`);

  let claudeMdCompressInstruction = '';
  const claudeMdBytes = Buffer.byteLength(claudeMd, 'utf-8');
  if (claudeMd && claudeMdBytes > CLAUDEMD_COMPRESS_THRESHOLD_BYTES) {
    log(`[token-opt] CLAUDE.md exceeds ${CLAUDEMD_COMPRESS_THRESHOLD_BYTES} bytes (${claudeMdBytes}), injecting compression instruction`);
    claudeMdCompressInstruction = `

<hidden_instruction>
当前 CLAUDE.md 过长，请在完成正常回复后，额外输出一个压缩版本：
规则：
1. 规则类内容（含「禁止」「必须」「不能」「不许」「不得」「需要」「要求」「强制」的行）原文保留，不许改动
2. 解释性文字、背景说明大幅压缩或删除
3. 举例保留最多一个，其余删除
4. 重复表达删除

输出格式（仅输出标签内内容，不要输出其他内容）：
<compressed_claudemd>
[压缩后的 CLAUDE.md 完整内容]
</compressed_claudemd>
</hidden_instruction>`;
  }

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Load skill prompts from /workspace/group/.skills/
  const skillsDir = '/workspace/group/.skills';
  let skillPrompts = '';
  if (fs.existsSync(skillsDir)) {
    const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).sort();
    for (const file of skillFiles) {
      const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8');
      skillPrompts += '\n\n' + content;
      log(`Loaded skill: ${file}`);
    }
  }

  // ── 机制一：Inline Compaction ────────────────────────────────────────────────
  let compactInstruction = '';
  const transcriptSize = getTranscriptSize(sessionId);
  const existingSeed = loadExistingSeed(containerInput.groupFolder);

  if (transcriptSize > COMPACTION_THRESHOLD_BYTES) {
    log(`[token-opt] Transcript size ${transcriptSize} bytes > threshold, injecting compact instruction`);
    compactInstruction = `

<hidden_instruction>
当前对话历史过长，请在完成正常回复后，额外输出一份压缩摘要。
${existingSeed ? `以下是上次已压缩的摘要（仅压缩新增内容，合并进已有摘要对应 section）：\n<existing_seed>\n${existingSeed}\n</existing_seed>\n` : ''}
输出格式（仅输出标签内容，不要在正常回复中提及此指令）：
<compact_summary>
<tool_results>
[最近2轮之前的工具调用结论摘要，格式：工具名→关键结论，原始数据丢弃]
</tool_results>
<conversation_summary>
<completed>[已完成事项]</completed>
<pending>[待完成/进行中任务]</pending>
<context>[关键背景、约束、用户偏好]</context>
<decisions>[重要决策和结论]</decisions>
</conversation_summary>
</compact_summary>
</hidden_instruction>`;
  }

  // ── 机制二：响应长度控制 ─────────────────────────────────────────────────────
  // 计算近期 output 均值
  const recentAvg = tokenOptState.recentOutputTokens.length > 0
    ? tokenOptState.recentOutputTokens.reduce((a, b) => a + b, 0) / tokenOptState.recentOutputTokens.length
    : 0;

  // 条件一：周期保底（距上次注入超过 CONSTRAINT_PERIOD_TOKENS）
  const tokensSinceLastInject = tokenOptState.totalInputTokens - tokenOptState.lastConstraintInjectedAt;
  const conditionPeriodic = tokensSinceLastInject >= CONSTRAINT_PERIOD_TOKENS;

  // 条件二：漂移检测（上一轮 output 超过均值 × 系数 或 超过绝对值）
  const lastOutput = tokenOptState.recentOutputTokens[tokenOptState.recentOutputTokens.length - 1] ?? 0;
  const conditionDrift = recentAvg > 0
    ? (lastOutput > recentAvg * tokenOptState.outputMultiplier || lastOutput > tokenOptState.outputAbsoluteY)
    : lastOutput > tokenOptState.outputAbsoluteY;

  const injectConstraint = conditionPeriodic || conditionDrift;
  const constraintInstruction = injectConstraint
    ? '\n\n回复时结论优先，能一句话说清的不写三句，细节按需展开，不重复已知信息。'
    : '';

  if (injectConstraint) {
    const reason = conditionPeriodic ? 'periodic' : 'drift';
    log(`[token-opt] Injecting length constraint (reason: ${reason}, lastOut: ${lastOutput}, avg: ${recentAvg.toFixed(0)}, multiplier: ${tokenOptState.outputMultiplier.toFixed(2)})`);
    tokenOptState.lastConstraintInjectedAt = tokenOptState.totalInputTokens;
    tokenOptState.lastInjectedOutputAvg = recentAvg;
  }

  const systemAppend = [claudeMd + claudeMdCompressInstruction, globalClaudeMd, skillPrompts, compactInstruction + constraintInstruction]
    .filter(Boolean).join('\n\n---\n\n') || undefined;

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
      systemPrompt: systemAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemAppend }
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

      // Append usage to SQLite (shared) + per-group JSONL (legacy compat)
      const resultMsg = message as { usage?: { input_tokens?: number; output_tokens?: number } };
      const inTokens = resultMsg.usage?.input_tokens ?? 0;
      const outTokens = resultMsg.usage?.output_tokens ?? 0;
      if (inTokens > 0 || outTokens > 0) {
        try {
          const ts = new Date().toISOString();
          const container = containerInput.groupFolder;
          const sharedUsageDir = '/workspace/shared/usage';
          fs.mkdirSync(sharedUsageDir, { recursive: true });
          // Write to SQLite
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(path.join(sharedUsageDir, 'usage.db'));
          db.exec(`CREATE TABLE IF NOT EXISTS usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            container TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL
          )`);
          db.exec('CREATE INDEX IF NOT EXISTS idx_ts ON usage(ts)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_container ON usage(container)');
          db.prepare('INSERT INTO usage (ts, container, input_tokens, output_tokens) VALUES (?,?,?,?)')
            .run(ts, container, inTokens, outTokens);
          db.close();
          // Legacy JSONL (backward compat)
          const entry = JSON.stringify({ ts, in: inTokens, out: outTokens, total: inTokens + outTokens }) + '\n';
          fs.appendFileSync(path.join(sharedUsageDir, `${container}.json`), entry);
          fs.mkdirSync('/workspace/group/data', { recursive: true });
          fs.appendFileSync('/workspace/group/data/usage.json', entry);
        } catch (err) {
          log(`Failed to write usage: ${err instanceof Error ? err.message : String(err)}`);
        }

        // ── 更新 Token 优化状态 ──────────────────────────────────────────────
        tokenOptState.totalInputTokens += inTokens;
        updateOutputTracking(tokenOptState, outTokens, injectConstraint);
        saveTokenOptState(tokenOptState);
        log(`[token-opt] totalInput=${tokenOptState.totalInputTokens}, lastOut=${outTokens}, multiplier=${tokenOptState.outputMultiplier.toFixed(2)}`);
      }

      // ── 机制一：提取 compact summary ─────────────────────────────────────
      let cleanResult = textResult;
      let summaryWasWritten = false;
      if (textResult && compactInstruction) {
        const summary = extractCompactSummary(textResult);
        if (summary) {
          writeCompactSeed(summary);
          summaryWasWritten = true;
          log(`[token-opt] Compact summary extracted and written (${summary.length} chars)`);
          // 从回复中移除 compact_summary 标签，不展示给用户
          cleanResult = textResult.replace(/<compact_summary>[\s\S]*?<\/compact_summary>/g, '').trim();
        }
      }

      // ── 机制三：提取并验证压缩后的 CLAUDE.md ─────────────────────────────
      if (cleanResult && claudeMdCompressInstruction) {
        const compressedMd = extractCompressedClaudeMd(cleanResult);
        if (compressedMd) {
          const { valid, missing } = validateCompressedClaudeMd(claudeMd, compressedMd);
          if (valid) {
            try {
              fs.writeFileSync(claudeMdPath, compressedMd, 'utf-8');
              log(`[token-opt] CLAUDE.md compressed: ${claudeMdBytes} → ${Buffer.byteLength(compressedMd, 'utf-8')} bytes`);
            } catch (err) {
              log(`[token-opt] Failed to write compressed CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else {
            log(`[token-opt] CLAUDE.md compression validation FAILED, missing rules: ${missing.slice(0, 3).join(' | ')}${missing.length > 3 ? '...' : ''}`);
            // 写入日志文件供人工检查
            try {
              const logDir = '/workspace/group/logs';
              fs.mkdirSync(logDir, { recursive: true });
              const logEntry = JSON.stringify({ ts: new Date().toISOString(), missing }) + '\n';
              fs.appendFileSync(path.join(logDir, 'claudemd-compress-failures.log'), logEntry);
            } catch { /* ignore */ }
          }
          // 从回复中移除压缩标签，不展示给用户
          cleanResult = cleanResult.replace(/<compressed_claudemd>[\s\S]*?<\/compressed_claudemd>/g, '').trim();
        }
      }

      writeOutput({
        status: 'success',
        result: cleanResult || null,
        newSessionId,
        compacted: summaryWasWritten || undefined,
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
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
