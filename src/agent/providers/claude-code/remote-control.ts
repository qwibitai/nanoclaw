import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../../../logger.js';

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
  providerId: string;
}

let activeSession: RemoteControlSession | null = null;

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;

function getDataDir(): string {
  return process.env.NANOCLAW_DATA_DIR || path.resolve(process.cwd(), 'data');
}

function getStateFilePath(): string {
  return path.join(getDataDir(), 'remote-control.json');
}

function getStdoutFilePath(): string {
  return path.join(getDataDir(), 'remote-control.stdout');
}

function getStderrFilePath(): string {
  return path.join(getDataDir(), 'remote-control.stderr');
}

function saveState(session: RemoteControlSession): void {
  const stateFile = getStateFilePath();
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(session));
}

function clearState(): void {
  try {
    fs.unlinkSync(getStateFilePath());
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

export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(getStateFilePath(), 'utf-8');
  } catch {
    return;
  }

  try {
    const session = JSON.parse(data) as Partial<RemoteControlSession>;
    const normalizedSession: RemoteControlSession = {
      pid: session.pid || 0,
      url: session.url || '',
      startedBy: session.startedBy || '',
      startedInChat: session.startedInChat || '',
      startedAt: session.startedAt || '',
      providerId: session.providerId || 'claude-code',
    };
    if (normalizedSession.pid && isProcessAlive(normalizedSession.pid)) {
      activeSession = normalizedSession;
      saveState(normalizedSession);
      logger.info(
        { pid: normalizedSession.pid, url: normalizedSession.url },
        'Restored Remote Control session from previous run',
      );
    } else {
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

export function _resetForTesting(): void {
  activeSession = null;
}

export function _getStateFilePath(): string {
  return getStateFilePath();
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
  providerId: string = 'claude-code',
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    if (isProcessAlive(activeSession.pid)) {
      return { ok: true, url: activeSession.url };
    }
    activeSession = null;
    clearState();
  }

  const dataDir = getDataDir();
  const stdoutFile = getStdoutFilePath();
  const stderrFile = getStderrFilePath();
  fs.mkdirSync(dataDir, { recursive: true });
  const stdoutFd = fs.openSync(stdoutFile, 'w');
  const stderrFd = fs.openSync(stderrFile, 'w');

  let proc;
  try {
    proc = spawn('claude', ['remote-control', '--name', 'NanoClaw Remote'], {
      cwd,
      stdio: ['pipe', stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err: any) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return { ok: false, error: `Failed to start: ${err.message}` };
  }

  if (proc.stdin) {
    proc.stdin.write('y\n');
    proc.stdin.end();
  }

  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    return { ok: false, error: 'Failed to get process PID' };
  }

  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: 'Process exited before producing URL' });
        return;
      }

      let content = '';
      try {
        content = fs.readFileSync(stdoutFile, 'utf-8');
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
          providerId,
        };
        activeSession = session;
        saveState(session);

        logger.info(
          { url: match[0], pid, sender, chatJid, providerId },
          'Remote Control session started',
        );
        resolve({ ok: true, url: match[0] });
        return;
      }

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

export function stopRemoteControl(
  chatJid?: string,
  providerId?: string,
):
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: 'No active Remote Control session' };
  }

  if (
    (chatJid && activeSession.startedInChat !== chatJid) ||
    (providerId && activeSession.providerId !== providerId)
  ) {
    return {
      ok: false,
      error: `Remote Control session is owned by ${activeSession.startedInChat} on provider ${activeSession.providerId}.`,
    };
  }

  const { pid } = activeSession;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already dead
  }
  activeSession = null;
  clearState();
  logger.info({ pid }, 'Remote Control session stopped');
  return { ok: true };
}
