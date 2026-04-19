import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const FORWARD_LIST_PATH = path.join(DATA_DIR, 'env', 'forward-list');

/**
 * Read the env forward-list file and resolve each listed name against
 * process.env. Returns a record of names that are present in the process
 * environment. Names listed but absent from process.env are logged as
 * warnings and omitted from the result.
 *
 * File format: one env var name per line.
 * Blank lines and lines starting with '#' are ignored.
 * Absent file is treated as empty allowlist (no forwarding).
 */
export function getForwardedEnv(): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(FORWARD_LIST_PATH, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const name = line.trim();
    if (!name || name.startsWith('#')) continue;

    const value = process.env[name];
    if (value === undefined) {
      logger.warn(
        { name },
        'env-forward: var listed in forward-list but not found in process.env — skipping',
      );
      continue;
    }

    result[name] = value;
  }

  return result;
}
