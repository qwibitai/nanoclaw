import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  Codex,
  ThreadOptions,
  type CodexOptions,
  type ThreadEvent,
} from '@openai/codex-sdk';

import {
  AgentRuntime,
  RunQueryInput,
  RunQueryResult,
  RuntimeHooks,
  RuntimeIpc,
} from './types.js';

// Container-internal paths (same as Claude runtime)
const CONTAINER_GROUP_PATH = '/workspace/group';
const CONTAINER_IPC_PATH = '/workspace/ipc';
// Mounted from host's ~/.codex so the SDK can find session credentials
const CONTAINER_CODEX_HOME = '/home/node/.codex';
const CONTAINER_EXTRA_BASE = '/workspace/extra';

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getAdditionalDirs(): string[] {
  try {
    if (!fs.existsSync(CONTAINER_EXTRA_BASE)) return [];
    return fs.readdirSync(CONTAINER_EXTRA_BASE)
      .map(e => path.join(CONTAINER_EXTRA_BASE, e))
      .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch {
    return [];
  }
}

function getCodexThreadOptions(sdkEnv: Record<string, string | undefined>): ThreadOptions {
  const extraDirs = getAdditionalDirs();
  return {
    workingDirectory: CONTAINER_GROUP_PATH,
    additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
    sandboxMode:
      (sdkEnv.NANOCLAW_CODEX_SANDBOX_MODE as ThreadOptions['sandboxMode']) ||
      'workspace-write',
    approvalPolicy:
      (sdkEnv.NANOCLAW_CODEX_APPROVAL_POLICY as ThreadOptions['approvalPolicy']) ||
      'never',
    networkAccessEnabled: parseBool(sdkEnv.NANOCLAW_CODEX_NETWORK_ACCESS, true),
    webSearchEnabled: parseBool(sdkEnv.NANOCLAW_CODEX_WEB_SEARCH_ENABLED, false),
    webSearchMode:
      (sdkEnv.NANOCLAW_CODEX_WEB_SEARCH_MODE as ThreadOptions['webSearchMode']) ||
      'disabled',
    model: sdkEnv.NANOCLAW_CODEX_MODEL,
    modelReasoningEffort:
      (sdkEnv.NANOCLAW_CODEX_REASONING_EFFORT as ThreadOptions['modelReasoningEffort']) ||
      undefined,
  };
}

function loadDeveloperInstructions(): string | undefined {
  const candidates = [
    path.join(CONTAINER_GROUP_PATH, 'CLAUDE.md'),
    '/workspace/global/CLAUDE.md',
  ];
  const sections: string[] = [];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) sections.push(content);
      }
    } catch { /* ignore */ }
  }
  return sections.length > 0 ? sections.join('\n\n---\n\n') : undefined;
}

function getCodexOptions(input: RunQueryInput): CodexOptions {
  const { sdkEnv, containerInput } = input;
  const developerInstructions = loadDeveloperInstructions();
  return {
    ...(sdkEnv.OPENAI_API_KEY ? { apiKey: sdkEnv.OPENAI_API_KEY } : {}),
    baseUrl: sdkEnv.OPENAI_BASE_URL,
    config: {
      ...(developerInstructions ? { developer_instructions: developerInstructions } : {}),
      mcp_servers: {
        nanoclaw: {
          command: input.mcpServerCommand,
          args: input.mcpServerArgs,
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            NANOCLAW_IPC_PATH: CONTAINER_IPC_PATH,
          },
        },
      },
      sandbox_workspace_write: {
        writable_roots: [CONTAINER_GROUP_PATH, CONTAINER_IPC_PATH, '/tmp'],
        network_access: parseBool(sdkEnv.NANOCLAW_CODEX_NETWORK_ACCESS, true),
      },
    },
  };
}

function eventSummary(event: ThreadEvent): string | null {
  if (event.type === 'item.completed') {
    if (event.item.type === 'command_execution') {
      return `command completed: ${event.item.command} (status=${event.item.status})`;
    }
    if (event.item.type === 'mcp_tool_call') {
      return `mcp tool call completed: ${event.item.server}/${event.item.tool}`;
    }
  }
  if (event.type === 'turn.failed') {
    return `turn failed: ${event.error.message}`;
  }
  if (event.type === 'error') {
    return `stream error: ${event.message}`;
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function archiveCodexTurn(prompt: string, response: string, threadId?: string): void {
  const conversationsDir = path.join(CONTAINER_GROUP_PATH, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  const suffix = threadId ? `codex-${threadId}` : 'codex-session';
  const filename = `${date}-${suffix}.md`;
  const filePath = path.join(conversationsDir, filename);

  const now = new Date().toISOString();
  const content = [
    `# Codex turn archive (${now})`,
    '',
    '## User',
    '',
    prompt,
    '',
    '## Assistant',
    '',
    response || '(empty)',
    '',
  ].join('\n');

  fs.appendFileSync(filePath, content);
}

export class CodexRuntime implements AgentRuntime {
  constructor(
    private readonly hooks: RuntimeHooks,
    private readonly ipc: RuntimeIpc,
  ) {}

  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    const { prompt, sessionId, resumeAt } = input;

    if (resumeAt) {
      this.hooks.onLog(`Codex runtime ignores resumeAt cursor for now: ${resumeAt}`);
    }

    // Point SDK to the mounted host credentials directory
    process.env.CODEX_HOME = CONTAINER_CODEX_HOME;

    // Codex requires a git repo in the working directory.
    // Initialize one if not present — this is a one-time setup per group.
    if (!fs.existsSync(path.join(CONTAINER_GROUP_PATH, '.git'))) {
      this.hooks.onLog('Initializing git repo in workspace for Codex');
      execSync('git init && git commit --allow-empty -m "init"', {
        cwd: CONTAINER_GROUP_PATH,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Lyra', GIT_AUTHOR_EMAIL: 'lyra@nanoclaw', GIT_COMMITTER_NAME: 'Lyra', GIT_COMMITTER_EMAIL: 'lyra@nanoclaw' },
        stdio: 'ignore',
      });
    }

    if (input.sdkEnv.OPENAI_API_KEY) {
      this.hooks.onLog('Codex runtime auth mode: OPENAI_API_KEY');
    } else {
      this.hooks.onLog(`Codex runtime auth mode: CODEX_HOME (${CONTAINER_CODEX_HOME})`);
    }

    const codex = new Codex(getCodexOptions(input));
    const threadOptions = getCodexThreadOptions(input.sdkEnv);
    const thread = sessionId
      ? codex.resumeThread(sessionId, threadOptions)
      : codex.startThread(threadOptions);

    const abortController = new AbortController();
    let ipcPolling = true;
    let pollTimer: NodeJS.Timeout | null = null;
    let closedDuringQuery = false;
    let nextPrompt: string | undefined;

    const stopIpcPolling = () => {
      ipcPolling = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;

      if (this.ipc.shouldClose()) {
        closedDuringQuery = true;
        this.hooks.onLog('Close sentinel detected during Codex query');
        stopIpcPolling();
        abortController.abort();
        return;
      }

      const messages = this.ipc.drainIpcInput();
      if (messages.length > 0) {
        nextPrompt = messages.join('\n');
        this.hooks.onLog(`Received ${messages.length} IPC message(s) during Codex query; interrupting turn`);
        stopIpcPolling();
        abortController.abort();
        return;
      }

      pollTimer = setTimeout(pollIpcDuringQuery, this.ipc.ipcPollMs);
    };

    let finalText = '';
    let newSessionId = thread.id || sessionId || undefined;

    pollTimer = setTimeout(pollIpcDuringQuery, this.ipc.ipcPollMs);

    try {
      const streamed = await thread.runStreamed(prompt, {
        signal: abortController.signal,
      });
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') {
          newSessionId = event.thread_id;
        }
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          finalText = event.item.text || finalText;
        }
        const summary = eventSummary(event);
        if (summary) {
          this.hooks.onLog(`[codex] ${summary}`);
        }
      }
    } catch (error) {
      if (
        !abortController.signal.aborted ||
        (!closedDuringQuery && nextPrompt == null && !isAbortError(error))
      ) {
        throw error;
      }
      this.hooks.onLog('Codex query interrupted to handle IPC input');
    } finally {
      stopIpcPolling();
    }

    if (closedDuringQuery) {
      return { newSessionId, lastAssistantUuid: undefined, closedDuringQuery: true };
    }

    if (nextPrompt != null) {
      return { newSessionId, lastAssistantUuid: undefined, closedDuringQuery: false, nextPrompt };
    }

    archiveCodexTurn(prompt, finalText, newSessionId);
    this.hooks.onResult(finalText || null, newSessionId);

    return { newSessionId, lastAssistantUuid: undefined, closedDuringQuery: false };
  }
}
