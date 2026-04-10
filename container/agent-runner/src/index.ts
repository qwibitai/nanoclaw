/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * using OpenRouter chat completions directly.
 */

import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SessionState {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            type?: string;
            text?: string;
          }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

const REQUESTED_MODEL = process.env.NANOCLAW_MODEL;
const OPENROUTER_API_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const GROUP_DIR = '/workspace/group';
const GLOBAL_DIR = '/workspace/global';
const SESSIONS_DIR = path.join(GROUP_DIR, '.nanoclaw-sessions');
const CONVERSATIONS_DIR = path.join(GROUP_DIR, 'conversations');
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
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function resolveOpenRouterApiUrl(): string {
  const explicit = process.env.OPENROUTER_API_URL || process.env.OPENROUTER_BASE_URL;
  if (explicit) return explicit;

  const anthropicCompat = process.env.ANTHROPIC_BASE_URL;
  if (anthropicCompat?.includes('/anthropic')) {
    return anthropicCompat.replace(/\/anthropic\/?$/, '/chat/completions');
  }
  if (anthropicCompat?.endsWith('/api/v1')) {
    return `${anthropicCompat}/chat/completions`;
  }

  return 'https://openrouter.ai/api/v1/chat/completions';
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sessionPath(sessionId: string): string {
  ensureDir(SESSIONS_DIR);
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function loadSession(sessionId?: string): SessionState | null {
  if (!sessionId) return null;
  const filePath = sessionPath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionState;
  } catch (err) {
    log(`Failed to load session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function saveSession(session: SessionState): void {
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

function readOptionalFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function appendMemoryFile(
  parts: string[],
  label: string,
  baseDir: string,
  filename: string,
): void {
  const content = readOptionalFile(path.join(baseDir, filename));
  if (!content) return;
  parts.push(`${label} (${filename}):`);
  parts.push(content);
}

function buildSystemPrompt(containerInput: ContainerInput): string {
  const parts = [
    `You are ${containerInput.assistantName || 'Andy'}, the NanoClaw assistant replying inside a chat.`,
    'Be concise, direct, and helpful.',
    'If the user asks for code or debugging help, focus on actionable technical guidance.',
    'Do not claim to have completed actions you did not actually complete.',
  ];

  const groupMemory = readOptionalFile(path.join(GROUP_DIR, 'CLAUDE.md'));
  const globalMemory = readOptionalFile(path.join(GLOBAL_DIR, 'CLAUDE.md'));

  if (globalMemory) {
    parts.push('Global memory/context:');
    parts.push(globalMemory);
  }
  if (groupMemory) {
    parts.push('Group-specific memory/context:');
    parts.push(groupMemory);
  }

  appendMemoryFile(parts, 'Global personality memory', GLOBAL_DIR, 'soul.md');
  appendMemoryFile(parts, 'Global user context', GLOBAL_DIR, 'user.md');
  appendMemoryFile(parts, 'Global heartbeat/status context', GLOBAL_DIR, 'heartbeat.md');
  appendMemoryFile(parts, 'Group personality memory', GROUP_DIR, 'soul.md');
  appendMemoryFile(parts, 'Group user context', GROUP_DIR, 'user.md');
  appendMemoryFile(parts, 'Group heartbeat/status context', GROUP_DIR, 'heartbeat.md');

  return parts.join('\n\n');
}

function toMarkdownTitle(messages: ConversationMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user')?.content;
  if (!firstUser) return 'Conversation';
  return firstUser.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversation';
}

function archiveConversation(session: SessionState, assistantName?: string): void {
  const visibleMessages = session.messages.filter((message) => message.role !== 'system');
  if (visibleMessages.length === 0) return;

  ensureDir(CONVERSATIONS_DIR);
  const date = new Date().toISOString().split('T')[0];
  const title = toMarkdownTitle(visibleMessages)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'conversation';
  const filePath = path.join(CONVERSATIONS_DIR, `${date}-${title}.md`);

  const lines = [`# ${toMarkdownTitle(visibleMessages)}`, '', `Archived: ${new Date().toISOString()}`, '', '---', ''];
  for (const message of visibleMessages) {
    const sender =
      message.role === 'assistant' ? assistantName || 'Assistant' : 'User';
    lines.push(`**${sender}**: ${message.content}`);
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'));
}

function shouldClose(): boolean {
  if (!fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) return false;
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
  return true;
}

function drainIpcInput(): string[] {
  try {
    ensureDir(IPC_INPUT_DIR);
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          type?: string;
          text?: string;
        };
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
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

function extractResponseText(payload: OpenRouterResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' ? part.text || '' : ''))
      .join('')
      .trim();
  }
  const errorMessage = payload.error?.message?.trim();
  if (errorMessage) {
    throw new Error(errorMessage);
  }
  throw new Error('OpenRouter returned no response text');
}

async function queryOpenRouter(
  session: SessionState,
  containerInput: ContainerInput,
): Promise<string> {
  if (!REQUESTED_MODEL) {
    throw new Error('NANOCLAW_MODEL is not configured');
  }
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key is not configured');
  }

  const response = await fetch(resolveOpenRouterApiUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/BrianTruong23/nanoclaw',
      'X-Title': 'NanoClaw',
    },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      messages: session.messages,
      temperature: 0.2,
    }),
  });

  const text = await response.text();
  let payload: OpenRouterResponse;
  try {
    payload = JSON.parse(text) as OpenRouterResponse;
  } catch {
    throw new Error(`OpenRouter returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      payload.error?.message?.trim() ||
        `OpenRouter request failed with status ${response.status}`,
    );
  }

  const result = extractResponseText(payload);
  if (!result) {
    throw new Error('OpenRouter returned an empty response');
  }

  log(`OpenRouter reply received (${result.length} chars) for ${containerInput.groupFolder}`);
  return result;
}

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
          resolve(null);
          return;
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(lastLine) as ScriptResult;
          if (typeof result.wakeAgent !== 'boolean') {
            log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            resolve(null);
            return;
          }
          resolve(result);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function runTurn(
  prompt: string,
  session: SessionState,
  containerInput: ContainerInput,
): Promise<string> {
  session.messages.push({ role: 'user', content: prompt });
  const reply = await queryOpenRouter(session, containerInput);
  session.messages.push({ role: 'assistant', content: reply });
  saveSession(session);
  return reply;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* ignore */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  ensureDir(IPC_INPUT_DIR);
  ensureDir(SESSIONS_DIR);

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let session =
    loadSession(containerInput.sessionId) || {
      id: containerInput.sessionId || randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          role: 'system',
          content: buildSystemPrompt(containerInput),
        },
      ],
    };

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: session.id,
      });
      return;
    }
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  try {
    while (true) {
      log(`Starting OpenRouter turn for session ${session.id}`);
      const reply = await runTurn(prompt, session, containerInput);
      writeOutput({
        status: 'success',
        result: reply,
        newSessionId: session.id,
      });

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, archiving conversation and exiting');
        archiveConversation(session, containerInput.assistantName);
        break;
      }

      prompt = nextMessage;
      log(`Received follow-up IPC message (${prompt.length} chars)`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session.id,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
