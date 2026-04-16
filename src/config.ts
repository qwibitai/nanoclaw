import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'EMAIL_INTELLIGENCE_ENABLED',
  'SUPERPILOT_API_URL',
  'NANOCLAW_SERVICE_TOKEN',
  'DAILY_BUDGET_USD',
  'WEBHOOK_PORT',
  'WEBHOOK_SECRET',
  'QDRANT_URL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
export const ONECLI_API_KEY =
  process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const SUPERPILOT_MCP_URL =
  process.env.SUPERPILOT_MCP_URL || 'http://host.docker.internal:8100';
export const SUPERPILOT_API_URL =
  process.env.SUPERPILOT_API_URL ||
  envConfig.SUPERPILOT_API_URL ||
  'https://app.inboxsuperpilot.com/api';
export const NANOCLAW_SERVICE_TOKEN =
  process.env.NANOCLAW_SERVICE_TOKEN || envConfig.NANOCLAW_SERVICE_TOKEN || '';

/**
 * Parsed list of SSE connections for email intelligence.
 * Supports comma-separated tokens in NANOCLAW_SERVICE_TOKEN, each optionally
 * labeled with @label (e.g. "tok1@primary,tok2@dev"). Unlabeled tokens get
 * "default" / "connection-N" labels.
 */
export const SSE_CONNECTIONS: { token: string; label: string }[] = (() => {
  const raw =
    process.env.NANOCLAW_SERVICE_TOKEN ||
    envConfig.NANOCLAW_SERVICE_TOKEN ||
    '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const atIdx = entry.indexOf('@');
      if (atIdx > 0) {
        return { token: entry.slice(0, atIdx), label: entry.slice(atIdx + 1) };
      }
      return { token: entry, label: i === 0 ? 'default' : `connection-${i}` };
    });
})();
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const WARM_POOL_SIZE = Math.max(
  0,
  parseInt(process.env.WARM_POOL_SIZE || '2', 10) || 2,
);
export const WARM_POOL_IDLE_TIMEOUT = parseInt(
  process.env.WARM_POOL_IDLE_TIMEOUT || '600000',
  10,
); // 10 minutes default

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

export const DAILY_BUDGET_USD = parseFloat(
  envConfig.DAILY_BUDGET_USD || process.env.DAILY_BUDGET_USD || '50',
);

export const TRUST_GATEWAY_PORT = parseInt(
  process.env.TRUST_GATEWAY_PORT || '10255',
  10,
);
export const TRUST_GATEWAY_URL =
  process.env.TRUST_GATEWAY_URL ||
  `http://host.docker.internal:${TRUST_GATEWAY_PORT}`;

export const EMAIL_INTELLIGENCE_ENABLED =
  (process.env.EMAIL_INTELLIGENCE_ENABLED ??
    envConfig.EMAIL_INTELLIGENCE_ENABLED ??
    'true') !== 'false';

export const WEBHOOK_PORT = parseInt(
  process.env.WEBHOOK_PORT || envConfig.WEBHOOK_PORT || '0',
  10,
);
export const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || envConfig.WEBHOOK_SECRET || '';

export const QDRANT_URL = process.env.QDRANT_URL || envConfig.QDRANT_URL || '';

// Telegram Mini App: public HTTPS URL that Telegram can open.
// Must point to the Mini App Express server (default local port 3847).
// Typically exposed via Cloudflare tunnel.
export const MINI_APP_URL = process.env.MINI_APP_URL || '';

// Browser sidecar settings
export const BROWSER_CDP_URL =
  process.env.BROWSER_CDP_URL || 'http://localhost:9223';
export const BROWSER_MAX_CONTEXTS = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_CONTEXTS || '5', 10) || 5,
);
export const BROWSER_MAX_PAGES = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_PAGES || '2', 10) || 2,
);
export const BROWSER_IDLE_TIMEOUT_MS =
  parseInt(process.env.BROWSER_IDLE_TIMEOUT || '600000', 10) || 600_000;
export const BROWSER_ACQUIRE_TIMEOUT_MS =
  parseInt(process.env.BROWSER_ACQUIRE_TIMEOUT || '30000', 10) || 30_000;
export const BROWSER_PROFILE_DIR = 'browser';

// Calendar poller settings
export const CALENDAR_POLL_INTERVAL = parseInt(
  process.env.CALENDAR_POLL_INTERVAL || '300000',
  10,
);
export const CALENDAR_LOOKAHEAD_MS = parseInt(
  process.env.CALENDAR_LOOKAHEAD_MS || '86400000',
  10,
);
export const CALENDAR_HOLD_BUFFER_MS = parseInt(
  process.env.CALENDAR_HOLD_BUFFER_MS || '300000',
  10,
);
export const DELEGATION_GUARDRAIL_COUNT = parseInt(
  process.env.DELEGATION_GUARDRAIL_COUNT || '10',
  10,
);
export const PROACTIVE_SUGGESTION_INTERVAL = parseInt(
  process.env.PROACTIVE_SUGGESTION_INTERVAL || '900000',
  10,
);
export const PROACTIVE_LOOKAHEAD_MS = parseInt(
  process.env.PROACTIVE_LOOKAHEAD_MS || '14400000',
  10,
);
export const PROACTIVE_MIN_GAP_MS = parseInt(
  process.env.PROACTIVE_MIN_GAP_MS || '300000',
  10,
);

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  weekendMode: boolean;
  escalateOverride: boolean;
}

export interface ChatInterfaceConfig {
  morningDashboardTime: string;
  digestThreshold: number;
  digestMinIntervalMs: number;
  staleAfterDigestCycles: number;
  pushRateLimit: number;
  pushRateWindowMs: number;
  vipList: string[];
  urgencyKeywords: string[];
  holdPushDuringMeetings: boolean;
  microBriefingDelayMs: number;
  quietHours: QuietHoursConfig;
}

export const CHAT_INTERFACE_CONFIG: ChatInterfaceConfig = {
  morningDashboardTime: process.env.MORNING_DASHBOARD_TIME || '07:30',
  digestThreshold: parseInt(process.env.DIGEST_THRESHOLD || '5', 10),
  digestMinIntervalMs: parseInt(
    process.env.DIGEST_MIN_INTERVAL_MS || '7200000',
    10,
  ),
  staleAfterDigestCycles: parseInt(
    process.env.STALE_AFTER_DIGEST_CYCLES || '2',
    10,
  ),
  pushRateLimit: parseInt(process.env.PUSH_RATE_LIMIT || '3', 10),
  pushRateWindowMs: parseInt(process.env.PUSH_RATE_WINDOW_MS || '1800000', 10),
  vipList: process.env.VIP_LIST
    ? process.env.VIP_LIST.split(',').map((s) => s.trim())
    : [],
  urgencyKeywords: (
    process.env.URGENCY_KEYWORDS || 'urgent,deadline,asap,blocking'
  )
    .split(',')
    .map((s) => s.trim()),
  holdPushDuringMeetings: process.env.HOLD_PUSH_DURING_MEETINGS !== 'false',
  microBriefingDelayMs: parseInt(
    process.env.MICRO_BRIEFING_DELAY_MS || '60000',
    10,
  ),
  quietHours: {
    enabled: process.env.QUIET_HOURS_ENABLED !== 'false',
    start: process.env.QUIET_HOURS_START || '22:00',
    end: process.env.QUIET_HOURS_END || '07:00',
    weekendMode: process.env.QUIET_HOURS_WEEKEND !== 'false',
    escalateOverride: process.env.QUIET_HOURS_ESCALATE_OVERRIDE !== 'false',
  },
};
