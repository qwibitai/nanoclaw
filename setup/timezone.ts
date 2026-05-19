/**
 * Step: timezone — Detect, validate, and persist the user's timezone.
 * Writes TZ to .env if a valid IANA timezone is resolved.
 * Emits NEEDS_USER_INPUT=true when autodetection fails.
 */
import fs from 'fs';
import path from 'path';

import { isValidTimezone } from '../src/timezone.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const envFile = path.join(projectRoot, '.env');

  // Check what's already in .env
  let envFileTz: string | undefined;
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf-8');
    const match = content.match(/^TZ=(.+)$/m);
    if (match) envFileTz = match[1].trim().replace(/^["']|["']$/g, '');
  }

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const envTz = process.env.TZ;

  // Accept --tz flag from CLI (used when setup skill collects from user)
  const tzFlagIdx = args.indexOf('--tz');
  const userTz = tzFlagIdx !== -1 ? args[tzFlagIdx + 1] : undefined;

  // Resolve: user-provided > .env > process.env > system autodetect
  let resolvedTz: string | undefined;
  for (const candidate of [userTz, envFileTz, envTz, systemTz]) {
    if (candidate && isValidTimezone(candidate)) {
      resolvedTz = candidate;
      break;
    }
  }

  const needsUserInput = !resolvedTz;

  if (resolvedTz && resolvedTz !== envFileTz) {
    // Write/update TZ in .env
    if (fs.existsSync(envFile)) {
      let content = fs.readFileSync(envFile, 'utf-8');
      if (/^TZ=/m.test(content)) {
        content = content.replace(/^TZ=.*$/m, `TZ=${resolvedTz}`);
      } else {
        content = content.trimEnd() + `\nTZ=${resolvedTz}\n`;
      }
      fs.writeFileSync(envFile, content);
    } else {
      fs.writeFileSync(envFile, `TZ=${resolvedTz}\n`);
    }
    log.info('Set TZ in .env', { timezone: resolvedTz });
  }

  emitStatus('TIMEZONE', {
    SYSTEM_TZ: systemTz || 'unknown',
    ENV_TZ: envTz || 'unset',
    ENV_FILE_TZ: envFileTz || 'unset',
    RESOLVED_TZ: resolvedTz || 'none',
    NEEDS_USER_INPUT: needsUserInput,
    STATUS: needsUserInput ? 'needs_input' : 'success',
  });
}
