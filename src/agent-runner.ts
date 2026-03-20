/**
 * Direct Agent Runner for NanoClaw
 * Module-level replacement for container-runner.ts via loader hooks.
 * Exports the SAME names so upstream code works without any changes.
 *
 * Activated by the direct-runner-loader.ts module hook when
 * NANOCLAW_DIRECT_RUNNER=1 is set.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// ── Types (same as container-runner.ts) ─────────────────────────────

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

// ── Snapshot writers (same logic as container-runner.ts) ─────────────

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);
  fs.writeFileSync(
    path.join(groupIpcDir, 'current_tasks.json'),
    JSON.stringify(filteredTasks, null, 2),
  );
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const visibleGroups = isMain ? groups : [];
  fs.writeFileSync(
    path.join(groupIpcDir, 'available_groups.json'),
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}

// ── IPC file polling (compatible with group-queue.ts) ───────────────

const IPC_POLL_MS = 500;

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
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

  get isEnded(): boolean {
    return this.done;
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

/**
 * Poll IPC input directory for follow-up messages written by
 * group-queue.sendMessage() and closeStdin().
 */
function startIpcPoller(groupFolder: string, stream: MessageStream): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  const closeSentinel = path.join(inputDir, '_close');

  // Clean up stale sentinel from previous runs
  try {
    fs.unlinkSync(closeSentinel);
  } catch {
    /* ignore */
  }

  const poll = () => {
    if (stream.isEnded) return;

    if (fs.existsSync(closeSentinel)) {
      try {
        fs.unlinkSync(closeSentinel);
      } catch {
        /* ignore */
      }
      stream.end();
      return;
    }

    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const files = fs
        .readdirSync(inputDir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const filePath = path.join(inputDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fs.unlinkSync(filePath);
          if (data.type === 'message' && data.text) {
            stream.push(data.text);
          }
        } catch {
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }

    setTimeout(poll, IPC_POLL_MS);
  };

  poll();
}

// ── Pre-compact hook ────────────────────────────────────────────────

function createPreCompactHook(
  groupDir: string,
  assistantName?: string,
): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages: Array<{ role: string; content: string }> = [];
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
            const text = entry.message.content
              .filter((c: { type: string }) => c.type === 'text')
              .map((c: { text: string }) => c.text)
              .join('');
            if (text) messages.push({ role: 'assistant', content: text });
          }
        } catch {
          /* skip */
        }
      }
      if (messages.length === 0) return {};

      const conversationsDir = path.join(groupDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });
      const date = new Date().toISOString().split('T')[0];
      const time = new Date();
      const h = time.getHours().toString().padStart(2, '0');
      const m = time.getMinutes().toString().padStart(2, '0');
      const lines = [
        `# Conversation\n`,
        `Archived: ${time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}\n`,
        `---\n`,
      ];
      for (const msg of messages) {
        const sender =
          msg.role === 'user' ? 'User' : assistantName || 'Assistant';
        const c =
          msg.content.length > 2000
            ? msg.content.slice(0, 2000) + '...'
            : msg.content;
        lines.push(`\n**${sender}**: ${c}\n`);
      }
      fs.writeFileSync(
        path.join(conversationsDir, `${date}-conversation-${h}${m}.md`),
        lines.join(''),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to archive transcript');
    }
    return {};
  };
}

// ── Main runner — SAME NAME as container-runner.ts export ───────────

/**
 * Drop-in replacement for the container-based runContainerAgent().
 * Same function signature — upstream code calls this identically.
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const groupDir = path.join(GROUPS_DIR, input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    input.groupFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
    }
  }

  // IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', input.groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Global CLAUDE.md
  const globalClaudeMdPath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // MCP server paths
  const distDir = path.join(process.cwd(), 'dist');
  const ipcMcpPath = path.join(distDir, 'nanoclaw-mcp-stdio.js');
  const toolsMcpPath = path.join(distDir, 'tools-mcp-stdio.js');
  const skillsDir = path.join(process.cwd(), 'skills');

  // Build SDK environment
  const authSecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  if (authSecrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = authSecrets.ANTHROPIC_API_KEY;
  } else {
    const oauthToken =
      authSecrets.CLAUDE_CODE_OAUTH_TOKEN || authSecrets.ANTHROPIC_AUTH_TOKEN;
    if (oauthToken) sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  delete sdkEnv.ANTHROPIC_BASE_URL;

  // Register mock process for group-queue compatibility
  onProcess(
    { killed: false } as unknown as ChildProcess,
    `direct-${input.groupFolder}`,
  );

  // Build message stream and push initial prompt
  const stream = new MessageStream();
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  stream.push(prompt);

  // Start IPC file poller (reads files written by group-queue)
  startIpcPoller(input.groupFolder, stream);

  let newSessionId: string | undefined;

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: groupDir,
        resume: input.sessionId,
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
          'mcp__*',
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [ipcMcpPath],
            env: {
              NANOCLAW_CHAT_JID: input.chatJid,
              NANOCLAW_GROUP_FOLDER: input.groupFolder,
              NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
              NANOCLAW_IPC_DIR: groupIpcDir,
              NANOCLAW_SKILLS_DIR: skillsDir,
            },
          },
          tools: {
            command: 'node',
            args: [toolsMcpPath],
            env: {
              ENGRAM_URL: process.env.ENGRAM_URL || 'http://localhost:9302',
              KB_URL: process.env.KB_URL || 'http://localhost:9305',
              SERVICES_API_KEY: process.env.SERVICES_API_KEY || '',
              NANOCLAW_GROUP_FOLDER: input.groupFolder,
              NANOCLAW_SKILLS_DIR: skillsDir,
              NANOCLAW_GROUP_DIR: groupDir,
            },
          },
        },
        hooks: {
          PreCompact: [
            {
              hooks: [createPreCompactHook(groupDir, input.assistantName)],
            },
          ],
        },
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logger.debug(
          { group: group.name, sessionId: newSessionId },
          'Direct agent session initialized',
        );
      }

      if (message.type === 'result') {
        const textResult =
          'result' in message
            ? (message as { result?: string }).result
            : null;
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: textResult || null,
            newSessionId,
          });
        }
      }
    }

    return { status: 'success', result: null, newSessionId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, error }, 'Direct agent error');
    if (onOutput) {
      await onOutput({ status: 'error', result: null, error, newSessionId });
    }
    return { status: 'error', result: null, error, newSessionId };
  }
}
