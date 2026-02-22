import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

import { logger } from './logger.js';

export interface GoogleAssistantResponse {
  status: string;
  text?: string;
  error?: string;
  raw_html?: string;
}

const VENV_PYTHON = path.join(process.cwd(), 'scripts', 'venv', 'bin', 'python3');
const PYTHON_DAEMON = path.join(process.cwd(), 'scripts', 'google-assistant-daemon.py');

// ── Python daemon management ──────────────────────────────────────

let daemon: ChildProcess | null = null;
let daemonRL: readline.Interface | null = null;
let pendingResolve: ((value: any) => void) | null = null;
let pendingReject: ((reason: any) => void) | null = null;
let daemonReady = false;

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
      if (pendingReject) {
        pendingReject(new Error(`Daemon exited with code ${code}`));
        pendingResolve = null;
        pendingReject = null;
      }
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

      // Subsequent messages are responses to commands
      if (pendingResolve) {
        const res = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        res(parsed);
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
  await ensureDaemon();

  if (!daemon || !daemon.stdin) {
    throw new Error('Google Assistant daemon not available');
  }

  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;

    daemon!.stdin!.write(JSON.stringify(cmd) + '\n');

    // Timeout per command (30s)
    setTimeout(() => {
      if (pendingReject) {
        pendingReject(new Error('Command timed out'));
        pendingResolve = null;
        pendingReject = null;
      }
    }, 30_000);
  });
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Send a text command to Google Assistant and return the response.
 */
export async function sendGoogleAssistantCommand(text: string): Promise<GoogleAssistantResponse> {
  const result = await sendCommand({ cmd: 'command', text });

  if (result.error) {
    throw new Error(result.error);
  }

  return result;
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
    daemonRL = null;
    daemonReady = false;
  }
}
