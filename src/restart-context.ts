/**
 * Restart context: tracks which groups were active at shutdown and
 * announces the interruption to users on the next startup.
 * Inspired by EJClaw's restart-context machinery.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { isErrnoException, isSyntaxError } from './error-utils.js';

const CONTEXT_FILE = path.join(STORE_DIR, 'restart-context.json');

export interface InterruptedGroup {
  chatJid: string;
  groupName: string;
  status: 'processing' | 'waiting';
}

export interface RestartContext {
  groups: InterruptedGroup[];
  signal: string;
  timestamp: string;
}

export function writeShutdownContext(
  groups: InterruptedGroup[],
  signal: string,
): void {
  if (groups.length === 0) return;
  const ctx: RestartContext = {
    groups,
    signal,
    timestamp: new Date().toISOString(),
  };
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

export function consumeRestartContext(): RestartContext | null {
  if (!fs.existsSync(CONTEXT_FILE)) return null;
  try {
    const ctx = JSON.parse(
      fs.readFileSync(CONTEXT_FILE, 'utf-8'),
    ) as RestartContext;
    fs.unlinkSync(CONTEXT_FILE);
    return ctx;
  } catch (err) {
    if (!isSyntaxError(err) && !isErrnoException(err)) throw err;
    try {
      fs.unlinkSync(CONTEXT_FILE);
    } catch (unlinkErr) {
      if (!isErrnoException(unlinkErr, 'ENOENT')) throw unlinkErr;
    }
    return null;
  }
}

export function buildRestartAnnouncement(
  group: InterruptedGroup,
  signal: string,
): string {
  const verb =
    group.status === 'processing' ? 'was being processed' : 'was queued';
  return `⚠️ Service restarted (${signal}). A task in **${group.groupName}** ${verb} and may have been interrupted. Please re-send if needed.`;
}
