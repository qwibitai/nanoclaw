/**
 * Host Browser Manager
 * Manages a headed Chrome instance on the host for container agents.
 * Chrome lifecycle is tied to containers via acquire/release refcount.
 */
import { ChildProcess, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, HOST_BROWSER_PORT } from './config.js';
import { logger } from './logger.js';

const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
const CDP_URL = `http://127.0.0.1:${HOST_BROWSER_PORT}`;
const READY_TIMEOUT = 10_000;
const READY_POLL_INTERVAL = 500;

let chromeProcess: ChildProcess | null = null;
let refCount = 0;
let chromeBinary: string | null | undefined; // undefined = not yet detected
let launchPromise: Promise<boolean> | null = null;

function detectChromeBinary(): string | null {
  if (chromeBinary !== undefined) return chromeBinary;

  const candidates =
    os.platform() === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['google-chrome', 'google-chrome-stable', 'chromium-browser'];

  for (const candidate of candidates) {
    try {
      // Absolute paths: check existence. Relative: resolve via which.
      if (path.isAbsolute(candidate)) {
        if (fs.existsSync(candidate)) {
          chromeBinary = candidate;
          return chromeBinary;
        }
      } else {
        const resolved = execFileSync('which', [candidate], {
          encoding: 'utf-8',
        }).trim();
        if (resolved) {
          chromeBinary = resolved;
          return chromeBinary;
        }
      }
    } catch {
      // Not found, try next
    }
  }

  chromeBinary = null;
  logger.info('Chrome not found — host browser feature disabled');
  return null;
}

async function isCdpReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isCdpReachable()) return;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL));
  }
  throw new Error(
    `Chrome CDP not ready after ${READY_TIMEOUT / 1000}s on port ${HOST_BROWSER_PORT}`,
  );
}

async function launchChrome(binary: string): Promise<void> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const args = [
    `--remote-debugging-port=${HOST_BROWSER_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];

  chromeProcess = spawn(binary, args, { stdio: 'ignore' });

  chromeProcess.on('exit', (code) => {
    logger.info({ code }, 'Host Chrome exited');
    chromeProcess = null;
  });

  await waitForCdp();
  logger.info({ port: HOST_BROWSER_PORT }, 'Host Chrome ready');
}

/**
 * Ensure Chrome is running (launch or adopt). Serialized via coalescing promise
 * so concurrent callers don't double-launch.
 */
async function ensureChrome(binary: string): Promise<boolean> {
  if (chromeProcess && !chromeProcess.killed) return true;

  if (await isCdpReachable()) {
    logger.info({ port: HOST_BROWSER_PORT }, 'Adopting existing Chrome CDP');
    return true;
  }

  try {
    await launchChrome(binary);
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to launch host Chrome');
    return false;
  }
}

/**
 * Acquire the host browser. Starts Chrome if not running, increments refcount.
 * Returns true if Chrome is available, false if binary not found.
 */
export async function acquireHostBrowser(): Promise<boolean> {
  const binary = detectChromeBinary();
  if (!binary) return false;

  // Coalesce concurrent launches — all callers await the same promise
  if (!launchPromise) {
    launchPromise = ensureChrome(binary).finally(() => {
      launchPromise = null;
    });
  }
  const available = await launchPromise;

  if (available) refCount++;
  return available;
}

/**
 * Release the host browser. Decrements refcount, kills Chrome when zero.
 */
export function releaseHostBrowser(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;

  if (chromeProcess && !chromeProcess.killed) {
    logger.info('Stopping host Chrome (no more containers)');
    chromeProcess.kill('SIGTERM');
    chromeProcess = null;
  }
}
