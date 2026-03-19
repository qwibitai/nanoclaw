/**
 * Host Browser Lifecycle
 * Manages a headed Chrome instance on the host via agent-browser CLI.
 * Container agents connect to it over CDP for login sessions and captchas.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const NANOCLAW_DIR = path.join(os.homedir(), '.nanoclaw');
export const CDP_URL_FILE = path.join(NANOCLAW_DIR, 'cdp-url');
const DEFAULT_PROFILE_DIR = path.join(NANOCLAW_DIR, 'host-browser-profile');

const PROFILE_DIR =
  process.env.NANOCLAW_BROWSER_PROFILE || DEFAULT_PROFILE_DIR;

/**
 * Start (or restart) the host browser daemon via agent-browser.
 * Kills any existing instance first, then starts a headed browser
 * with a persistent profile and writes the CDP URL to a shared file.
 */
export function startHostBrowser(): string {
  // Kill any existing agent-browser daemon
  try {
    execSync('agent-browser close', { stdio: 'ignore', timeout: 10000 });
  } catch {
    // May not be running — that's fine
  }

  fs.mkdirSync(NANOCLAW_DIR, { recursive: true });

  let cdpUrl: string;
  try {
    cdpUrl = execSync(
      `agent-browser --headed --profile "${PROFILE_DIR}" get cdp-url`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      throw new Error(
        'agent-browser not found. Install with:\n' +
          '  brew install agent-browser && agent-browser install\n' +
          '  npm install -g agent-browser && agent-browser install',
      );
    }
    throw new Error(`Failed to start host browser: ${msg}`);
  }

  if (!cdpUrl.startsWith('ws://')) {
    throw new Error(`Invalid CDP URL from agent-browser: ${cdpUrl}`);
  }

  fs.writeFileSync(CDP_URL_FILE, cdpUrl);
  logger.info({ profile: PROFILE_DIR }, 'Host browser started');
  return cdpUrl;
}

/**
 * Stop the host browser daemon and remove the CDP URL file.
 */
export function stopHostBrowser(): void {
  try {
    execSync('agent-browser close', { stdio: 'ignore', timeout: 10000 });
  } catch {
    // Best-effort
  }
  try {
    fs.unlinkSync(CDP_URL_FILE);
  } catch {
    // File may not exist
  }
}

/**
 * Read the CDP URL from the shared file and rewrite localhost
 * to host.docker.internal so containers can reach the host browser.
 */
export function getHostBrowserCdpUrl(): string | null {
  try {
    const url = fs.readFileSync(CDP_URL_FILE, 'utf-8').trim();
    if (!url.startsWith('ws://')) return null;
    return url.replace(
      /^ws:\/\/(?:127\.0\.0\.1|localhost):/,
      'ws://host.docker.internal:',
    );
  } catch {
    return null;
  }
}
