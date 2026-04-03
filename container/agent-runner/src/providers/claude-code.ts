import fs from 'fs';
import path from 'path';

import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentEvent,
  ContainerAgentProvider,
  ProviderRuntimeInput,
} from '../provider-types.js';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const WORKSPACE_GROUP_DIR =
  process.env.NANOCLAW_WORKSPACE_GROUP_DIR || '/workspace/group';
const WORKSPACE_GLOBAL_DIR =
  process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR || '/workspace/global';
const WORKSPACE_EXTRA_DIR =
  process.env.NANOCLAW_WORKSPACE_EXTRA_DIR || '/workspace/extra';

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
      if (this.done) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
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
    const entry = index.entries.find((item) => item.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (error) {
    log(
      `Failed to read sessions index: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input: unknown) => {
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

      const conversationsDir = path.join(WORKSPACE_GROUP_DIR, 'conversations');
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
    } catch (error) {
      log(
        `Failed to archive transcript: ${error instanceof Error ? error.message : String(error)}`,
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
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((part: { text?: string }) => part.text || '')
                .join('');
        if (text) {
          messages.push({ role: 'user', content: text });
        }
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((part: { type: string }) => part.type === 'text')
          .map((part: { text: string }) => part.text);
        const text = textParts.join('');
        if (text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
    } catch {
      continue;
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

  for (const message of messages) {
    const sender =
      message.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      message.content.length > 2000
        ? `${message.content.slice(0, 2000)}...`
        : message.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
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
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const fileName of files) {
      const filePath = path.join(IPC_INPUT_DIR, fileName);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (error) {
        log(
          `Failed to process input file ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }

    return messages;
  } catch (error) {
    log(`IPC drain error: ${error instanceof Error ? error.message : String(error)}`);
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

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  runtimeInput: ProviderRuntimeInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{
  events: AgentEvent[];
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}> {
  const stream = new MessageStream();
  stream.push(prompt);

  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) {
      return;
    }
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
  const events: AgentEvent[] = [];

  let globalClaudeMd: string | undefined;
  if (!runtimeInput.isMain) {
    const canonicalGlobalMemoryPath = path.join(
      WORKSPACE_GLOBAL_DIR,
      'AGENT.md',
    );
    const legacyGlobalMemoryPath = path.join(
      WORKSPACE_GLOBAL_DIR,
      'CLAUDE.md',
    );

    if (fs.existsSync(canonicalGlobalMemoryPath)) {
      globalClaudeMd = fs.readFileSync(canonicalGlobalMemoryPath, 'utf-8');
    } else if (fs.existsSync(legacyGlobalMemoryPath)) {
      globalClaudeMd = fs.readFileSync(legacyGlobalMemoryPath, 'utf-8');
    }
  }

  const extraDirs: string[] = [];
  if (fs.existsSync(WORKSPACE_EXTRA_DIR)) {
    for (const entry of fs.readdirSync(WORKSPACE_EXTRA_DIR)) {
      const fullPath = path.join(WORKSPACE_EXTRA_DIR, entry);
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
      cwd: WORKSPACE_GROUP_DIR,
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
            NANOCLAW_CHAT_JID: runtimeInput.chatJid,
            NANOCLAW_GROUP_FOLDER: runtimeInput.groupFolder,
            NANOCLAW_IS_MAIN: runtimeInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(runtimeInput.assistantName)] },
        ],
      },
    },
  })) {
    messageCount++;
    const messageType =
      message.type === 'system'
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${messageType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      if (newSessionId) {
        events.push({ type: 'session_started', sessionId: newSessionId });
        log(`Session initialized: ${newSessionId}`);
      }
    }

    if (
      message.type === 'system' &&
      (message as { subtype?: string }).subtype === 'task_notification'
    ) {
      const taskNotification = message as {
        task_id: string;
        status: string;
        summary: string;
      };
      log(
        `Task notification: task=${taskNotification.task_id} status=${taskNotification.status} summary=${taskNotification.summary}`,
      );
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult =
        'result' in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
      );
      events.push({
        type: 'result',
        text: textResult || null,
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );

  return {
    events,
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
  };
}

export const claudeCodeProvider: ContainerAgentProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: true,
    agentTeams: true,
    providerSkills: true,
  },
  providerHomeDir: '/home/node/.claude',
  prepareWorkspace() {
    return {
      files: [],
    };
  },
  async *run(ctx) {
    const sdkEnv: Record<string, string | undefined> = { ...process.env };

    let sessionId = ctx.input.sessionId;
    let prompt = ctx.input.prompt;
    let resumeAt: string | undefined;

    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }

    if (ctx.input.isScheduledTask) {
      prompt =
        '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n' +
        prompt;
    }

    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(`Draining ${pending.length} pending IPC messages into initial prompt`);
      prompt += `\n${pending.join('\n')}`;
    }

    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`,
      );

      const queryResult = await runQuery(
        prompt,
        sessionId,
        ctx.mcpServerPath,
        ctx.input,
        sdkEnv,
        resumeAt,
      );

      for (const event of queryResult.events) {
        yield event;
      }

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

      yield {
        type: 'result',
        text: null,
      };

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  },
};
