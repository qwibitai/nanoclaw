import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'ghcr.io/tiagojmartins/nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '300000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

// Detect container runtime: prefer podman, fall back to docker
function detectContainerRuntime(): string {
  for (const runtime of ['podman', 'docker']) {
    try {
      execSync(`${runtime} --version`, { stdio: 'pipe' });
      return runtime;
    } catch {
      // not available, try next
    }
  }
  throw new Error(
    'No container runtime found. Install Podman or Docker and ensure it is on PATH.',
  );
}

export const CONTAINER_RUNTIME = detectContainerRuntime();

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Pushover notifications (optional)
export const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY;
export const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN;
export const PUSHOVER_ENABLED = !!(PUSHOVER_USER_KEY && PUSHOVER_APP_TOKEN);
export const PUSHOVER_DEVICE = process.env.PUSHOVER_DEVICE; // Target specific device (optional)
export const PUSHOVER_PRIORITY = parseInt(
  process.env.PUSHOVER_PRIORITY || '0',
  10,
) as -2 | -1 | 0 | 1 | 2;
export const PUSHOVER_ERROR_PRIORITY = parseInt(
  process.env.PUSHOVER_ERROR_PRIORITY || '1',
  10,
) as -2 | -1 | 0 | 1 | 2;

// iCloud Calendar (optional, main channel only)
export const ICLOUD_USERNAME = process.env.ICLOUD_USERNAME;
export const ICLOUD_APP_PASSWORD = process.env.ICLOUD_APP_PASSWORD;
export const ICLOUD_CALENDAR_ENABLED = !!(
  ICLOUD_USERNAME && ICLOUD_APP_PASSWORD
);
export const ICLOUD_CALENDARS = process.env.ICLOUD_CALENDARS; // Comma-separated calendar names to enable (optional, all if not set)

// Telegram bot (optional)
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_ENABLED = !!TELEGRAM_BOT_TOKEN;
export const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID;
export const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

// Email channel (optional)
import type { EmailConfig } from './types.js';

export const EMAIL_ENABLED = process.env.EMAIL_ENABLED === 'true';

export const EMAIL_CONFIG: EmailConfig | null = EMAIL_ENABLED
  ? {
      imap: {
        host: process.env.EMAIL_IMAP_HOST || 'imap.fastmail.com',
        port: parseInt(process.env.EMAIL_IMAP_PORT || '993', 10),
        auth: {
          user: process.env.EMAIL_USER || '',
          pass: process.env.EMAIL_PASS || '',
        },
        tls: true,
      },
      address: process.env.EMAIL_ADDRESS || '',
      monitoredFolders: (process.env.EMAIL_FOLDERS || 'INBOX')
        .split(',')
        .map((f) => f.trim()),
      draftsFolder: process.env.EMAIL_DRAFTS_FOLDER || 'Drafts',
      fromName: process.env.EMAIL_FROM_NAME || ASSISTANT_NAME,
    }
  : null;
