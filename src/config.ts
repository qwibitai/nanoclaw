import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'BACKUP_ENABLED',
  'BACKUP_BACKENDS',
  'BACKUP_LOCAL_DIR',
  'BACKUP_HOUR',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_PREFIX',
  'BACKUP_S3_REGION',
  'BACKUP_S3_SSE',
  'BACKUP_S3_ACCESS_KEY_ID',
  'BACKUP_S3_SECRET_ACCESS_KEY',
  'BACKUP_S3_SESSION_TOKEN',
]);

function envValue(key: string): string | undefined {
  return process.env[key] || envConfig[key];
}

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

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
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// ── Backup configuration ──────────────────────────────────────────────────

export const BACKUP_ENABLED = (envValue('BACKUP_ENABLED') ?? 'true') !== 'false';

const rawBackends = (envValue('BACKUP_BACKENDS') ?? 'local')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const BACKUP_BACKENDS: ReadonlyArray<'local' | 's3'> = rawBackends.filter(
  (b): b is 'local' | 's3' => b === 'local' || b === 's3',
);

export const BACKUP_LOCAL_DIR =
  envValue('BACKUP_LOCAL_DIR') || path.join(HOME_DIR, 'Backups', 'nanoclaw', INSTALL_SLUG);

const parsedBackupHour = parseInt(envValue('BACKUP_HOUR') ?? '4', 10);
export const BACKUP_HOUR =
  Number.isFinite(parsedBackupHour) && parsedBackupHour >= 0 && parsedBackupHour <= 23 ? parsedBackupHour : 4;

export const BACKUP_S3_BUCKET = envValue('BACKUP_S3_BUCKET');
export const BACKUP_S3_PREFIX = envValue('BACKUP_S3_PREFIX') || INSTALL_SLUG;
export const BACKUP_S3_REGION = envValue('BACKUP_S3_REGION');
export const BACKUP_S3_SSE = envValue('BACKUP_S3_SSE') ?? 'AES256';
export const BACKUP_S3_ACCESS_KEY_ID = envValue('BACKUP_S3_ACCESS_KEY_ID');
export const BACKUP_S3_SECRET_ACCESS_KEY = envValue('BACKUP_S3_SECRET_ACCESS_KEY');
export const BACKUP_S3_SESSION_TOKEN = envValue('BACKUP_S3_SESSION_TOKEN');

// Marker file lives outside DATA_DIR so a project restore doesn't roll the
// backup clock back and force an immediate redundant backup.
export const BACKUP_STATUS_FILE = path.join(HOME_DIR, '.config', 'nanoclaw', 'backup-status.json');
