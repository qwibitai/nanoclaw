import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Omni';
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY = process.env.TELEGRAM_ONLY === 'true';
export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

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
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const CONTAINER_STARTUP_TIMEOUT = parseInt(
  process.env.CONTAINER_STARTUP_TIMEOUT || '120000',
  10,
); // 2min — kill container if zero stderr output (stuck initialization)
export const SESSION_MAX_AGE = parseInt(
  process.env.SESSION_MAX_AGE || '14400000',
  10,
); // 4 hours — rotate sessions to prevent unbounded context growth
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const MAX_TASK_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_TASK_CONTAINERS || String(MAX_CONCURRENT_CONTAINERS - 1), 10),
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

// Sprites cloud backend configuration
export const SPRITES_TOKEN = process.env.SPRITES_TOKEN || '';
export const SPRITES_ORG = process.env.SPRITES_ORG || '';
export const SPRITES_REGION = process.env.SPRITES_REGION || '';
export const SPRITES_RAM_MB = parseInt(process.env.SPRITES_RAM_MB || '0', 10) || 0;

// Daytona cloud backend configuration
export const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY || '';
export const DAYTONA_API_URL = process.env.DAYTONA_API_URL || '';
export const DAYTONA_SNAPSHOT = process.env.DAYTONA_SNAPSHOT || '';

// B2 (Backblaze S3) storage bus configuration
export const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
export const B2_ACCESS_KEY_ID = process.env.B2_ACCESS_KEY_ID || '';
export const B2_SECRET_ACCESS_KEY = process.env.B2_SECRET_ACCESS_KEY || '';
export const B2_BUCKET = process.env.B2_BUCKET || '';
export const B2_REGION = process.env.B2_REGION || '';

// Railway cloud backend configuration
export const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || '';

// Hetzner Cloud
export const HETZNER_API_TOKEN = process.env.HETZNER_API_TOKEN || '';
export const HETZNER_LOCATION = process.env.HETZNER_LOCATION || 'ash'; // Ashburn, US
export const HETZNER_SERVER_TYPE = process.env.HETZNER_SERVER_TYPE || 'cpx11'; // 2 vCPU, 2GB RAM
export const HETZNER_IMAGE = process.env.HETZNER_IMAGE || 'ubuntu-22.04';
