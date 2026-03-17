import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
  /** Senders who auto-trigger the agent without needing the @trigger prefix. */
  autoTriggerSenders: string[];
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
  autoTriggerSenders: [],
};

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return DEFAULT_CONFIG;
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  const autoTriggerSenders: string[] = [];
  if (Array.isArray(obj.autoTriggerSenders)) {
    for (const s of obj.autoTriggerSenders) {
      if (typeof s === 'string') autoTriggerSenders.push(s);
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
    autoTriggerSenders,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

/**
 * Common acknowledgment patterns that don't need an agent response.
 * Matches the normalized (trimmed, lowercased) message content.
 */
const ACK_PATTERNS =
  /^(ok|okay|k|kk|yep|yup|yes|no|nope|sure|thanks|thank you|thx|ty|cool|great|nice|got it|noted|lol|haha|hah|ha|👍|👌|🙏|❤️|💯|✅|☑️|🤙|💪|🔥|😊|😂|🤣|👏|🫡|😎|🤷|right|alright|ack|np|nw|good|fine|perfect|done|ikr|sounds good|will do|on it|roger|aight)$/;

/** Minimum content length for auto-trigger (after trimming). */
const AUTO_TRIGGER_MIN_LENGTH = 3;

/**
 * Check if message content is substantive enough to warrant auto-triggering.
 * Filters out short acknowledgments and emoji-only messages.
 */
export function isAutoTriggerContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < AUTO_TRIGGER_MIN_LENGTH) return false;
  const normalized = trimmed.toLowerCase();
  if (ACK_PATTERNS.test(normalized)) return false;
  return true;
}

/**
 * Check if a sender is in the autoTriggerSenders list.
 * Auto-trigger senders activate the agent without needing the @trigger prefix.
 */
export function isAutoTriggerSender(
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return cfg.autoTriggerSenders.includes(sender);
}

/**
 * Check if a message from an auto-trigger sender should actually trigger the agent.
 * Combines sender check with content filter to skip trivial messages.
 */
export function shouldAutoTrigger(
  sender: string,
  content: string,
  cfg: SenderAllowlistConfig,
): boolean {
  if (!isAutoTriggerSender(sender, cfg)) return false;
  return isAutoTriggerContent(content);
}
