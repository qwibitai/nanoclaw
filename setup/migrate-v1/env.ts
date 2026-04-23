/**
 * Step: migrate-env
 *
 * Copy every key from v1 `.env` to v2 `.env`. Preserves v2 values that
 * already exist (never overwrites). Skips lines that don't look like a
 * `KEY=value` pair.
 *
 * Why copy everything, not a curated list? v1 installs accumulate
 * project-specific keys (custom MCP creds, feature flags, webhook tokens)
 * that the migration can't enumerate ahead of time. The user explicitly
 * asked for everything. We log what we carried so the skill can review.
 *
 * Security note: we do NOT log values here — only keys. The raw log already
 * contains the file contents; we don't echo them to stdout.
 */
import fs from 'fs';
import path from 'path';

import { emitStatus } from '../status.js';
import { readHandoff, recordStep, v1PathsFor } from './shared.js';

interface EnvLine {
  key: string;
  value: string;
  raw: string;
}

function parseEnv(text: string): EnvLine[] {
  const out: EnvLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    const value = line.slice(eq + 1);
    out.push({ key, value, raw: line });
  }
  return out;
}

export async function run(_args: string[]): Promise<void> {
  const h = readHandoff();
  if (!h.v1_path) {
    recordStep('migrate-env', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_ENV', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  const paths = v1PathsFor(h.v1_path);
  if (!fs.existsSync(paths.env)) {
    recordStep('migrate-env', {
      status: 'skipped',
      fields: { REASON: 'v1-env-missing' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_ENV', { STATUS: 'skipped', REASON: 'v1_env_missing' });
    return;
  }

  const v2EnvPath = path.join(process.cwd(), '.env');
  const v1Text = fs.readFileSync(paths.env, 'utf-8');
  const v1Lines = parseEnv(v1Text);

  let v2Text = fs.existsSync(v2EnvPath) ? fs.readFileSync(v2EnvPath, 'utf-8') : '';
  const v2Lines = parseEnv(v2Text);
  const v2Keys = new Set(v2Lines.map((l) => l.key));

  const copied: string[] = [];
  const skipped: string[] = [];
  const appended: string[] = [];

  // Tag the appended block so a later re-run can find it and not double-append.
  const BLOCK_START = '# ── migrated from v1 ──';
  const alreadyMigrated = v2Text.includes(BLOCK_START);

  for (const line of v1Lines) {
    if (v2Keys.has(line.key)) {
      skipped.push(line.key);
      continue;
    }
    copied.push(line.key);
    appended.push(line.raw);
  }

  if (appended.length > 0) {
    const suffix = [
      v2Text.endsWith('\n') || v2Text === '' ? '' : '\n',
      alreadyMigrated ? '' : `\n${BLOCK_START}\n`,
      appended.join('\n'),
      '\n',
    ].join('');
    v2Text = v2Text + suffix;
    fs.writeFileSync(v2EnvPath, v2Text);
  }

  // Container reads from data/env/env (host mounts it). Keep it in sync.
  const containerEnvDir = path.join(process.cwd(), 'data', 'env');
  try {
    fs.mkdirSync(containerEnvDir, { recursive: true });
    fs.copyFileSync(v2EnvPath, path.join(containerEnvDir, 'env'));
  } catch {
    // Non-fatal; the service restart (later step) will rehydrate if needed.
  }

  recordStep('migrate-env', {
    status: 'success',
    fields: {
      KEYS_COPIED: copied.length,
      KEYS_SKIPPED_EXISTING: skipped.length,
      V1_ENV: paths.env,
      V2_ENV: v2EnvPath,
    },
    notes: [
      copied.length > 0 ? `Copied: ${copied.join(', ')}` : '',
      skipped.length > 0 ? `Skipped (already in v2 .env): ${skipped.join(', ')}` : '',
    ].filter(Boolean),
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_ENV', {
    STATUS: 'success',
    KEYS_COPIED: String(copied.length),
    KEYS_SKIPPED_EXISTING: String(skipped.length),
    COPIED_KEYS: copied.join(',') || 'none',
  });
}
