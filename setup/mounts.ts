/**
 * Step: mounts — Write mount allowlist config file and update group container_config.
 * Replaces 07-configure-mounts.sh
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { logger } from '../src/logger.js';
import { isRoot } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { empty: boolean; json: string } {
  let empty = false;
  let json = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--empty') empty = true;
    if (args[i] === '--json' && args[i + 1]) { json = args[i + 1]; i++; }
  }
  return { empty, json };
}

/**
 * Normalise an allowedRoot entry so it always uses `allowReadWrite: boolean`.
 * Accepts both the canonical form and the legacy `mode: "rw"|"ro"` shorthand.
 */
function normaliseRoot(raw: unknown): { path: string; allowReadWrite: boolean; description?: string } {
  if (typeof raw !== 'object' || raw === null) throw new Error('allowedRoot entry must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== 'string' || !r.path) throw new Error('allowedRoot.path must be a non-empty string');

  let allowReadWrite = false;
  if (typeof r.allowReadWrite === 'boolean') {
    allowReadWrite = r.allowReadWrite;
  } else if (r.mode === 'rw') {
    allowReadWrite = true;
  }
  // mode === 'ro' or anything else → readonly (default false)

  const result: { path: string; allowReadWrite: boolean; description?: string } = {
    path: r.path,
    allowReadWrite,
  };
  if (typeof r.description === 'string') result.description = r.description;
  return result;
}

/**
 * After writing the allowlist, sync additionalMounts into each registered group's
 * container_config so the container actually mounts the directories.
 * Existing mounts whose hostPath is not in the new allowedRoots are preserved;
 * roots in the allowlist are upserted.
 */
function syncGroupMounts(
  allowedRoots: Array<{ path: string; allowReadWrite: boolean; description?: string }>,
): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    logger.warn('No database found — skipping container_config update');
    return;
  }

  const db = new Database(dbPath);
  try {
    const rows = db.prepare('SELECT name, folder, container_config FROM registered_groups').all() as
      Array<{ name: string; folder: string; container_config: string | null }>;

    for (const row of rows) {
      let cfg: { additionalMounts?: Array<{ hostPath: string; containerPath?: string; readonly?: boolean }> } = {};
      try {
        if (row.container_config) cfg = JSON.parse(row.container_config);
      } catch {
        cfg = {};
      }

      // Build a map of existing mounts by hostPath so we don't duplicate
      const existing = new Map<string, { hostPath: string; containerPath?: string; readonly?: boolean }>();
      for (const m of cfg.additionalMounts ?? []) existing.set(m.hostPath, m);

      // Upsert each allowedRoot
      for (const root of allowedRoots) {
        existing.set(root.path, {
          hostPath: root.path,
          containerPath: path.basename(root.path),
          readonly: !root.allowReadWrite,
        });
      }

      cfg.additionalMounts = [...existing.values()];
      db.prepare('UPDATE registered_groups SET container_config = ? WHERE name = ?')
        .run(JSON.stringify(cfg), row.name);
      logger.info({ group: row.name, mounts: cfg.additionalMounts.length }, 'Updated container_config');
    }
  } finally {
    db.close();
  }
}

export async function run(args: string[]): Promise<void> {
  const { empty, json } = parseArgs(args);
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'nanoclaw');
  const configFile = path.join(configDir, 'mount-allowlist.json');

  if (isRoot()) {
    logger.warn('Running as root — mount allowlist will be written to root home directory');
  }

  fs.mkdirSync(configDir, { recursive: true });

  let allowedRoots = 0;
  let nonMainReadOnly = 'true';
  let normalisedRoots: Array<{ path: string; allowReadWrite: boolean; description?: string }> = [];

  if (empty) {
    logger.info('Writing empty mount allowlist');
    const emptyConfig = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(configFile, JSON.stringify(emptyConfig, null, 2) + '\n');
  } else {
    let rawInput: string;
    if (json) {
      rawInput = json;
    } else {
      logger.info('Reading mount allowlist from stdin');
      rawInput = fs.readFileSync(0, 'utf-8');
    }

    let parsed: { allowedRoots?: unknown[]; blockedPatterns?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      logger.error('Invalid JSON input');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return;
    }

    // Normalise roots to canonical format
    try {
      normalisedRoots = (parsed.allowedRoots ?? []).map(normaliseRoot);
    } catch (err) {
      logger.error({ err }, 'Invalid allowedRoots entry');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_allowed_roots',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return;
    }

    const canonical = {
      allowedRoots: normalisedRoots,
      blockedPatterns: Array.isArray(parsed.blockedPatterns) ? parsed.blockedPatterns : [],
      nonMainReadOnly: parsed.nonMainReadOnly !== false,
    };

    fs.writeFileSync(configFile, JSON.stringify(canonical, null, 2) + '\n');
    allowedRoots = normalisedRoots.length;
    nonMainReadOnly = canonical.nonMainReadOnly ? 'true' : 'false';

    // Sync mounts into each group's container_config
    if (normalisedRoots.length > 0) {
      syncGroupMounts(normalisedRoots);
    }
  }

  logger.info({ configFile, allowedRoots, nonMainReadOnly }, 'Allowlist configured');

  emitStatus('CONFIGURE_MOUNTS', {
    PATH: configFile,
    ALLOWED_ROOTS: allowedRoots,
    NON_MAIN_READ_ONLY: nonMainReadOnly,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
