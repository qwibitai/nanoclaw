/**
 * Shared context passed to every tool plugin.
 * Created once at startup from environment variables.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export const IPC_DIR = '/workspace/ipc';

export interface ToolContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  ipcDir: string;
  writeIpcFile: (dir: string, data: object) => string;
  checkRateLimit: (toolName: string) => { allowed: boolean; message: string };
  checkSpendLimit: (amountUsd: number) => { allowed: boolean; message: string };
}

// ── IPC helper ────────────────────────────────────────────────────────

export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

// ── Rate Limiter ──────────────────────────────────────────────────────

interface RateLimitState {
  count: number;
  windowStart: number;
}
const rateLimitStates: Record<string, RateLimitState> = {};

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  send_sms: { max: 10, windowMs: 3_600_000 },
  make_call: { max: 5, windowMs: 3_600_000 },
};

export function checkRateLimit(toolName: string): { allowed: boolean; message: string } {
  const limit = RATE_LIMITS[toolName];
  if (!limit) return { allowed: true, message: '' };

  const now = Date.now();
  const state = rateLimitStates[toolName];

  if (!state || now - state.windowStart >= limit.windowMs) {
    rateLimitStates[toolName] = { count: 1, windowStart: now };
    return { allowed: true, message: '' };
  }

  if (state.count >= limit.max) {
    const resetsIn = Math.ceil((limit.windowMs - (now - state.windowStart)) / 60_000);
    return {
      allowed: false,
      message: `Rate limit: ${toolName} max ${limit.max}/hour reached. Resets in ~${resetsIn} min.`,
    };
  }

  state.count++;
  return { allowed: true, message: '' };
}

// ── Spend Tracker ─────────────────────────────────────────────────────

let dailySpend = { totalUsd: 0, dayStart: Date.now() };
const DAILY_SPEND_CAP_USD = 10;

export function checkSpendLimit(amountUsd: number): { allowed: boolean; message: string } {
  const now = Date.now();
  if (now - dailySpend.dayStart >= 86_400_000) {
    dailySpend = { totalUsd: 0, dayStart: now };
  }

  if (dailySpend.totalUsd + amountUsd > DAILY_SPEND_CAP_USD) {
    return {
      allowed: false,
      message: `Daily spend cap ($${DAILY_SPEND_CAP_USD}) reached. Spent today: $${dailySpend.totalUsd.toFixed(2)}. Try again tomorrow.`,
    };
  }

  dailySpend.totalUsd += amountUsd;
  return { allowed: true, message: '' };
}

// ── SignalWire curl helper (shared by signalwire tools) ───────────────

export function swCurl(endpoint: string, method: string = 'GET', data?: string): string {
  const projectId = process.env.SIGNALWIRE_PROJECT_ID || '';
  const apiToken = process.env.SIGNALWIRE_API_TOKEN || '';
  const spaceUrl = process.env.SIGNALWIRE_SPACE_URL || '';
  const resolve = `${spaceUrl}:8443:10.99.0.2`;

  const url = `https://${spaceUrl}:8443/api/laml/2010-04-01/Accounts/${projectId}${endpoint}`;
  let cmd = `curl -s --resolve ${resolve} -X ${method} -u "${projectId}:${apiToken}" "${url}"`;
  if (data) {
    cmd += ` -d '${data}'`;
  }
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export function createToolContext(): ToolContext {
  // Env var names kept as NANOCLAW_* for backward compatibility
  const chatJid = process.env.NANOCLAW_CHAT_JID!;
  const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
  const isMain = process.env.NANOCLAW_IS_MAIN === '1';

  return {
    chatJid,
    groupFolder,
    isMain,
    ipcDir: IPC_DIR,
    writeIpcFile,
    checkRateLimit,
    checkSpendLimit,
  };
}
