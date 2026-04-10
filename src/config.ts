import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SIGNAL_PHONE_NUMBER',
  'TRIGGER_WORD',
  'WN_ACCOUNT_PUBKEY',
  'NOSTR_DM_ALLOWLIST',
  'NOSTR_DM_RELAYS',
  'NOSTR_SIGNER_SOCKET',
  'MCP_SERVER_ENABLED',
  'ONECLI_URL',
  'TZ',
  'WATCH_AUTH_TOKEN',
  'WATCH_HTTP_PORT',
  'WATCH_HTTP_BIND',
  'WATCH_JID',
  'WATCH_GROUP_FOLDER',
  'WATCH_SYNC_TIMEOUT_MS',
  'WATCH_SIGNAL_MIRROR_JID',
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
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://localhost:10254';
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
  // Signal stores U+FFFC as a mention placeholder. For new messages these are
  // resolved in SignalChannel, but historical DB records may still contain them.
  // Treat a leading U+FFFC as "@TriggerWord" for backwards compatibility.
  const trimmed = content.replace(/^\uFFFC\s*/, `@${TRIGGER_WORD} `).trim();
  if (trimmed.startsWith('[Voice:')) return VOICE_MENTION_PATTERN.test(trimmed);
  if (TRIGGER_PATTERN.test(trimmed)) return true;
  // Signal users may @mention the assistant by phone number instead of name
  // (e.g., "@+15102143647" rather than "@Jorgenclaw"). Match both forms.
  if (SIGNAL_PHONE_NUMBER && /^@\+?\d/.test(trimmed)) {
    const digits = SIGNAL_PHONE_NUMBER.replace(/^\+/, '');
    if (trimmed.startsWith(`@+${digits}`) || trimmed.startsWith(`@${digits}`)) {
      return true;
    }
  }
  return false;
}

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

export const SIGNAL_PHONE_NUMBER =
  process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST =
  process.env.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = parseInt(
  process.env.SIGNAL_CLI_TCP_PORT || '7583',
  10,
);

// White Noise (Nostr/MLS encrypted messaging)
export const WN_BINARY_PATH =
  process.env.WN_BINARY_PATH ||
  path.join(HOME_DIR, 'whitenoise-rs', 'target', 'release', 'wn');
export const WN_SOCKET_PATH =
  process.env.WN_SOCKET_PATH ||
  path.join(
    HOME_DIR,
    '.local',
    'share',
    'whitenoise-cli',
    'release',
    'wnd.sock',
  );
export const WN_ACCOUNT_PUBKEY =
  process.env.WN_ACCOUNT_PUBKEY || envConfig.WN_ACCOUNT_PUBKEY || '';

// Nostr DM channel (NIP-17 private direct messages)
export const NOSTR_SIGNER_SOCKET =
  process.env.NOSTR_SIGNER_SOCKET ||
  envConfig.NOSTR_SIGNER_SOCKET ||
  `${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}/nostr-signer.sock`;
export const NOSTR_DM_RELAYS = (
  process.env.NOSTR_DM_RELAYS ||
  envConfig.NOSTR_DM_RELAYS ||
  'wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social'
)
  .split(',')
  .filter(Boolean);
export const NOSTR_DM_ALLOWLIST = (
  process.env.NOSTR_DM_ALLOWLIST ||
  envConfig.NOSTR_DM_ALLOWLIST ||
  ''
)
  .split(',')
  .filter(Boolean);

// Paid MCP Server
export const MCP_SERVER_ENABLED =
  (process.env.MCP_SERVER_ENABLED || envConfig.MCP_SERVER_ENABLED) === 'true';

// Proton Pass CLI
export const PROTON_PASS_BIN =
  process.env.PROTON_PASS_BIN ||
  path.join(HOME_DIR, '.local', 'bin', 'pass-cli');
export const PROTON_PASS_VAULT = process.env.PROTON_PASS_VAULT || 'NanoClaw';

// NanoClaw Watch — HTTP endpoint for the T-Watch S3 firmware.
// Channel is opt-in: if WATCH_AUTH_TOKEN is empty, the factory returns null
// and no HTTP server is started. Secrets are loaded via readEnvFile (which
// parses .env without polluting process.env) to prevent leaking to containers.
export const WATCH_AUTH_TOKEN =
  process.env.WATCH_AUTH_TOKEN || envConfig.WATCH_AUTH_TOKEN || '';
export const WATCH_HTTP_PORT = parseInt(
  process.env.WATCH_HTTP_PORT || envConfig.WATCH_HTTP_PORT || '3000',
  10,
);
export const WATCH_HTTP_BIND =
  process.env.WATCH_HTTP_BIND || envConfig.WATCH_HTTP_BIND || '0.0.0.0';
export const WATCH_JID =
  process.env.WATCH_JID || envConfig.WATCH_JID || 'watch:scott';
export const WATCH_GROUP_FOLDER =
  process.env.WATCH_GROUP_FOLDER || envConfig.WATCH_GROUP_FOLDER || 'main';
// Sync reply window — how long the watch's HTTP POST is held open waiting for
// the container agent's response. A cold container spawn + agent think takes
// ~15–25 sec in practice, so 12s was too short and most replies fell through
// to the slower poll queue (60s polling interval). 45s gives a comfortable
// margin and still keeps the watch's HTTP client within its own timeout.
export const WATCH_SYNC_TIMEOUT_MS = parseInt(
  process.env.WATCH_SYNC_TIMEOUT_MS ||
    envConfig.WATCH_SYNC_TIMEOUT_MS ||
    '45000',
  10,
);
// Optional: mirror watch conversations to a Signal JID so Scott can read them
// on his phone in addition to the wrist. Off by default — set to a Signal JID
// (e.g. 'signal:198c1cdb-...') to enable. Two messages per exchange:
//   "⌚ [Watch] Scott: <transcribed text>"   (from handleMessage)
//   "↳ <agent reply>"                        (from sendMessage)
// Both fast-path and slow-path replies get mirrored.
export const WATCH_SIGNAL_MIRROR_JID =
  process.env.WATCH_SIGNAL_MIRROR_JID ||
  envConfig.WATCH_SIGNAL_MIRROR_JID ||
  '';

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

// Security policy: stored OUTSIDE project root, never mounted into containers
export const SECURITY_POLICY_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'security-policy.json',
);
