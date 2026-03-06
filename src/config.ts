import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

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
export const MAIN_GROUP_FOLDER = 'main';

export type RuntimeProfile = 'mission_core' | 'ops_extended';

const rawRuntimeProfile = (process.env.NANOCLAW_RUNTIME_PROFILE || 'mission_core')
  .trim()
  .toLowerCase();
export const RUNTIME_PROFILE: RuntimeProfile = rawRuntimeProfile === 'ops_extended'
  ? 'ops_extended'
  : 'mission_core';
export const RUNTIME_OPS_EXTENDED = RUNTIME_PROFILE === 'ops_extended';

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true';
}

// Mission-core defaults: keep execution path minimal; opt into extended ops features.
export const ENABLE_SCHEDULER = envBool(
  process.env.NANOCLAW_ENABLE_SCHEDULER,
  RUNTIME_OPS_EXTENDED,
);
export const ENABLE_WORKER_STEERING = envBool(
  process.env.NANOCLAW_ENABLE_WORKER_STEERING,
  RUNTIME_OPS_EXTENDED,
);
export const ENABLE_DYNAMIC_GROUP_REGISTRATION = envBool(
  process.env.NANOCLAW_ENABLE_DYNAMIC_GROUP_REGISTRATION,
  RUNTIME_OPS_EXTENDED,
);
export const ENABLE_CONTROL_PLANE_SNAPSHOTS = envBool(
  process.env.NANOCLAW_ENABLE_CONTROL_PLANE_SNAPSHOTS,
  RUNTIME_OPS_EXTENDED,
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const WORKER_CONTAINER_IMAGE =
  process.env.WORKER_CONTAINER_IMAGE || 'nanoclaw-worker:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_NO_OUTPUT_TIMEOUT = parseInt(
  process.env.CONTAINER_NO_OUTPUT_TIMEOUT || '720000',
  10,
);
export const WORKER_MIN_NO_OUTPUT_TIMEOUT_MS = parseInt(
  process.env.WORKER_MIN_NO_OUTPUT_TIMEOUT_MS || '900000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
// Local: container resource limits
export const CONTAINER_PARSE_BUFFER_LIMIT = parseInt(
  process.env.CONTAINER_PARSE_BUFFER_LIMIT || '1048576',
  10,
); // 1MB default - prevents unbounded memory growth if markers are malformed
export const CONTAINER_CPU_LIMIT =
  process.env.CONTAINER_CPU_LIMIT || '2';
export const CONTAINER_MEMORY_LIMIT =
  process.env.CONTAINER_MEMORY_LIMIT || '4096M';
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '300000', 10); // 5min default — close stdin after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const WA_RECONNECT_BASE_DELAY_MS = parseInt(
  process.env.WA_RECONNECT_BASE_DELAY_MS || '1000',
  10,
);
export const WA_RECONNECT_MAX_DELAY_MS = parseInt(
  process.env.WA_RECONNECT_MAX_DELAY_MS || '30000',
  10,
);
export const WA_RECONNECT_JITTER_MS = parseInt(
  process.env.WA_RECONNECT_JITTER_MS || '750',
  10,
);
export const WA_RECONNECT_BURST_WINDOW_MS = parseInt(
  process.env.WA_RECONNECT_BURST_WINDOW_MS || '600000',
  10,
);
export const WA_RECONNECT_BURST_THRESHOLD = parseInt(
  process.env.WA_RECONNECT_BURST_THRESHOLD || '15',
  10,
);
export const WA_RECONNECT_COOLDOWN_MS = parseInt(
  process.env.WA_RECONNECT_COOLDOWN_MS || '60000',
  10,
);
export const SHUTDOWN_DRAIN_MS = parseInt(
  process.env.SHUTDOWN_DRAIN_MS || '600000',
  10,
);
export const ANDY_BUSY_PREEMPT_MS = parseInt(
  process.env.ANDY_BUSY_PREEMPT_MS || '90000',
  10,
);
export const ANDY_BUSY_ACK_COOLDOWN_MS = parseInt(
  process.env.ANDY_BUSY_ACK_COOLDOWN_MS || '180000',
  10,
);
export const ANDY_ERROR_NOTICE_COOLDOWN_MS = parseInt(
  process.env.ANDY_ERROR_NOTICE_COOLDOWN_MS || '180000',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const EVENT_BRIDGE_URL =
  process.env.EVENT_BRIDGE_URL || 'http://localhost:9851/events';
export const EVENT_BRIDGE_ENABLED = envBool(
  process.env.EVENT_BRIDGE_ENABLED,
  RUNTIME_OPS_EXTENDED,
);
