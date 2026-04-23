/**
 * Step: migrate-detect
 *
 * Find a v1 install on disk. Scans the standard candidate paths; if none
 * matches, exits with a NOT_FOUND status (the orchestrator then offers a
 * clack prompt so the user can point at a custom path).
 *
 * Never prompts — this step is pure discovery so it stays safe to run under
 * NANOCLAW_SKIP= without blocking on stdin.
 */
import fs from 'fs';
import path from 'path';

import { emitStatus } from '../status.js';
import {
  defaultV1Candidates,
  looksLikeV1Install,
  readHandoff,
  recordStep,
  v1PathsFor,
  writeHandoff,
} from './shared.js';

interface DetectArgs {
  /** Explicit path to check, skipping the default candidate list. */
  path?: string;
}

function parseArgs(args: string[]): DetectArgs {
  const out: DetectArgs = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--path') {
      out.path = args[++i] || undefined;
    }
  }
  return out;
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  // An explicit path — either from --path or $NANOCLAW_V1_PATH — is
  // authoritative. If it doesn't validate, we don't fall through to
  // the default candidate list. That keeps the user's explicit intent
  // from being silently overridden.
  const envOverride = process.env.NANOCLAW_V1_PATH?.trim();
  const explicit = parsed.path ?? envOverride ?? null;
  const candidates = explicit ? [explicit] : defaultV1Candidates();

  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    // Don't self-match — if the candidate resolves to the v2 checkout we're
    // running inside, skip it. Protects users who cloned v2 into `~/nanoclaw`
    // after deleting v1.
    if (absolute === path.resolve(process.cwd())) continue;

    const check = looksLikeV1Install(absolute);
    if (!check.ok) continue;

    const paths = v1PathsFor(absolute);
    let version = 'unknown';
    try {
      const pkg = JSON.parse(fs.readFileSync(paths.packageJson, 'utf-8')) as { version?: string };
      version = pkg.version ?? 'unknown';
    } catch {
      // Already sanity-checked by looksLikeV1Install — a failure here means
      // the file changed under us between calls. Unlikely, not fatal.
    }

    const h = readHandoff();
    h.v1_path = absolute;
    h.v1_version = version;
    writeHandoff(h);

    recordStep('migrate-detect', {
      status: 'success',
      fields: { V1_PATH: absolute, V1_VERSION: version },
      notes: [],
      at: new Date().toISOString(),
    });

    emitStatus('MIGRATE_DETECT', {
      STATUS: 'success',
      V1_PATH: absolute,
      V1_VERSION: version,
      DB_PATH: paths.db,
      ENV_PATH: paths.env,
      GROUPS_PATH: paths.groups,
    });
    return;
  }

  // Nothing matched. Not an error — most v2 installs are fresh, not migrations.
  const scanned = candidates.map((c) => path.resolve(c)).join(',');
  recordStep('migrate-detect', {
    status: 'skipped',
    fields: { REASON: 'no-v1-install-found' },
    notes: [`Scanned: ${scanned}`],
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_DETECT', {
    STATUS: 'skipped',
    REASON: 'not_found',
    CANDIDATES_SCANNED: String(candidates.length),
  });
}
