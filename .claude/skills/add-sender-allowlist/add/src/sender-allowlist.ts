import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export const SENDER_ALLOWLIST_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  deny?: string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
  failMode: 'open' | 'closed';
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
  failMode: 'open',
};

const DENY_ALL_CONFIG: SenderAllowlistConfig = {
  default: { allow: [], mode: 'drop' },
  chats: {},
  logDenied: true,
  failMode: 'closed',
};

let _cachedPath: string | null = null;
let _cachedConfig: SenderAllowlistConfig | null = null;
let _cachedMtime = -1;

export function loadSenderAllowlist(pathOverride?: string): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    // File doesn't exist — treat as allow all (failMode: open default)
    _cachedPath = filePath;
    _cachedConfig = DEFAULT_CONFIG;
    _cachedMtime = 0;
    return DEFAULT_CONFIG;
  }

  if (_cachedConfig && _cachedPath === filePath && mtime === _cachedMtime) {
    return _cachedConfig;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.warn({ err, filePath }, 'sender-allowlist: failed to read config, treating as allow all');
    _cachedPath = filePath;
    _cachedConfig = DEFAULT_CONFIG;
    _cachedMtime = mtime;
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const failMode: 'open' | 'closed' = /"failMode"\s*:\s*"closed"/.test(raw)
      ? 'closed'
      : 'open';
    if (failMode === 'closed') {
      logger.error(
        { err, filePath },
        'sender-allowlist: invalid JSON; failMode=closed so denying all senders',
      );
      _cachedPath = filePath;
      _cachedConfig = DENY_ALL_CONFIG;
      _cachedMtime = mtime;
      return DENY_ALL_CONFIG;
    }
    logger.warn(
      { err, filePath },
      'sender-allowlist: invalid JSON; failMode=open so allowing all senders',
    );
    _cachedPath = filePath;
    _cachedConfig = DEFAULT_CONFIG;
    _cachedMtime = mtime;
    return DEFAULT_CONFIG;
  }

  const cfg = parsed as Partial<SenderAllowlistConfig>;
  const failMode: 'open' | 'closed' =
    cfg.failMode === 'closed' ? 'closed' : 'open';
  const defaultEntry = normalizeEntry(cfg.default);

  if (!defaultEntry) {
    if (failMode === 'closed') {
      logger.error(
        { filePath },
        'sender-allowlist: invalid config schema; failMode=closed so denying all senders',
      );
      _cachedPath = filePath;
      _cachedConfig = DENY_ALL_CONFIG;
      _cachedMtime = mtime;
      return DENY_ALL_CONFIG;
    }
    logger.warn(
      { filePath },
      'sender-allowlist: invalid config schema; failMode=open so allowing all senders',
    );
    _cachedPath = filePath;
    _cachedConfig = DEFAULT_CONFIG;
    _cachedMtime = mtime;
    return DEFAULT_CONFIG;
  }

  const normalized: SenderAllowlistConfig = {
    default: defaultEntry,
    chats: {},
    logDenied: cfg.logDenied !== false,
    failMode,
  };

  if (cfg.chats && typeof cfg.chats === 'object') {
    for (const [jid, entry] of Object.entries(cfg.chats)) {
      const norm = normalizeEntry(entry);
      if (!norm) {
        if (failMode === 'closed') {
          logger.error(
            { filePath, chatJid: jid },
            'sender-allowlist: invalid chat config; failMode=closed so denying all senders',
          );
          _cachedPath = filePath;
          _cachedConfig = DENY_ALL_CONFIG;
          _cachedMtime = mtime;
          return DENY_ALL_CONFIG;
        }
        logger.warn(
          { filePath, chatJid: jid },
          'sender-allowlist: invalid chat config ignored due to failMode=open',
        );
        continue;
      }
      normalized.chats[jid] = norm;
    }
  }

  _cachedPath = filePath;
  _cachedConfig = normalized;
  _cachedMtime = mtime;
  return normalized;
}

function normalizeEntry(entry: unknown): ChatAllowlistEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Partial<ChatAllowlistEntry>;
  const allow =
    e.allow === '*'
      ? '*'
      : Array.isArray(e.allow) && e.allow.every((s) => typeof s === 'string')
        ? e.allow
        : null;
  if (allow === null) return null;
  const deny =
    Array.isArray((e as Record<string, unknown>).deny) &&
    ((e as Record<string, unknown>).deny as unknown[]).every((s) => typeof s === 'string')
      ? ((e as Record<string, unknown>).deny as string[])
      : undefined;
  const mode: 'trigger' | 'drop' = e.mode === 'drop' ? 'drop' : 'trigger';
  return { allow, deny, mode };
}

function getEntry(chatJid: string, cfg: SenderAllowlistConfig): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(chatJid: string, sender: string, cfg: SenderAllowlistConfig): boolean {
  const entry = getEntry(chatJid, cfg);
  // Deny list takes priority: if sender is in deny, block regardless of allow
  if (entry.deny && entry.deny.includes(sender)) return false;
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(chatJid: string, cfg: SenderAllowlistConfig): boolean {
  const entry = getEntry(chatJid, cfg);
  return entry.mode === 'drop';
}

export function isTriggerAllowed(chatJid: string, sender: string, cfg: SenderAllowlistConfig): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug({ chatJid, sender }, 'sender-allowlist: trigger denied for sender');
  }
  return allowed;
}
