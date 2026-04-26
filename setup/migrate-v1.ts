/**
 * v1 → v2 migration orchestrator. Called from setup/auto.ts after the
 * timezone step and before the channel step.
 *
 * Silent happy path: if no v1 install is found, we emit one "skipped" step
 * and return. Users on a fresh v2 install never see anything.
 *
 * When v1 IS found: detect → [confirm] → group-selection prompt → validate
 * → db → groups → env → channel-auth → channels → tasks → handoff.
 * Every sub-step is a separate entry in the progression log; failures never
 * abort the chain (the handoff file records them for the skill to finish).
 *
 * After everything runs, a one-line note points the user at the
 * `/migrate-from-v1` skill.
 */
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import Database from 'better-sqlite3';
import k from 'kleur';

import { ensureAnswer, runQuietStep } from './lib/runner.js';
import { wrapForGutter } from './lib/theme.js';
import * as setupLog from './logs.js';
import {
  HANDOFF_PATH,
  MIGRATION_DIR,
  inferChannelType,
  readHandoff,
  v1PathsFor,
  writeHandoff,
} from './migrate-v1/shared.js';

/**
 * Count groups in v1's registered_groups, split by whether the channel_type
 * can be inferred. Uses the same `inferChannelType` logic as migrate-db so
 * the displayed count matches what will actually get seeded. Open-and-close
 * because this runs in the orchestrator before migrate-db's child process.
 */
function countV1Groups(v1Root: string): { total: number; wired: number } {
  const dbPath = v1PathsFor(v1Root).db;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare('SELECT jid, channel_name FROM registered_groups')
      .all() as Array<{ jid: string; channel_name: string | null }>;
    db.close();
    let wired = 0;
    for (const r of rows) {
      if (inferChannelType(r.jid, r.channel_name)) wired++;
    }
    return { total: rows.length, wired };
  } catch {
    return { total: 0, wired: 0 };
  }
}

async function askGroupSelection(counts: { total: number; wired: number }): Promise<'all' | 'wired-only' | 'cancel'> {
  // Non-interactive escape hatch for CI / re-runs / scripted migrations.
  // NANOCLAW_MIGRATE_SELECTION = 'all' | 'wired-only' | 'cancel'.
  const envChoice = process.env.NANOCLAW_MIGRATE_SELECTION?.trim();
  if (envChoice === 'all' || envChoice === 'wired-only' || envChoice === 'cancel') {
    setupLog.userInput('migrate_selection', `${envChoice} (from NANOCLAW_MIGRATE_SELECTION)`);
    return envChoice;
  }
  // Most v1 installs accumulated many orphan folders. Default the user to
  // wired-only (the ones we can actually route) — explicit opt-in for "all".
  const choice = ensureAnswer(
    await p.select({
      message: `Found ${counts.total} v1 group folders (${counts.wired} wired to a channel). Which to bring over?`,
      options: [
        {
          value: 'wired-only',
          label: `Only the ${counts.wired} wired ones`,
          hint: 'recommended — skips orphans',
        },
        {
          value: 'all',
          label: `All ${counts.total} folders`,
          hint: 'brings dead/orphan folders over too',
        },
        {
          value: 'cancel',
          label: 'Skip migration',
          hint: "I'll migrate later",
        },
      ],
    }),
  ) as 'all' | 'wired-only' | 'cancel';
  setupLog.userInput('migrate_selection', choice);
  return choice;
}

/**
 * Finalize the handoff record after every sub-step has run. Computes an
 * overall status from per-step statuses: anything `failed` → partial;
 * anything `partial` → partial; else success.
 */
function finalizeHandoff(): 'success' | 'partial' | 'failed' {
  const h = readHandoff();
  const statuses = Object.values(h.steps).map((s) => s?.status);
  const anyFailed = statuses.includes('failed');
  const anyPartial = statuses.includes('partial');
  const overall: 'success' | 'partial' | 'failed' = anyFailed
    ? 'partial' // DB or files may have landed; the skill can pick up the rest
    : anyPartial
      ? 'partial'
      : 'success';
  h.overall_status = overall;
  writeHandoff(h);
  return overall;
}

function printHandoffNote(overall: 'success' | 'partial' | 'failed'): void {
  const relHandoff = path.relative(process.cwd(), HANDOFF_PATH);
  const lines: string[] = [];
  if (overall === 'success') {
    lines.push(
      wrapForGutter(
        'Your v1 install has been migrated. Run `/migrate-from-v1` in Claude next — it will seed your owner account and help port any custom code you had.',
        4,
      ),
    );
  } else {
    lines.push(
      wrapForGutter(
        'Migration finished with some items for a human. Run `/migrate-from-v1` in Claude — it will read the handoff, finish the unfinished steps, and walk through custom code.',
        4,
      ),
    );
  }
  lines.push('');
  lines.push(k.dim(`  Handoff:    ${relHandoff}`));
  lines.push(k.dim(`  Full log:   ${setupLog.progressLogPath}`));
  lines.push(k.dim(`  Raw logs:   ${setupLog.stepsDir}/`));
  p.note(lines.join('\n'), 'Migration handoff');
}

export async function runMigrateV1(): Promise<'proceeded' | 'skipped' | 'cancelled'> {
  // 0. Ensure migration log dir exists before any sub-step writes to it.
  fs.mkdirSync(MIGRATION_DIR, { recursive: true });

  // 1. Detect. If nothing obvious, give the user one subtle chance to point
  // us at a non-standard path — then accept silently.
  const detect = await runQuietStep('migrate-detect', {
    running: 'Checking for a previous NanoClaw install…',
    done: 'Found a previous install.',
    skipped: 'No previous install to migrate.',
  });

  const v1Found = detect.ok && detect.terminal?.fields.STATUS === 'success';

  if (!v1Found) {
    // Silent skip — the 99% case is a fresh install with no v1 anywhere.
    // Prompting for a custom path on every fresh run is UX noise. Users
    // with a v1 at a non-standard location use `NANOCLAW_V1_PATH=<path>
    // bash nanoclaw.sh` (documented in README + setup/auto.ts header).
    return 'skipped';
  }

  // 2. Ask the user which groups to bring over.
  const h = readHandoff();
  if (!h.v1_path) {
    // Shouldn't happen — detect set it if v1Found. Guard anyway.
    return 'skipped';
  }

  // Experimental warning — fires only when a v1 install is found, so stock
  // v2 users (no v1 to migrate) never see it. Not a blocker; the user can
  // still proceed. Skip when NANOCLAW_MIGRATE_SELECTION is set (scripted /
  // CI runs have already accepted the risk by defining their selection).
  if (!process.env.NANOCLAW_MIGRATE_SELECTION) {
    p.log.warn(
      wrapForGutter(
        'v1 → v2 migration is experimental. Back up your v2 state (data/v2.db, groups/) before continuing. Not recommended for high-stakes production installs — it does a best-effort port and a human still has to finish via /migrate-from-v1.',
        4,
      ),
    );
  }

  const counts = countV1Groups(h.v1_path);
  const selection = await askGroupSelection(counts);
  if (selection === 'cancel') {
    // Mark the handoff so the skill can still see what would have happened.
    const ho = readHandoff();
    ho.overall_status = 'skipped';
    writeHandoff(ho);
    return 'cancelled';
  }

  // 3. Validate — if it fails, subsequent steps will short-circuit the
  // DB-dependent parts. Groups + env still run.
  await runQuietStep('migrate-validate', {
    running: "Checking the v1 database's shape…",
    done: 'v1 database looks good.',
    failed: "v1 database didn't match what I expected.",
    skipped: 'Skipped database validation.',
  });

  // 4. DB seeding — parameterized by the user's selection.
  await runQuietStep(
    'migrate-db',
    {
      running: 'Seeding v2 agents and channels from v1…',
      done: 'Seeded v2 database.',
      skipped: 'Skipped database seeding.',
      failed: "Couldn't seed the v2 database.",
    },
    ['--selection', selection],
  );

  // 5. Group folders.
  await runQuietStep('migrate-groups', {
    running: 'Copying group folders…',
    done: 'Group folders copied.',
    skipped: 'Skipped group-folder copy.',
    failed: "Couldn't copy some group folders.",
  });

  // 6. Env keys.
  await runQuietStep('migrate-env', {
    running: 'Merging v1 .env into v2 .env…',
    done: 'Env keys migrated.',
    skipped: 'No env keys to migrate.',
    failed: "Couldn't merge .env.",
  });

  // 7. Non-env channel auth (Baileys keystore, matrix state, etc.).
  await runQuietStep('migrate-channel-auth', {
    running: 'Copying channel auth files…',
    done: 'Channel auth copied.',
    skipped: 'No channel auth to copy.',
    failed: 'Some channel auth files need attention.',
  });

  // 8. Install v2 channel adapters for the detected channels.
  await runQuietStep('migrate-channels', {
    running: 'Installing v2 channel adapters…',
    done: 'Channel adapters installed.',
    skipped: 'No channels to install.',
    failed: 'Some channel adapters need attention.',
  });

  // 9. Scheduled tasks.
  await runQuietStep('migrate-tasks', {
    running: 'Porting scheduled tasks…',
    done: 'Scheduled tasks ported.',
    skipped: 'No scheduled tasks to port.',
    failed: 'Some scheduled tasks need attention.',
  });

  // 10. Finalize + hand off.
  const overall = finalizeHandoff();
  printHandoffNote(overall);
  return 'proceeded';
}
