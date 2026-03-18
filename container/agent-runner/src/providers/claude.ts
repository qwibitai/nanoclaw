import fs from 'fs';
import path from 'path';

import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import {
  AgentProvider,
  AgentTurnContext,
  AgentTurnResult,
} from '../types.js';

const IPC_POLL_MS = 500;
const HAS_M365_MCP =
  fs.existsSync('/usr/local/bin/m365-mcp') || fs.existsSync('/usr/bin/m365-mcp');

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
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
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
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find((candidate) => candidate.sessionId === sessionId);
    if (entry?.summary) return entry.summary;
  } catch (err) {
    log(
      `Failed to read sessions index: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return null;
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
  return `conversation-${time
    .getHours()
    .toString()
    .padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
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
                .map((chunk: { text?: string }) => chunk.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const text = entry.message.content
          .filter((chunk: { type: string }) => chunk.type === 'text')
          .map((chunk: { text: string }) => chunk.text)
          .join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Ignore malformed transcript lines.
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

function createPreCompactHook(
  assistantName: string | undefined,
  log: (message: string) => void,
): HookCallback {
  return async (input) => {
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
        `Failed to archive transcript: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {};
  };
}

function loadGlobalPrompt(
  isMain: boolean,
  log: (message: string) => void,
): { globalClaudeMd?: string; extraDirs: string[] } {
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) extraDirs.push(fullPath);
    }
  }

  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  return { globalClaudeMd, extraDirs };
}

async function runClaudeTurn(
  context: AgentTurnContext,
): Promise<AgentTurnResult> {
  const {
    prompt,
    sessionId,
    resumeAt,
    mcpServerPath,
    containerInput,
    agentEnv,
    emitOutput,
    log,
    drainIpcInput,
    shouldClose,
  } = context;

  const stream = new MessageStream();
  stream.push(prompt);

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
  let lastAssistantCursor: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  const { globalClaudeMd, extraDirs } = loadGlobalPrompt(
    containerInput.isMain,
    log,
  );

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
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
        ...(containerInput.personalMode
          ? [
              'mcp__gmail__*',
              'mcp__jira__*',
              'mcp__testit__*',
              'mcp__figma__*',
              'mcp__gitlab__*',
              'mcp__atlassian__*',
              'mcp__m365__*',
            ]
          : []),
      ],
      env: agentEnv,
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
        ...(containerInput.personalMode
          ? {
              gmail: {
                command: 'npx',
                args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
              },
              jira: {
                command: 'npx',
                args: [
                  '-y',
                  '--registry=http://nexus3-xmn02.int.rclabenv.com/repository/npm-group/',
                  '@ringcentral/mcp-jira',
                ],
                env: { JIRA_TOKEN: agentEnv.JIRA_TOKEN ?? '' },
              },
              testit: {
                command: 'npx',
                args: [
                  '-y',
                  '--registry',
                  'https://nexus-xmn02.int.rclabenv.com/nexus/content/groups/npm-all/',
                  '@ringcentral/mcp-testit-fetcher',
                ],
              },
              ...(fs.existsSync('/workspace/figma-mcp/index.js')
                ? {
                    figma: {
                      command: 'node',
                      args: ['/workspace/figma-mcp/index.js'],
                    },
                  }
                : {}),
              gitlab: {
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-gitlab'],
                env: {
                  GITLAB_PERSONAL_ACCESS_TOKEN:
                    agentEnv.GITLAB_PERSONAL_ACCESS_TOKEN ?? '',
                  GITLAB_API_URL: 'https://git.ringcentral.com/api/v4',
                },
              },
              atlassian: {
                type: 'http' as const,
                url: 'https://mcp-atlassian.int.rclabenv.com/mcp/',
                headers: {
                  'confluence-read-token':
                    agentEnv.CONFLUENCE_READ_TOKEN ?? '',
                  'jira-read-token': agentEnv.JIRA_TOKEN ?? '',
                },
              },
              ...(HAS_M365_MCP
                ? {
                    m365: {
                      command: 'm365-mcp',
                      args: [],
                      env: {
                        MS_CLIENT_ID: agentEnv.OUTLOOK_CLIENT_ID ?? '',
                        MS_CLIENT_SECRET: agentEnv.OUTLOOK_CLIENT_SECRET ?? '',
                        MS_TENANT_ID: agentEnv.MS_TENANT_ID ?? '',
                        USE_TEST_MODE: 'false',
                      },
                    },
                  }
                : {}),
            }
          : {}),
      },
      hooks: {
        PreCompact: [
          { hooks: [createPreCompactHook(containerInput.assistantName, log)] },
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
      lastAssistantCursor = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
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
        `Result #${resultCount}: subtype=${message.subtype}${
          textResult ? ` text=${textResult.slice(0, 200)}` : ''
        }`,
      );
      emitOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${
      lastAssistantCursor || 'none'
    }, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantCursor, closedDuringQuery };
}

export const claudeProvider: AgentProvider = {
  name: 'claude',
  runTurn: runClaudeTurn,
};
