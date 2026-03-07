import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SIGNAL_PHONE_NUMBER',
  'TRIGGER_WORD',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const TRIGGER_WORD =
  process.env.TRIGGER_WORD || envConfig.TRIGGER_WORD || ASSISTANT_NAME;
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
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(TRIGGER_WORD)}\\b`,
  'i',
);

// For voice notes stored as "[Voice: ...]", the transcript may mention the
// assistant anywhere. Whisper transcribes "at Jorgenclaw" as plain text, not
// "@Jorgenclaw", so we match both forms: "@Jorgenclaw" and "at Jorgenclaw".
const VOICE_MENTION_PATTERN = new RegExp(
  `(^|\\b)(at\\s+|@)${escapeRegex(TRIGGER_WORD)}\\b`,
  'i',
);

export function messageHasTrigger(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.startsWith('[Voice:')) return VOICE_MENTION_PATTERN.test(trimmed);
  return TRIGGER_PATTERN.test(trimmed);
}

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const SIGNAL_PHONE_NUMBER =
  process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST =
  process.env.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = parseInt(
  process.env.SIGNAL_CLI_TCP_PORT || '7583',
  10,
);

// Local Whisper transcription (whisper-cli from whisper.cpp)
// Set WHISPER_BIN to empty string to disable and fall back to OpenAI only.
export const WHISPER_BIN =
  process.env.WHISPER_BIN !== undefined
    ? process.env.WHISPER_BIN
    : path.join(HOME_DIR, '.local', 'bin', 'whisper-cli');
export const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(
    HOME_DIR,
    '.local',
    'share',
    'whisper',
    'models',
    'ggml-base.en.bin',
  );
