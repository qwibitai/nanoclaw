import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';
import { auditLog } from './utils/audit-log.js';

const HOST_EXEC_DIR = path.join(DATA_DIR, 'ipc', 'host-exec');
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

/**
 * Explicit binary allowlist. Only binaries listed here may be invoked via
 * host-exec. Args are passed as an argv array (no shell interpolation).
 */
const ALLOWED_COMMANDS = new Set([
  'systemctl',
  'journalctl',
  'curl',
  'cat',
  'ls',
  'find',
  'grep',
  'df',
  'free',
  'ps',
  'git',
  'node',
  'jq',
]);

/** Allowed git subcommands (read-only operations only). */
const GIT_ALLOWED_SUBCOMMANDS = new Set(['pull', 'log', 'status', 'diff']);

/** Git subcommands/flags explicitly blocked as destructive. */
const GIT_BLOCKED_PATTERNS = [
  'push',
  'reset',
  'force-push',
  'clean',
  'checkout',
];

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

/**
 * Validates arguments for commands that require subcommand-level restrictions.
 * Returns null if valid, or an error message string if blocked.
 */
export function validateCommandArgs(
  command: string,
  args: string[],
): string | null {
  if (command === 'systemctl') {
    // Block self-targeting: reject any systemctl call that targets the nanoclaw service
    const nanoclaw_patterns = ['nanoclaw', 'com.nanoclaw'];
    const targetsNanoclaw = args.some((arg) =>
      nanoclaw_patterns.some((pattern) => arg.includes(pattern)),
    );
    if (targetsNanoclaw) {
      return 'systemctl cannot target the nanoclaw service';
    }
    return null;
  }

  if (command === 'git') {
    // Find the subcommand (first arg that doesn't start with -)
    const subcommand = args.find((a) => !a.startsWith('-'));
    if (!subcommand) {
      return 'git requires a subcommand (allowed: pull, log, status, diff)';
    }
    if (!GIT_ALLOWED_SUBCOMMANDS.has(subcommand)) {
      return `git subcommand '${subcommand}' is not allowed (allowed: pull, log, status, diff)`;
    }
    // Block --hard flag (e.g. git reset --hard)
    if (args.includes('--hard')) {
      return 'git --hard flag is not allowed';
    }
    // Block --force flag
    if (args.includes('--force') || args.includes('-f')) {
      return 'git --force flag is not allowed';
    }
    return null;
  }

  return null;
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
  const args = req.args ?? [];

  if (!ALLOWED_COMMANDS.has(req.command)) {
    log.warn('Command not on allowlist, rejecting');
    auditLog({
      action: 'host-exec',
      command: req.command,
      args,
      result: 'blocked',
      reason: 'command not on allowlist',
    });
    writeResult(resultPath, {
      stdout: '',
      stderr: 'command not allowed',
      exit_code: 403,
    });
    return;
  }

  // Argument-level validation for restricted commands
  const argError = validateCommandArgs(req.command, args);
  if (argError) {
    log.warn({ args, reason: argError }, 'Command args rejected');
    auditLog({
      action: 'host-exec',
      command: req.command,
      args,
      result: 'blocked',
      reason: argError,
    });
    writeResult(resultPath, {
      stdout: '',
      stderr: argError,
      exit_code: 403,
    });
    return;
  }

  const timeout = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  auditLog({
    action: 'host-exec',
    command: req.command,
    args,
    result: 'allowed',
  });
  log.info({ args, timeout }, 'Executing host command');

  // execFile passes argv as an array — no shell interpolation, no injection risk.
  execFile(
    req.command,
    args,
    { timeout, maxBuffer: MAX_BUFFER },
    (error: ExecFileException | null, stdout: string, stderr: string) => {
      let exitCode: number;
      let stderrOut = stderr;

      if (!error) {
        exitCode = 0;
      } else if (error.killed) {
        exitCode = 124;
        stderrOut += `\nProcess killed: timeout after ${timeout}ms`;
      } else {
        exitCode = typeof error.code === 'number' ? error.code : 1;
      }

      const result: HostExecResult = {
        stdout,
        stderr: stderrOut,
        exit_code: exitCode,
      };

      log.info({ exit_code: exitCode }, 'Host command completed');
      writeResult(resultPath, result);
    },
  );
}

function writeResult(resultPath: string, result: HostExecResult): void {
  try {
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  } catch (err) {
    logger.error({ err, resultPath }, 'host-exec: failed to write result file');
  }
}
