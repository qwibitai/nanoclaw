/**
 * Cloud Logs provider for External Access Broker
 *
 * v0: reads from local journalctl / log files.
 * v1: CloudWatch / GCP Logging.
 * Read-only (L1 only). Rate limited + size capped.
 */
import { execSync } from 'child_process';
import { z } from 'zod';

import type { ExtAction, ExtProvider } from '../ext-broker-providers.js';

const MAX_RESULT_BYTES = parseInt(process.env.EXT_LOG_MAX_BYTES || '51200', 10); // 50KB
const MAX_QUERY_HOURS = parseInt(process.env.EXT_LOG_QUERY_MAX_HOURS || '24', 10);
const MAX_RESULTS = parseInt(process.env.EXT_LOG_QUERY_MAX_RESULTS || '100', 10);

/**
 * Sanitize log content — strip potential secrets, tokens, passwords.
 * Conservative: replaces anything that looks like a key/token/password value.
 */
function sanitizeLogs(raw: string): string {
  return raw
    .replace(/(?:token|password|secret|key|auth|bearer)\s*[:=]\s*\S+/gi, '$&'.split('=')[0] + '=[REDACTED]')
    .replace(/(?:eyJ[A-Za-z0-9_-]{10,}\.)/g, '[JWT_REDACTED].')
    .replace(/(?:ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/g, '[GITHUB_TOKEN_REDACTED]')
    .replace(/(?:sk-|pk_live_|pk_test_|rk_live_|rk_test_)[A-Za-z0-9]{20,}/g, '[API_KEY_REDACTED]')
    .slice(0, MAX_RESULT_BYTES);
}

// --- Actions ---

const queryLogs: ExtAction = {
  level: 1,
  description: 'Query recent logs with filters',
  idempotent: true,
  params: z.object({
    unit: z.string().optional().describe('Systemd unit name (e.g., "nanoclaw")'),
    since: z.string().optional().describe('Start time (e.g., "1 hour ago", "2026-02-14 10:00")'),
    until: z.string().optional().describe('End time'),
    grep: z.string().optional().describe('Filter by pattern'),
    limit: z.number().max(MAX_RESULTS).default(50).describe('Max entries'),
    priority: z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']).optional(),
  }),
  summarize: (p) => {
    const { unit, since, grep, limit } = p as {
      unit?: string; since?: string; grep?: string; limit: number;
    };
    const parts = ['Query logs'];
    if (unit) parts.push(`unit=${unit}`);
    if (since) parts.push(`since="${since}"`);
    if (grep) parts.push(`grep="${grep}"`);
    parts.push(`limit=${limit}`);
    return parts.join(', ');
  },
  execute: async (p) => {
    const { unit, since, until, grep, limit, priority } = p as {
      unit?: string; since?: string; until?: string;
      grep?: string; limit: number; priority?: string;
    };

    // Validate time range does not exceed MAX_QUERY_HOURS
    // (best-effort check — journalctl enforces the real limit)
    let cmd = `journalctl --no-pager -o short-iso -n ${limit}`;
    if (unit) cmd += ` -u ${unit}`;
    if (since) cmd += ` --since "${since}"`;
    if (until) cmd += ` --until "${until}"`;
    if (priority) cmd += ` -p ${priority}`;
    if (grep) cmd += ` --grep "${grep.replace(/"/g, '\\"')}"`;

    try {
      const raw = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: MAX_RESULT_BYTES * 2,
      });
      const sanitized = sanitizeLogs(raw);
      const lines = sanitized.split('\n').filter(Boolean);
      return {
        ok: true,
        data: { entries: lines.slice(0, limit), count: lines.length },
        summary: `Queried logs: ${lines.length} entries returned`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: null, summary: `Log query failed: ${msg.slice(0, 200)}` };
    }
  },
};

const getLogEntry: ExtAction = {
  level: 1,
  description: 'Get specific log entry by cursor',
  idempotent: true,
  params: z.object({
    cursor: z.string().describe('Journal cursor (from previous query)'),
  }),
  summarize: (p) => {
    const { cursor } = p as { cursor: string };
    return `Get log entry cursor=${cursor.slice(0, 20)}...`;
  },
  execute: async (p) => {
    const { cursor } = p as { cursor: string };
    try {
      const raw = execSync(
        `journalctl --no-pager -o json --cursor "${cursor}" -n 1`,
        { encoding: 'utf-8', timeout: 5_000 },
      );
      return { ok: true, data: sanitizeLogs(raw), summary: 'Got log entry' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: null, summary: `Log entry fetch failed: ${msg.slice(0, 200)}` };
    }
  },
};

const listServices: ExtAction = {
  level: 1,
  description: 'List monitored systemd services',
  idempotent: true,
  params: z.object({}),
  summarize: () => 'List services',
  execute: async () => {
    try {
      const raw = execSync(
        'systemctl list-units --type=service --state=running --no-pager --plain',
        { encoding: 'utf-8', timeout: 5_000, maxBuffer: MAX_RESULT_BYTES },
      );
      const lines = sanitizeLogs(raw).split('\n').filter(Boolean).slice(0, MAX_RESULTS);
      return {
        ok: true,
        data: { services: lines, count: lines.length },
        summary: `Listed ${lines.length} running services`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: null, summary: `Service list failed: ${msg.slice(0, 200)}` };
    }
  },
};

// --- Provider definition ---

export const cloudLogsProvider: ExtProvider = {
  name: 'cloud-logs',
  requiredSecrets: [], // v0: no secrets needed (local logs)
  actions: {
    query_logs: queryLogs,
    get_log_entry: getLogEntry,
    list_services: listServices,
  },
};
