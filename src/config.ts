import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'DISCORD_REACTIONS_INBOUND',
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
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const DM_SESSION_TTL = parseInt(
  process.env.DM_SESSION_TTL || String(12 * 60 * 60 * 1000),
  10,
); // 12h default — DM sessions older than this start fresh
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  // Strip any leading @ from the configured trigger, then match it with an
  // OPTIONAL leading @ so users can address the bot either way:
  //   "@Claudio do the thing"  — explicit prefix
  //   "Claudio do the thing"   — bare name
  // This matches how humans naturally address the bot in Discord.
  const name = trigger.trim().replace(/^@+/, '');
  return new RegExp(`^@?${escapeRegex(name)}\\b`, 'i');
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

// Discord inbound reactions mode:
//   'all' — forward reactions on any message in registered channels
//   'own' — only forward reactions on messages the bot sent (default, low noise)
//   'off' — disable inbound reactions entirely
function resolveReactionsMode(): 'all' | 'own' | 'off' {
  const raw = (
    process.env.DISCORD_REACTIONS_INBOUND ||
    envConfig.DISCORD_REACTIONS_INBOUND ||
    'own'
  ).toLowerCase();
  if (raw === 'all' || raw === 'own' || raw === 'off') return raw;
  return 'own';
}
export const DISCORD_REACTIONS_INBOUND = resolveReactionsMode();

// Pet identities for webhook-based pet voices.
// When an agent sends a message with sender matching a key here,
// the message is sent via Discord webhook with the pet's display name.
export const PET_IDENTITIES: Record<string, { name: string; avatar?: string }> =
  {
    Voss: {
      name: 'Voss 🌋',
      avatar:
        'https://cdn.discordapp.com/attachments/1491554631413665872/1492346511525412955/image.png?ex=69daff7e&is=69d9adfe&hm=5f2469c5d3b10088478539899c65f1fb7c7feaff8dfb6493f44bc7d08262430b&',
    },
    Nyx: {
      name: 'Nyx 🌙',
      avatar:
        'https://cdn.discordapp.com/attachments/1491554631413665872/1492348804010213426/image.png?ex=69db01a1&is=69d9b021&hm=2e4ed22ac6ebaa2f48588ffc2788bf6e550ab1cd3f2374d64ac306e3bdf310c5&',
    },
    Zima: {
      name: 'Zima ❄️',
      avatar:
        'https://cdn.discordapp.com/attachments/1491554631413665872/1492348630244392990/image.png?ex=69db0177&is=69d9aff7&hm=c2f259ceb5b9e1095a5fea3b8bde3c19493627ee53f13f3030532801ec35f8b7&',
    },
  };
