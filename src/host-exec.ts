import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';

const HOST_EXEC_DIR = path.join(DATA_DIR, 'ipc', 'host-exec');
const DEFAULT_TIMEOUT_MS = 30_000;

const ALLOWED_COMMANDS = new Set([
  'systemctl',
  'cat',
  'grep',
  'journalctl',
  'curl',
  'cloudflared',
  'ls',
  'find',
]);

interface HostExecRequest {
  id: string;
  command: string;
  args?: string[];
  timeout_ms?: number;
}

interface HostExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

let running = false;

export function startHostExecWatcher(): void {
  if (running) {
    logger.debug('Host-exec watcher already running, skipping duplicate start');
    return;
  }
  running = true;

  fs.mkdirSync(HOST_EXEC_DIR, { recursive: true });

  const poll = () => {
    if (!running) return;

    try {
      const files = fs
        .readdirSync(HOST_EXEC_DIR)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));

      for (const file of files) {
        const filePath = path.join(HOST_EXEC_DIR, file);
        try {
          const data: HostExecRequest = JSON.parse(
            fs.readFileSync(filePath, 'utf-8'),
          );

          if (!data.id || !data.command) {
            logger.warn({ file }, 'host-exec: missing id or command');
            fs.unlinkSync(filePath);
            continue;
          }

          // Remove the request file immediately to prevent re-processing
          fs.unlinkSync(filePath);

          executeCommand(data);
        } catch (err) {
          logger.error({ err, file }, 'host-exec: error reading request file');
          try {
            fs.unlinkSync(filePath);
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'host-exec: error scanning directory');
    }

    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
  logger.info({ dir: HOST_EXEC_DIR }, 'Host-exec watcher started');
}

export function stopHostExecWatcher(): void {
  running = false;
  logger.info('Host-exec watcher stopped');
}

function executeCommand(req: HostExecRequest): void {
  const resultPath = path.join(HOST_EXEC_DIR, `${req.id}.result.json`);
  const log = logger.child({
    op: 'host-exec',
    id: req.id,
    command: req.command,
  });

  if (!ALLOWED_COMMANDS.has(req.command)) {
    log.warn('Command not on allowlist, rejecting');
    writeResult(resultPath, {
      stdout: '',
      stderr: 'command not allowed',
      exit_code: 403,
    });
    return;
  }

  const timeout = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const args = req.args ?? [];

  log.info({ args, timeout }, 'Executing host command');

  const child = spawn(req.command, args, {
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  child.on('close', (code, signal) => {
    const exitCode = signal === 'SIGTERM' ? 124 : (code ?? 1);
    const result: HostExecResult = {
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      exit_code: exitCode,
    };
    if (signal === 'SIGTERM') {
      result.stderr += `\nProcess killed: timeout after ${timeout}ms`;
    }
    log.info({ exit_code: exitCode }, 'Host command completed');
    writeResult(resultPath, result);
  });

  child.on('error', (err) => {
    log.error({ err }, 'Failed to spawn host command');
    writeResult(resultPath, {
      stdout: '',
      stderr: `spawn error: ${err.message}`,
      exit_code: 1,
    });
  });
}

function writeResult(resultPath: string, result: HostExecResult): void {
  try {
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  } catch (err) {
    logger.error({ err, resultPath }, 'host-exec: failed to write result file');
  }
}
