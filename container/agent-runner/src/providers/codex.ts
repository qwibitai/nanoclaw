import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type {
  AgentEvent,
  ContainerAgentProvider,
  ProviderRuntimeInput,
} from '../provider-types.js';

const PROVIDER_ID = 'codex';
const PROVIDER_HOME_DIR =
  process.env.NANOCLAW_CODEX_HOME_DIR || '/home/node/.codex';
const WORKSPACE_GROUP_DIR =
  process.env.NANOCLAW_WORKSPACE_GROUP_DIR || '/workspace/group';
const WORKSPACE_GLOBAL_DIR =
  process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR || '/workspace/global';
const CODEX_BIN = process.env.NANOCLAW_CODEX_BIN || 'codex';
const CODEX_CONFIG_FILE = 'config.toml';
const SCHEDULED_TASK_PREFIX =
  '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function globalMemoryPath(): string | null {
  const canonicalPath = path.join(WORKSPACE_GLOBAL_DIR, 'AGENT.md');
  if (fs.existsSync(canonicalPath)) {
    return canonicalPath;
  }

  const legacyPath = path.join(WORKSPACE_GLOBAL_DIR, 'CLAUDE.md');
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return null;
}

function buildCodexConfig(
  input: ProviderRuntimeInput,
  mcpServerPath: string,
): string {
  const lines: string[] = [];
  const instructionsPath = input.isMain ? null : globalMemoryPath();

  lines.push('forced_login_method = "chatgpt"');
  lines.push('cli_auth_credentials_store = "file"');
  lines.push('');

  if (instructionsPath) {
    lines.push(`model_instructions_file = ${tomlString(instructionsPath)}`);
    lines.push('');
  }

  lines.push('[mcp_servers.nanoclaw]');
  lines.push(`command = ${tomlString('node')}`);
  lines.push(`args = [${tomlString(mcpServerPath)}]`);
  lines.push('');
  lines.push('[mcp_servers.nanoclaw.env]');
  lines.push(`NANOCLAW_CHAT_JID = ${tomlString(input.chatJid)}`);
  lines.push(`NANOCLAW_GROUP_FOLDER = ${tomlString(input.groupFolder)}`);
  lines.push(`NANOCLAW_IS_MAIN = ${tomlString(input.isMain ? '1' : '0')}`);

  return `${lines.join('\n')}\n`;
}

function buildPrompt(input: ProviderRuntimeInput): string {
  if (!input.isScheduledTask) {
    return input.prompt;
  }

  return `${SCHEDULED_TASK_PREFIX}${input.prompt}`;
}

function buildCodexArgs(input: ProviderRuntimeInput, prompt: string): string[] {
  const args = input.sessionId ? ['exec', 'resume'] : ['exec'];
  args.push(
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
  );

  if (!input.isMain && fs.existsSync(WORKSPACE_GLOBAL_DIR)) {
    args.push('--add-dir', WORKSPACE_GLOBAL_DIR);
  }

  if (input.sessionId) {
    args.push(input.sessionId);
  }

  args.push(prompt);
  return args;
}

async function runCodexCommand(
  args: string[],
  abortSignal: AbortSignal,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      cwd: WORKSPACE_GROUP_DIR,
      env: {
        ...process.env,
        CODEX_HOME: PROVIDER_HOME_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const abortChild = () => {
      child.kill('SIGTERM');
    };
    abortSignal.addEventListener('abort', abortChild, { once: true });

    child.on('error', (error) => {
      abortSignal.removeEventListener('abort', abortChild);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      abortSignal.removeEventListener('abort', abortChild);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
      });
    });
  });
}

function parseCodexEvents(stdout: string): {
  events: AgentEvent[];
  sawResult: boolean;
  sawError: boolean;
} {
  const events: AgentEvent[] = [];
  let sawResult = false;
  let sawError = false;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      events.push({
        type: 'warning',
        message: `Ignoring non-JSON Codex output: ${line.slice(0, 200)}`,
      });
      continue;
    }

    if (
      parsed.type === 'thread.started' &&
      typeof parsed.thread_id === 'string'
    ) {
      events.push({
        type: 'session_started',
        sessionId: parsed.thread_id,
      });
      continue;
    }

    if (
      (parsed.type === 'item.completed' || parsed.type === 'item.updated') &&
      typeof parsed.item === 'object' &&
      parsed.item !== null
    ) {
      const item = parsed.item as { type?: unknown; text?: unknown };
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        sawResult = true;
        events.push({
          type: 'result',
          text: item.text,
        });
      }
      continue;
    }

    if (parsed.type === 'turn.failed') {
      const errorMessage =
        typeof parsed.error === 'object' &&
        parsed.error !== null &&
        typeof (parsed.error as { message?: unknown }).message === 'string'
          ? (parsed.error as { message: string }).message
          : 'Codex reported a failed turn.';
      sawError = true;
      events.push({
        type: 'error',
        message: errorMessage,
      });
      continue;
    }

    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      sawError = true;
      events.push({
        type: 'error',
        message: parsed.message,
      });
    }
  }

  return {
    events,
    sawResult,
    sawError,
  };
}

export const codexProvider: ContainerAgentProvider = {
  id: PROVIDER_ID,
  displayName: 'Codex',
  capabilities: {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: false,
    agentTeams: false,
    providerSkills: false,
  },
  providerHomeDir: PROVIDER_HOME_DIR,
  prepareWorkspace() {
    return {
      files: [],
    };
  },
  async *run(ctx) {
    fs.mkdirSync(PROVIDER_HOME_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROVIDER_HOME_DIR, CODEX_CONFIG_FILE),
      buildCodexConfig(ctx.input, ctx.mcpServerPath),
    );

    try {
      const prompt = buildPrompt(ctx.input);
      const { stdout, stderr, exitCode, signal } = await runCodexCommand(
        buildCodexArgs(ctx.input, prompt),
        ctx.abortSignal,
      );
      const { events, sawResult, sawError } = parseCodexEvents(stdout);

      for (const event of events) {
        yield event;
      }

      if (sawError) {
        return;
      }

      if (signal) {
        yield {
          type: 'error',
          message: `Codex terminated with signal ${signal}.`,
        };
        return;
      }

      if (exitCode && exitCode !== 0) {
        yield {
          type: 'error',
          message:
            stderr.trim() || `Codex exited with status ${exitCode}.`,
        };
        return;
      }

      if (!sawResult) {
        yield {
          type: 'result',
          text: null,
        };
      }
    } catch (error) {
      yield {
        type: 'error',
        message:
          error instanceof Error ? error.message : String(error),
      };
    }
  },
};
