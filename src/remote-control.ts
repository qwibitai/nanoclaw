import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

const sessions = new Map<string, RemoteControlSession>();

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;
const stateFile = (dataDir: string) =>
  path.join(dataDir, 'remote-control.json');
const stdoutFile = (dataDir: string) =>
  path.join(dataDir, 'remote-control.stdout');
const stderrFile = (dataDir: string) =>
  path.join(dataDir, 'remote-control.stderr');

function saveState(dataDir: string, session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(stateFile(dataDir)), { recursive: true });
  fs.writeFileSync(stateFile(dataDir), JSON.stringify(session));
}

function clearState(dataDir: string): void {
  try {
    fs.unlinkSync(stateFile(dataDir));
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise, clean up.
 */
export function restoreRemoteControl(dataDir: string): void {
  let data: string;
  try {
    data = fs.readFileSync(stateFile(dataDir), 'utf-8');
  } catch {
    return;
  }

  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (session.pid && isProcessAlive(session.pid)) {
      sessions.set(dataDir, session);
      logger.info(
        { pid: session.pid, url: session.url },
        'Restored Remote Control session from previous run',
      );
    } else {
      clearState(dataDir);
    }
  } catch {
    clearState(dataDir);
  }
}

export function getActiveSession(dataDir: string): RemoteControlSession | null {
  return sessions.get(dataDir) ?? null;
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  sessions.clear();
}

/** @internal — exported for testing only */
export function _getStateFilePath(dataDir: string): string {
  return stateFile(dataDir);
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
  dataDir: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const existing = sessions.get(dataDir);
  if (existing) {
    // Verify the process is still alive
    if (isProcessAlive(existing.pid)) {
      return { ok: true, url: existing.url };
    }
    // Process died — clean up and start a new one
    sessions.delete(dataDir);
    clearState(dataDir);
  }

  // Redirect stdout/stderr to files so the process has no pipes to the parent.
  // This prevents SIGPIPE when AgentLite restarts.
  fs.mkdirSync(dataDir, { recursive: true });
  const stdoutFd = fs.openSync(stdoutFile(dataDir), 'w');
  const stderrFd = fs.openSync(stderrFile(dataDir), 'w');

  let proc;
  try {
    proc = spawn('claude', ['remote-control', '--name', 'AgentLite Remote'], {
      cwd,
      stdio: ['pipe', stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err: any) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return { ok: false, error: `Failed to start: ${err.message}` };
  }

  // Auto-accept the "Enable Remote Control?" prompt
  if (proc.stdin) {
    proc.stdin.write('y\n');
    proc.stdin.end();
  }

  // Close FDs in the parent — the child inherited copies
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Fully detach from parent
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    return { ok: false, error: 'Failed to get process PID' };
  }

  // Poll the stdout file for the URL
  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      // Check if process died
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      // Check for URL in stdout file
      let content = '';
      try {
        content = fs.readFileSync(stdoutFile(dataDir), 'utf-8');
      } catch {
        // File might not have content yet
      }

      const match = content.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: new Date().toISOString(),
        };
        sessions.set(dataDir, session);
        saveState(dataDir, session);

        logger.info(
          { url: match[0], pid, sender, chatJid },
          'Remote Control session started',
        );
        resolve({ ok: true, url: match[0] });
        return;
      }

      // Timeout check
      if (Date.now() - startTime >= URL_TIMEOUT_MS) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already dead
          }
        }
        resolve({
          ok: false,
          error: 'Timed out waiting for Remote Control URL',
        });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };

    poll();
  });
}

export function stopRemoteControl(dataDir: string):
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  const session = sessions.get(dataDir);
  if (!session) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  const { pid } = session;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead
  }
  sessions.delete(dataDir);
  clearState(dataDir);
  logger.info({ pid }, 'Remote Control session stopped');
  return { ok: true };
}
