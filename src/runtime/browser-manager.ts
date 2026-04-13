import fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import net from 'net';

import { logger } from '../core/logger.js';
import {
  CHROME_PATH,
  DEFAULT_BROWSER_KEEPALIVE_MS,
  DEFAULT_CHROME_ARGS,
} from './browser-config.js';
import {
  BrowserProfileLock,
  acquireProfileLock,
  createProfile,
  getProfile,
  updateProfileMetadata,
} from './browser-profiles.js';

export const DEFAULT_BROWSER_PROFILE_NAME = 'myclaw';

interface BrowserSession {
  profileName: string;
  port: number;
  targetId?: string;
  chromeProcess: ChildProcess;
  pid: number;
  lock: BrowserProfileLock;
  lastUsedAt: number;
  keepAliveMs: number;
  keepAliveTimer: NodeJS.Timeout | null;
}

export interface LaunchBrowserOptions {
  profileName?: string;
  headless?: boolean;
  cdpPort?: number;
  keepAliveMs?: number;
}

export interface BrowserSessionStatus {
  profileName: string;
  running: boolean;
  port?: number;
  targetId?: string;
  lastUsedAt?: string;
}

const sessions = new Map<string, BrowserSession>();

function cleanupChromeSingletonArtifacts(userDataDir: string): void {
  for (const lockFile of [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
  ]) {
    try {
      fs.rmSync(`${userDataDir}/${lockFile}`, { force: true });
    } catch {
      // ignore
    }
  }
}

function findChrome(): string {
  if (CHROME_PATH) return CHROME_PATH;
  return process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
}

function resolveProfileName(profileName?: string): string {
  const normalized = (profileName || DEFAULT_BROWSER_PROFILE_NAME)
    .trim()
    .toLowerCase();
  if (!normalized) return DEFAULT_BROWSER_PROFILE_NAME;
  if (normalized !== DEFAULT_BROWSER_PROFILE_NAME) {
    throw new Error(
      `Only browser profile "${DEFAULT_BROWSER_PROFILE_NAME}" is supported`,
    );
  }
  return normalized;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate free port'));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });

    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Chrome did not start on port ${port} within ${timeoutMs}ms`);
}

function isChromeAlive(session: BrowserSession): boolean {
  if (!session.pid || session.pid <= 0) return false;
  try {
    process.kill(session.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cdpJsonRequest(
  port: number,
  endpoint: string,
  method = 'GET',
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
  });
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status} for ${endpoint}`);
  }
  return response.json();
}

async function ensureTarget(port: number): Promise<string | undefined> {
  const list = await cdpJsonRequest(port, '/json/list');
  if (Array.isArray(list)) {
    const firstPage = list.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      const type = typeof row.type === 'string' ? row.type : '';
      return Boolean(id) && (!type || type === 'page');
    }) as Record<string, unknown> | undefined;
    const id =
      firstPage && typeof firstPage.id === 'string' ? firstPage.id : '';
    if (id) return id;
  }

  let created: unknown;
  try {
    created = await cdpJsonRequest(port, '/json/new?about:blank', 'PUT');
  } catch {
    created = await cdpJsonRequest(port, '/json/new?about:blank');
  }
  if (created && typeof created === 'object') {
    const id =
      typeof (created as Record<string, unknown>).id === 'string'
        ? ((created as Record<string, unknown>).id as string)
        : '';
    return id || undefined;
  }

  return undefined;
}

function touchSession(session: BrowserSession): void {
  session.lastUsedAt = Date.now();
  updateProfileMetadata(session.profileName, {
    last_used: new Date(session.lastUsedAt).toISOString(),
    cdp_port: session.port,
  });

  if (session.keepAliveTimer) clearTimeout(session.keepAliveTimer);
  session.keepAliveTimer = setTimeout(() => {
    closeBrowser(session.profileName).catch((err) => {
      logger.warn(
        { err, profileName: session.profileName },
        'Failed to auto-close idle browser session',
      );
    });
  }, session.keepAliveMs);
}

export async function launchBrowser(
  opts: LaunchBrowserOptions = {},
): Promise<BrowserSessionStatus> {
  const profileName = resolveProfileName(opts.profileName);
  const existing = sessions.get(profileName);
  if (existing && isChromeAlive(existing)) {
    touchSession(existing);
    return {
      profileName,
      running: true,
      port: existing.port,
      targetId: existing.targetId,
      lastUsedAt: new Date(existing.lastUsedAt).toISOString(),
    };
  }

  if (existing) {
    await closeBrowser(profileName).catch(() => undefined);
  }

  const profile = createProfile(profileName);
  const lock = await acquireProfileLock(profileName);
  let chromeProcess: ChildProcess | undefined;

  try {
    cleanupChromeSingletonArtifacts(profile.userDataDir);
    const port = opts.cdpPort ?? (await getFreePort());
    const chromeFlags = [
      ...DEFAULT_CHROME_ARGS,
      ...(opts.headless === false ? [] : ['--headless=new']),
      `--user-data-dir=${profile.userDataDir}`,
      `--remote-debugging-port=${port}`,
    ];

    chromeProcess = spawn(findChrome(), chromeFlags, {
      detached: true,
      stdio: 'ignore',
    });
    chromeProcess.unref();

    const pid = chromeProcess.pid;
    if (!pid || pid <= 0) {
      throw new Error('Failed to launch Chrome process');
    }

    await waitForPort(port, 10_000);
    const targetId = await ensureTarget(port);

    const session: BrowserSession = {
      profileName,
      port,
      targetId,
      chromeProcess,
      pid,
      lock,
      lastUsedAt: Date.now(),
      keepAliveMs: Math.max(
        10_000,
        opts.keepAliveMs || DEFAULT_BROWSER_KEEPALIVE_MS,
      ),
      keepAliveTimer: null,
    };

    sessions.set(profileName, session);
    touchSession(session);

    logger.info({ profileName, port }, 'Launched browser profile session');

    return {
      profileName,
      running: true,
      port,
      targetId,
      lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    };
  } catch (err) {
    if (chromeProcess?.pid) {
      try {
        process.kill(chromeProcess.pid);
      } catch {
        // ignore
      }
    }
    lock.release();
    throw err;
  }
}

export function getBrowserStatus(
  profileName = DEFAULT_BROWSER_PROFILE_NAME,
): BrowserSessionStatus {
  const normalized = resolveProfileName(profileName);
  const session = sessions.get(normalized);
  if (!session) return { profileName: normalized, running: false };
  return {
    profileName: normalized,
    running: isChromeAlive(session),
    port: session.port,
    targetId: session.targetId,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
  };
}

export async function closeBrowser(
  profileName = DEFAULT_BROWSER_PROFILE_NAME,
): Promise<{ closed: boolean }> {
  const normalized = resolveProfileName(profileName);
  const session = sessions.get(normalized);
  if (!session) return { closed: false };

  if (session.keepAliveTimer) {
    clearTimeout(session.keepAliveTimer);
    session.keepAliveTimer = null;
  }

  try {
    process.kill(session.pid);
  } catch {
    // ignore
  }

  session.lock.release();
  sessions.delete(normalized);
  updateProfileMetadata(normalized, {
    last_used: new Date().toISOString(),
    cdp_port: undefined,
  });

  return { closed: true };
}

export async function closeAllBrowsers(): Promise<void> {
  const profileNames = [...sessions.keys()];
  for (const profileName of profileNames) {
    try {
      await closeBrowser(profileName);
    } catch (err) {
      logger.warn({ err, profileName }, 'Failed to close browser session');
    }
  }
}

export function listActiveBrowserSessions(): BrowserSessionStatus[] {
  return [...sessions.values()].map((session) => ({
    profileName: session.profileName,
    running: isChromeAlive(session),
    port: session.port,
    targetId: session.targetId,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
  }));
}

export async function ensureBrowserProfileExists(
  profileName = DEFAULT_BROWSER_PROFILE_NAME,
): Promise<void> {
  const normalized = resolveProfileName(profileName);
  if (!getProfile(normalized)) {
    createProfile(normalized);
  }
}
