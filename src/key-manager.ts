/**
 * Multi-subscription key manager for NanoClaw.
 * Manages multiple Claude Max subscription tokens and routes
 * requests through per-key credential proxies on different ports.
 *
 * Config: ~/nanoclaw/config/keys.json  (operator-managed)
 * State:  ~/nanoclaw/data/active-key.json  (runtime, auto-managed)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────

export interface KeyEntry {
  label: string;
  description: string;
  token: string;
  added_at: string; // ISO timestamp
  proxy_port: number; // credential proxy port for this key
}

export interface KeysConfig {
  keys: Record<string, KeyEntry>;
}

export interface ActiveKeyState {
  active: string; // key label
  switched_at: string; // ISO timestamp
  switched_by: string; // "operator" | "system"
}

export interface ResolvedKey {
  label: string;
  token: string;
  proxyPort: number;
}

// ── Defaults ───────────────────────────────────────────────────────

const HOME = process.env.HOME || os.homedir();
const DEFAULT_KEYS_PATH = path.join(HOME, 'nanoclaw', 'config', 'keys.json');
const DEFAULT_ACTIVE_KEY_PATH = path.join(
  HOME,
  'nanoclaw',
  'data',
  'active-key.json',
);

// ── Keys config ────────────────────────────────────────────────────

/**
 * Read and validate the multi-key config file.
 * Returns null if the file does not exist (single-key mode).
 * Throws on invalid format.
 */
export function readKeysConfig(
  configPath: string = DEFAULT_KEYS_PATH,
): KeysConfig | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }

  // Check file permissions — warn if not 600
  try {
    const stat = fs.statSync(configPath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      console.error(
        `[key-manager] WARNING: ${configPath} has permissions ${mode.toString(8)}, expected 600. ` +
          `Run: chmod 600 ${configPath}`,
      );
    }
  } catch {
    // Permission check is advisory; continue regardless
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[key-manager] Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Validate structure
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('keys' in parsed) ||
    typeof (parsed as Record<string, unknown>).keys !== 'object' ||
    (parsed as Record<string, unknown>).keys === null
  ) {
    throw new Error(
      `[key-manager] Invalid keys.json: expected { keys: { ... } }`,
    );
  }

  const config = parsed as KeysConfig;
  const entries = Object.entries(config.keys);

  if (entries.length === 0) {
    throw new Error(`[key-manager] keys.json must contain at least one key`);
  }

  for (const [id, entry] of entries) {
    if (!entry.token || typeof entry.token !== 'string') {
      throw new Error(`[key-manager] Key "${id}" has missing or empty token`);
    }
    if (!entry.proxy_port || typeof entry.proxy_port !== 'number') {
      throw new Error(
        `[key-manager] Key "${id}" has missing or invalid proxy_port`,
      );
    }
    if (!entry.label || typeof entry.label !== 'string') {
      throw new Error(`[key-manager] Key "${id}" has missing or empty label`);
    }
  }

  return config;
}

// ── Active key state ───────────────────────────────────────────────

/**
 * Read the active key state file.
 * Returns null if file does not exist or is corrupt (falls back to first key).
 */
export function readActiveKey(
  dataPath: string = DEFAULT_ACTIVE_KEY_PATH,
): ActiveKeyState | null {
  if (!fs.existsSync(dataPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(dataPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).active !== 'string'
    ) {
      logger.warn(
        { path: dataPath },
        'Active key state file has invalid format, ignoring',
      );
      return null;
    }

    return parsed as ActiveKeyState;
  } catch (err) {
    logger.warn(
      { err, path: dataPath },
      'Failed to read active key state, ignoring',
    );
    return null;
  }
}

/**
 * Atomically write the active key state.
 * Uses write-to-tmp + rename for crash safety.
 */
export function writeActiveKey(
  label: string,
  switchedBy: string,
  dataPath: string = DEFAULT_ACTIVE_KEY_PATH,
): void {
  const state: ActiveKeyState = {
    active: label,
    switched_at: new Date().toISOString(),
    switched_by: switchedBy,
  };

  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = dataPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, dataPath);

  logger.info({ label, switchedBy }, 'Active key switched');
}

// ── Resolution ─────────────────────────────────────────────────────

/**
 * Resolve the currently active key from config + state.
 * Falls back to the first key in config if state is missing or stale.
 */
export function resolveActiveToken(
  keysConfig: KeysConfig,
  activeKey: ActiveKeyState | null,
): ResolvedKey {
  const entries = Object.entries(keysConfig.keys);

  if (entries.length === 0) {
    throw new Error('[key-manager] KeysConfig has no keys');
  }

  // Try to find the active key
  if (activeKey) {
    const match = entries.find(([, entry]) => entry.label === activeKey.active);
    if (match) {
      const [, entry] = match;
      return {
        label: entry.label,
        token: entry.token,
        proxyPort: entry.proxy_port,
      };
    }
    logger.warn(
      {
        requested: activeKey.active,
        available: entries.map(([, e]) => e.label),
      },
      'Active key not found in config, falling back to first key',
    );
  }

  // Fallback: first key
  const [, first] = entries[0];
  return {
    label: first.label,
    token: first.token,
    proxyPort: first.proxy_port,
  };
}
