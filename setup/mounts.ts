/**
 * Step: mounts — Write mount allowlist config file and sync to registered groups.
 *
 * The allowlist (security gate) defines which host paths MAY be mounted.
 * Each group's container_config.additionalMounts (mount request) defines which
 * paths ARE mounted.  This step writes BOTH so that configured directories
 * actually appear inside the container.
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
    if (args[i] === '--json' && args[i + 1]) {
      json = args[i + 1];
      i++;
    }
  }
  return { empty, json };
}

export async function run(args: string[]): Promise<void> {
  const { empty, json } = parseArgs(args);
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'nanoclaw');
  const configFile = path.join(configDir, 'mount-allowlist.json');

  if (isRoot()) {
    logger.warn(
      'Running as root — mount allowlist will be written to root home directory',
    );
  }

  fs.mkdirSync(configDir, { recursive: true });

  let allowedRoots = 0;
  let nonMainReadOnly = 'true';

  if (empty) {
    logger.info('Writing empty mount allowlist');
    const emptyConfig = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(configFile, JSON.stringify(emptyConfig, null, 2) + '\n');
  } else if (json) {
    // Validate JSON with JSON.parse (not piped through shell)
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(json);
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
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRoots = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  } else {
    // Read from stdin
    logger.info('Reading mount allowlist from stdin');
    const input = fs.readFileSync(0, 'utf-8');
    let parsed: { allowedRoots?: unknown[]; nonMainReadOnly?: boolean };
    try {
      parsed = JSON.parse(input);
    } catch {
      logger.error('Invalid JSON from stdin');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        NON_MAIN_READ_ONLY: 'unknown',
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRoots = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
  }

  logger.info(
    { configFile, allowedRoots, nonMainReadOnly },
    'Allowlist configured',
  );

  // Sync additionalMounts to all registered groups so the container actually
  // mounts the allowed directories.
  const groupsUpdated = syncMountsToGroups(configFile);

  emitStatus('CONFIGURE_MOUNTS', {
    PATH: configFile,
    ALLOWED_ROOTS: allowedRoots,
    NON_MAIN_READ_ONLY: nonMainReadOnly,
    GROUPS_UPDATED: groupsUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

/**
 * Read the allowlist and derive additionalMounts from its allowedRoots,
 * then update every registered group's container_config so the
 * container-runner will mount those directories.
 */
function syncMountsToGroups(allowlistPath: string): number {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    logger.info('No database yet — skipping mount sync to groups');
    return 0;
  }

  let allowlist: {
    allowedRoots?: Array<string | { path: string; allowReadWrite?: boolean }>;
  };
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
  } catch {
    return 0;
  }

  const roots = allowlist.allowedRoots;
  if (!Array.isArray(roots) || roots.length === 0) {
    return 0;
  }

  // Build additionalMounts from allowedRoots
  const additionalMounts = roots.map((root) => {
    const rootPath = typeof root === 'string' ? root : root.path;
    const readWrite =
      typeof root === 'object' && root.allowReadWrite === true;
    return {
      hostPath: rootPath,
      readonly: !readWrite,
    };
  });

  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare('SELECT jid, container_config FROM registered_groups')
      .all() as Array<{ jid: string; container_config: string | null }>;

    const stmt = db.prepare(
      'UPDATE registered_groups SET container_config = ? WHERE jid = ?',
    );

    let count = 0;
    for (const row of rows) {
      const existing = row.container_config
        ? JSON.parse(row.container_config)
        : {};
      existing.additionalMounts = additionalMounts;
      stmt.run(JSON.stringify(existing), row.jid);
      count++;
    }

    logger.info({ count }, 'Synced additionalMounts to registered groups');
    return count;
  } finally {
    db.close();
  }
}
