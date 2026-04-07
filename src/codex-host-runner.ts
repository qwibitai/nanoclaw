import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { isSyntaxError } from './error-utils.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const RUNNER_DIR = path.join(process.cwd(), 'runners', 'codex-runner');
const RUNNER_ENTRY = path.join(RUNNER_DIR, 'dist', 'index.js');

export interface CodexHostInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface CodexHostOutput {
  status: 'success' | 'error';
  result: string | null;
  phase?: 'progress' | 'final';
  newSessionId?: string;
  error?: string;
}

function prepareCodexHostEnvironment(
  group: RegisteredGroup,
  input: CodexHostInput,
): { env: NodeJS.ProcessEnv; processName: string } {
  const groupDir = resolveGroupFolderPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const ipcDir = resolveGroupIpcPath(group.folder);
  const sessionRoot = path.join(DATA_DIR, 'sessions', group.folder);
  const codexConfigDir = path.join(sessionRoot, '.codex');

  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(codexConfigDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-codex-${safeName}-${Date.now()}`;

  const currentPath = process.env.PATH || '';
  const homebrewBin = '/opt/homebrew/bin';
  const pathValue = currentPath.includes(homebrewBin)
    ? currentPath
    : `${homebrewBin}:${currentPath || '/usr/local/bin:/usr/bin:/bin'}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathValue,
    HOME: process.env.HOME,
    TZ: TIMEZONE,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_IPC_DIR: ipcDir,
    NANOCLAW_CHAT_JID: input.chatJid,
    NANOCLAW_GROUP_FOLDER: input.groupFolder,
    NANOCLAW_IS_MAIN: input.isMain ? '1' : '0',
  };

  const config = group.containerConfig;
  if (config?.model) env.CODEX_MODEL = config.model;
  if (config?.reasoningEffort) env.CODEX_EFFORT = config.reasoningEffort;

  return { env, processName };
}

export async function runCodexHostAgent(
  group: RegisteredGroup,
  input: CodexHostInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: CodexHostOutput) => Promise<void>,
): Promise<CodexHostOutput> {
  if (!fs.existsSync(RUNNER_ENTRY)) {
    return {
      status: 'error',
      result: null,
      error: 'Codex host runner is not built. Run `npm run build:runners`.',
    };
  }

  const { env, processName } = prepareCodexHostEnvironment(group, input);

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [RUNNER_ENTRY], {
      cwd: RUNNER_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(proc, processName);
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;
    let streamedError: CodexHostOutput | null = null;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Codex host runner timed out',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      if (!onOutput) return;

      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) {
          parseBuffer = parseBuffer.slice(startIdx);
          break;
        }

        const payload = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        if (!payload) continue;
        try {
          const output = JSON.parse(payload) as CodexHostOutput;
          hadStreamingOutput = true;
          if (output.newSessionId) {
            newSessionId = output.newSessionId;
          }
          if (output.status === 'error') {
            streamedError = output;
          }
          outputChain = outputChain.then(() => onOutput(output));
          resetTimeout();
        } catch (err) {
          if (!isSyntaxError(err)) throw err;
          logger.warn(
            { group: group.name, err, payload },
            'Failed to parse Codex host runner output chunk',
          );
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (!stderrTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      }
      resetTimeout();
    });

    proc.on('close', async (code) => {
      clearTimeout(timeout);
      await outputChain;

      if (timedOut) {
        resolve({
          status: 'error',
          result: null,
          newSessionId,
          error: 'Codex host runner timed out',
        });
        return;
      }

      if (code !== 0) {
        resolve(
          streamedError || {
            status: 'error',
            result: null,
            newSessionId,
            error:
              stderr.trim() || `Codex host runner exited with code ${code}`,
          },
        );
        return;
      }

      if (streamedError) {
        resolve(streamedError);
        return;
      }

      if (hadStreamingOutput) {
        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
        return;
      }

      resolve({
        status: 'success',
        result: stdout.trim() || null,
        newSessionId,
      });
    });

    proc.on('error', async (err) => {
      clearTimeout(timeout);
      await outputChain;
      resolve({
        status: 'error',
        result: null,
        newSessionId,
        error: err.message,
      });
    });
  });
}
