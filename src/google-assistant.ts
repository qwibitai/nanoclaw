import { ChildProcess, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as path from 'path';
import * as readline from 'readline';

import { logger } from './logger.js';

export interface GoogleAssistantResponse {
  status: string;
  text?: string;
  error?: string;
  warning?: string;
  raw_html?: string;
}

const VENV_PYTHON = path.join(process.cwd(), 'scripts', 'venv', 'bin', 'python3');
const PYTHON_DAEMON = path.join(process.cwd(), 'scripts', 'google-assistant-daemon.py');

// ── Python daemon management ──────────────────────────────────────

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

let daemon: ChildProcess | null = null;
let daemonRL: readline.Interface | null = null;
const pendingCommands = new Map<string, PendingCommand>();
let daemonReady = false;
let consecutiveFailures = 0;

async function ensureDaemon(): Promise<void> {
  if (daemon && !daemon.killed && daemonReady) return;

  // Clean up any dead process
  if (daemon) {
    daemon.kill();
    daemon = null;
    daemonRL = null;
    daemonReady = false;
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, [PYTHON_DAEMON], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: 'python' },
    });

    proc.stderr!.on('data', (data: Buffer) => {
      logger.info({ msg: data.toString().trim() }, 'google-assistant-daemon');
    });

    proc.on('error', (err) => {
      logger.error({ err }, 'Failed to spawn Google Assistant daemon');
      daemon = null;
      daemonReady = false;
      reject(err);
    });

    proc.on('exit', (code) => {
      logger.info({ code }, 'Google Assistant daemon exited');
      daemon = null;
      daemonRL = null;
      daemonReady = false;
      // Reject all pending commands
      for (const [id, pending] of pendingCommands) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Daemon exited with code ${code}`));
      }
      pendingCommands.clear();
    });

    const rl = readline.createInterface({ input: proc.stdout! });

    rl.on('line', (line: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn({ line }, 'Non-JSON line from Google Assistant daemon');
        return;
      }

      // First message is the "ready" signal
      if (!daemonReady && parsed.status === 'ready') {
        daemonReady = true;
        resolve();
        return;
      }

      // Route response to the correct pending command by ID
      const cmdId = parsed.id as string | undefined;
      if (cmdId && pendingCommands.has(cmdId)) {
        const pending = pendingCommands.get(cmdId)!;
        pendingCommands.delete(cmdId);
        clearTimeout(pending.timer);
        pending.resolve(parsed);
      } else if (pendingCommands.size === 1) {
        // Fallback for responses without id (backward compat)
        const entry = pendingCommands.entries().next().value;
        if (entry) {
          const [fallbackId, pending] = entry;
          pendingCommands.delete(fallbackId);
          clearTimeout(pending.timer);
          pending.resolve(parsed);
        }
      } else if (pendingCommands.size > 0) {
        logger.warn({ cmdId, pending: pendingCommands.size }, 'Unroutable response from daemon (no matching id)');
      }
    });

    daemon = proc;
    daemonRL = rl;

    // Timeout if daemon doesn't connect within 30s
    setTimeout(() => {
      if (!daemonReady) {
        proc.kill();
        reject(new Error('Google Assistant daemon timed out during startup'));
      }
    }, 30_000);
  });
}

async function sendCommand(cmd: Record<string, unknown>): Promise<any> {
  // Auto-restart daemon after consecutive failures
  if (consecutiveFailures >= 3 && daemon && !daemon.killed) {
    logger.warn({ consecutiveFailures }, 'Too many consecutive failures, restarting daemon');
    daemon.kill();
    daemon = null;
    daemonRL = null;
    daemonReady = false;
    consecutiveFailures = 0;
  }

  await ensureDaemon();

  if (!daemon || !daemon.stdin) {
    throw new Error('Google Assistant daemon not available');
  }

  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingCommands.has(id)) {
        pendingCommands.delete(id);
        reject(new Error('Command timed out'));
      }
    }, 30_000);

    pendingCommands.set(id, { resolve, reject, timer });

    daemon!.stdin!.write(JSON.stringify({ ...cmd, id }) + '\n');
  });
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Send a text command to Google Assistant and return the response.
 */
export async function sendGoogleAssistantCommand(text: string): Promise<GoogleAssistantResponse> {
  let result: any;
  try {
    result = await sendCommand({ cmd: 'command', text });
  } catch (err) {
    consecutiveFailures++;
    throw err;
  }

  if (result.error) {
    consecutiveFailures++;
    throw new Error(result.error);
  }

  consecutiveFailures = 0;

  const response: GoogleAssistantResponse = {
    status: result.status,
    text: result.text,
    raw_html: result.raw_html,
  };
  if (result.warning) {
    response.warning = result.warning;
  }
  return response;
}

/**
 * Reset the Google Assistant conversation (clear conversation state).
 */
export async function resetGoogleAssistantConversation(): Promise<GoogleAssistantResponse> {
  const result = await sendCommand({ cmd: 'reset_conversation' });

  if (result.error) {
    throw new Error(result.error);
  }

  return result;
}

/**
 * Check Google Assistant daemon health.
 */
export async function googleAssistantHealth(): Promise<GoogleAssistantResponse> {
  const result = await sendCommand({ cmd: 'health' });
  return result;
}

/**
 * Shut down the Python daemon (call on process exit).
 */
export function shutdownGoogleAssistant(): void {
  if (daemon && !daemon.killed) {
    daemon.kill();
    daemon = null;
    daemonRL?.close();
    daemonRL = null;
    daemonReady = false;
    // Reject all pending commands
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Google Assistant daemon shut down'));
    }
    pendingCommands.clear();
  }
}
