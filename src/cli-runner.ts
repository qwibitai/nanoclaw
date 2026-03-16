/**
 * CLI Agent Runner for NanoClaw
 * Alternative to the Docker container runner — spawns a CLI tool (claude or cursor)
 * directly on the host. No container isolation, but no Docker dependency either.
 *
 * Supports two presets:
 *   claude  — Uses `claude -p` with stream-json output and session resumption
 *   cursor  — Uses `cursor` CLI (command and args are configurable)
 *
 * Set AGENT_BACKEND=cli and AGENT_CLI=claude|cursor in your .env to activate.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  AGENT_CLI,
  AGENT_CLI_COMMAND,
  AGENT_CLI_EXTRA_ARGS,
  CLI_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

interface CliPreset {
  command: string;
  buildArgs: (
    prompt: string,
    opts: { sessionId?: string; cwd?: string },
  ) => string[];
  streaming: boolean;
}

function getExtraArgs(): string[] {
  if (!AGENT_CLI_EXTRA_ARGS) return [];
  return AGENT_CLI_EXTRA_ARGS.split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

function getCliPreset(): CliPreset {
  const extra = getExtraArgs();

  if (AGENT_CLI === 'cursor') {
    const command = AGENT_CLI_COMMAND || 'cursor';
    return {
      command,
      buildArgs: (prompt, opts) => {
        // Cursor CLI agent mode — adjust flags for your Cursor version.
        // Override with AGENT_CLI_EXTRA_ARGS if needed.
        const args = extra.length > 0 ? [...extra] : ['agent', '--message'];
        args.push(prompt);
        if (opts.cwd) args.push('--folder', opts.cwd);
        return args;
      },
      streaming: false,
    };
  }

  // Default: claude
  const command = AGENT_CLI_COMMAND || 'claude';
  return {
    command,
    buildArgs: (prompt, opts) => {
      const args = [
        '-p',
        prompt,
        '--dangerously-skip-permissions',
        '--output-format',
        'stream-json',
        '--max-turns',
        '200',
      ];
      if (opts.sessionId) args.push('--resume', opts.sessionId);
      args.push(...extra);
      return args;
    },
    streaming: true,
  };
}

/**
 * Write an .mcp.json in the group directory so the CLI tool picks up
 * NanoClaw IPC tools (send_message, schedule_task, etc.).
 * Only effective when the agent-runner MCP server is available on the host.
 */
function writeMcpConfig(group: RegisteredGroup, input: ContainerInput): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  const projectRoot = process.cwd();

  const mcpServerDist = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
    'ipc-mcp-stdio.js',
  );
  const mcpServerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
    'ipc-mcp-stdio.ts',
  );

  let mcpCommand: string;
  let mcpArgs: string[];
  let mcpCwd: string | undefined;

  if (fs.existsSync(mcpServerDist)) {
    mcpCommand = 'node';
    mcpArgs = [mcpServerDist];
  } else if (fs.existsSync(mcpServerSrc)) {
    mcpCommand = 'npx';
    mcpArgs = ['tsx', mcpServerSrc];
    mcpCwd = path.join(projectRoot, 'container', 'agent-runner');
  } else {
    logger.debug(
      'MCP server not found, skipping NanoClaw IPC tools for CLI mode',
    );
    return;
  }

  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const serverConfig: Record<string, unknown> = {
    command: mcpCommand,
    args: mcpArgs,
    env: {
      NANOCLAW_CHAT_JID: input.chatJid,
      NANOCLAW_GROUP_FOLDER: input.groupFolder,
      NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
      NANOCLAW_IPC_DIR: ipcDir,
    },
  };
  if (mcpCwd) serverConfig.cwd = mcpCwd;

  const mcpConfig = { mcpServers: { nanoclaw: serverConfig } };
  const mcpConfigPath = path.join(groupDir, '.mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
}

export async function runCliAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const preset = getCliPreset();
  const cliArgs = preset.buildArgs(input.prompt, {
    sessionId: input.sessionId,
    cwd: groupDir,
  });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-cli-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      command: preset.command,
      cli: AGENT_CLI,
      processName,
      hasSession: !!input.sessionId,
    },
    'Spawning CLI agent',
  );

  writeMcpConfig(group, input);

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const proc = spawn(preset.command, cliArgs, {
      cwd: groupDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, TZ: TIMEZONE },
    });

    onProcess(proc, processName);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let streamingSessionId: string | undefined;
    let hadStreamingResult = false;
    let outputChain = Promise.resolve();

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;

      if (!preset.streaming || !onOutput) return;

      // Parse NDJSON lines from Claude's stream-json output
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (
            msg.type === 'system' &&
            msg.subtype === 'init' &&
            msg.session_id
          ) {
            streamingSessionId = msg.session_id;
          }
          if (msg.type === 'result' && msg.result) {
            if (msg.session_id) streamingSessionId = msg.session_id;
            hadStreamingResult = true;
            const resultText = msg.result;
            outputChain = outputChain.then(() =>
              onOutput({
                status: 'success',
                result: resultText,
                newSessionId: streamingSessionId,
              }),
            );
          }
        } catch {
          /* non-JSON line — debug log from CLI, skip */
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.split('\n')) {
        if (line.trim()) logger.debug({ cli: group.folder }, line.trim());
      }
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'CLI agent timeout, sending SIGTERM',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, CLI_TIMEOUT);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log file
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `cli-${ts}.log`);
      fs.writeFileSync(
        logFile,
        [
          `=== CLI Agent Log ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Command: ${preset.command} ${AGENT_CLI}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Timed Out: ${timedOut}`,
          `Had Streaming Result: ${hadStreamingResult}`,
          ``,
          `=== Stderr ===`,
          stderr.slice(-10000),
          ``,
          `=== Stdout (last 10k) ===`,
          stdout.slice(-10000),
        ].join('\n'),
      );

      if (timedOut) {
        if (hadStreamingResult) {
          outputChain.then(() =>
            resolve({
              status: 'success',
              result: null,
              newSessionId: streamingSessionId,
            }),
          );
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `CLI agent timed out after ${CLI_TIMEOUT}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, stderr: stderr.slice(-500), duration },
          'CLI agent exited with error',
        );
        if (hadStreamingResult) {
          outputChain.then(() =>
            resolve({
              status: 'success',
              result: null,
              newSessionId: streamingSessionId,
            }),
          );
          return;
        }
        resolve({
          status: 'error',
          result: null,
          error: `CLI exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: results already emitted via onOutput
      if (preset.streaming && onOutput) {
        outputChain.then(() => {
          logger.info(
            {
              group: group.name,
              duration,
              newSessionId: streamingSessionId,
            },
            'CLI agent completed (streaming)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId: streamingSessionId,
          });
        });
        return;
      }

      // Non-streaming mode: parse full output and emit once
      const result = stdout.trim() || null;
      if (onOutput && result) {
        onOutput({ status: 'success', result, newSessionId: undefined }).then(
          () => {
            logger.info(
              { group: group.name, duration },
              'CLI agent completed',
            );
            resolve({ status: 'success', result: null });
          },
        );
        return;
      }

      logger.info(
        { group: group.name, duration, hasResult: !!result },
        'CLI agent completed',
      );
      resolve({ status: 'success', result });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, command: preset.command, err },
        'CLI agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn "${preset.command}": ${err.message}. Is it installed and in PATH?`,
      });
    });
  });
}
