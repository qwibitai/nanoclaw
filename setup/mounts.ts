/**
 * Step: mounts — Write mount allowlist config file.
 * Replaces 07-configure-mounts.sh
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '../src/logger.js';
import { isRoot } from './platform.js';
import { emitStatus } from './status.js';

/**
 * Normalize an allowedRoots entry: map legacy `write` key to `allowReadWrite`
 * so that the saved allowlist matches the shape expected by mount-security.ts.
 */
function normalizeAllowedRoot(root: unknown): unknown {
  if (typeof root !== 'object' || root === null) return root;
  const r = root as Record<string, unknown>;
  if ('write' in r && !('allowReadWrite' in r)) {
    const { write, ...rest } = r;
    return { ...rest, allowReadWrite: Boolean(write) };
  }
  return r;
}

function parseArgs(args: string[]): { empty: boolean; json: string } {
  let empty = false;
  let json = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--empty') empty = true;
    if (args[i] === '--json' && args[i + 1]) { json = args[i + 1]; i++; }
  }
  return { empty, json };
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
      return; // unreachable but satisfies TS
    }

    const normalized = {
      ...parsed,
      allowedRoots: Array.isArray(parsed.allowedRoots)
        ? parsed.allowedRoots.map(normalizeAllowedRoot)
        : [],
    };
    fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2) + '\n');
    allowedRoots = normalized.allowedRoots.length;
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
      return;
    }

    const normalized = {
      ...parsed,
      allowedRoots: Array.isArray(parsed.allowedRoots)
        ? parsed.allowedRoots.map(normalizeAllowedRoot)
        : [],
    };
    fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2) + '\n');
    allowedRoots = normalized.allowedRoots.length;
    nonMainReadOnly = parsed.nonMainReadOnly === false ? 'false' : 'true';
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
