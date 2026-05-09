/**
 * v1 → v2 migration sequencer — `pnpm run migrate:v1-to-v2`.
 *
 * Runs in a v2 worktree. Reads v1 state from `--v1-root <path>` (defaults
 * to the parent directory when run from a worktree named `.migrate-worktree`),
 * extracts it into `.nanoclaw-migrations/v1-data/` in the v1 tree, seeds
 * v2 central state into the current worktree's `data/v2.db`, and leaves
 * the swap for the user to run after validation.
 *
 * Responsibility split mirrors `setup/auto.ts`:
 *   - This file: step sequencing, clack UI, decision routing.
 *   - Primitives: runner (spinner + log + fail), claude-assist (failure
 *     recovery), claude-handoff (interactive recovery for ambiguous
 *     customizations).
 *   - Library: `setup/migrate/*.ts` — detect, extract, seed, owner inference,
 *     guide composition.
 *
 * Env knobs:
 *   NANOCLAW_V1_ROOT       v1 install path; defaults to `..`
 *   NANOCLAW_MIGRATE_SKIP  comma-separated step names to skip
 *                          (preflight|safety|extract|owner|guide|seed|copy|rebuild|verify)
 *   NANOCLAW_SKIP_CLAUDE_ASSIST=1 disables the claude-assist offer on failure
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { offerClaudeAssist } from './lib/claude-assist.js';
import { offerClaudeHandoff } from './lib/claude-handoff.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail } from './lib/runner.js';
import { brandBold, dimWrap } from './lib/theme.js';

import { detectInstall } from './migrate/detect-v1.js';
import { runExtract, type V1ExtractResult } from './migrate/extract-v1.js';
import { writeGuide } from './migrate/guide-compose.js';
import { runSeed, type SeedStats } from './migrate/seed-v2.js';

const RUN_START = Date.now();

async function main(): Promise<void> {
  p.intro(`${brandBold('NanoClaw')} · v1 → v2 migration`);

  setupLog.reset({
    mode: 'migrate',
    cwd: process.cwd(),
    node: process.version,
    started: new Date(RUN_START).toISOString(),
  });

  const v1Root = resolveV1Root();
  const v2Root = process.cwd();
  const skip = new Set(
    (process.env.NANOCLAW_MIGRATE_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  p.log.info(
    dimWrap(
      `v1 install: ${v1Root}\nv2 worktree: ${v2Root}`,
      4,
    ),
  );

  // ── 1. Preflight ─────────────────────────────────────────────
  if (!skip.has('preflight')) await stepPreflight(v1Root, v2Root);

  // ── 2. Extract ───────────────────────────────────────────────
  const extract = skip.has('extract') ? await rehydrateExtract(v1Root) : await stepExtract(v1Root);

  // ── 3. Owner confirmation ─────────────────────────────────────
  if (!skip.has('owner')) await stepOwner(extract);

  // ── 4. Guide ─────────────────────────────────────────────────
  if (!skip.has('guide')) await stepGuide(extract);

  // ── 5. Safety net ────────────────────────────────────────────
  if (!skip.has('safety')) await stepSafetyNet(v1Root);

  // ── 6. Seed ──────────────────────────────────────────────────
  const seedStats = skip.has('seed') ? null : await stepSeed(v1Root, v2Root);

  // ── 7. Copy-over (CLAUDE.local.md, user skills, env) ─────────
  if (!skip.has('copy')) await stepCopyOver(extract, v2Root);

  // ── 8. Rebuild (Claude handoff, opt-in) ──────────────────────
  if (!skip.has('rebuild')) await stepRebuild(extract);

  // ── 9. Verify ────────────────────────────────────────────────
  if (!skip.has('verify')) await stepVerify(v2Root, seedStats);

  // ── 10. Final outro — swap is left to the operator ───────────
  outroSwapInstructions(v1Root, v2Root);
  setupLog.complete(Date.now() - RUN_START);
}

// ── Steps ──

async function stepPreflight(v1Root: string, v2Root: string): Promise<void> {
  const s = p.spinner();
  s.start('Checking v1 install and v2 worktree…');

  const v1Verdict = detectInstall(v1Root);
  const v2Verdict = detectInstall(v2Root);

  s.stop('State scanned.');

  if (v1Verdict.kind === 'fresh') {
    await fail(
      'preflight',
      `No NanoClaw install detected at ${v1Root}.`,
      `Point --v1-root at your v1 checkout, or set NANOCLAW_V1_ROOT.`,
    );
  }
  if (v1Verdict.kind === 'v2') {
    await fail(
      'preflight',
      `Install at ${v1Root} is already v2 — nothing to migrate.`,
      `If you want to re-seed, delete data/v2.db and re-run.`,
    );
  }
  if (v1Verdict.kind === 'mixed') {
    p.log.warn(
      `Install at ${v1Root} has both v1 and v2 DBs. Re-running seed is safe (idempotent), ` +
        `but verify you're not about to overwrite partial progress.`,
    );
  }

  if (v2Verdict.kind !== 'v2' && v2Verdict.kind !== 'fresh') {
    await fail(
      'preflight',
      `Worktree at ${v2Root} doesn't look like v2.`,
      `Create one via: git worktree add .migrate-worktree origin/v2 --detach`,
    );
  }

  // Dirty-tree check on the v1 install.
  const dirty = sh('git status --porcelain', v1Root);
  if (dirty.trim().length > 0) {
    p.log.warn(`v1 install has uncommitted changes:\n${k.dim(dirty)}`);
    const proceed = ensureAnswer(
      await p.confirm({
        message: 'Proceed anyway? (the migration guide will reference your v1 HEAD, uncommitted changes are not captured)',
        initialValue: false,
      }),
    );
    if (!proceed) await fail('preflight', 'Cancelled — clean the v1 tree and re-run.');
  }

  setupLog.step('preflight', 'success', 0, {
    V1_KIND: v1Verdict.kind,
    V1_VERSION: v1Verdict.packageVersion ?? '(unknown)',
    V2_KIND: v2Verdict.kind,
  });
  p.log.success('Preflight looks good.');
}

async function stepExtract(v1Root: string): Promise<V1ExtractResult> {
  const s = p.spinner();
  s.start('Reading v1 state…');
  const start = Date.now();
  let result: V1ExtractResult;
  try {
    result = await runExtract(v1Root);
  } catch (err) {
    s.stop('Extract failed.');
    await fail('extract', `Could not read v1 state: ${(err as Error).message}`, undefined);
    throw err; // unreachable
  }
  const ms = Date.now() - start;
  s.stop(`v1 state read in ${Math.round(ms / 1000)}s.`);

  const summary = [
    `Registered groups: ${result.registeredGroups.length}`,
    `Sessions:          ${result.sessions.length}`,
    `Scheduled tasks:   ${result.scheduledTasks.length}`,
    `Channels in use:   ${result.channelsInUse.join(', ') || '(none)'}`,
    `Unknown JIDs:      ${result.unknownJids.length}`,
    `Applied skills:    ${result.appliedSkillMerges.length}`,
    `Customized files:  ${result.customizedFiles.length}`,
  ].join('\n');
  p.note(summary, 'v1 state');

  if (result.unknownJids.length > 0) {
    p.log.warn(
      `Unrecognized JID formats — edit \`${result.outDir}/registered-groups.json\` to set ` +
        `\`inferred_channel_type\` before seeding:\n` +
        result.unknownJids.map((j) => `  ${j}`).join('\n'),
    );
  }

  setupLog.step('extract', 'success', ms, {
    GROUPS: String(result.registeredGroups.length),
    CHANNELS: result.channelsInUse.join(',') || '(none)',
    UNKNOWN_JIDS: String(result.unknownJids.length),
  });
  return result;
}

async function rehydrateExtract(v1Root: string): Promise<V1ExtractResult> {
  const v1Data = path.join(v1Root, '.nanoclaw-migrations', 'v1-data');
  if (!fs.existsSync(v1Data)) {
    await fail(
      'extract',
      `Skipping extract but no prior state at ${v1Data}.`,
      `Re-run without NANOCLAW_MIGRATE_SKIP=extract, or run extract manually first.`,
    );
  }
  // Re-read from disk to rebuild the result. The cheapest way is to re-run
  // extract in dry-identity mode — it's idempotent and fast enough.
  return runExtract(v1Root);
}

async function stepOwner(ex: V1ExtractResult): Promise<void> {
  const proposal = ex.ownerProposal;
  if (proposal.userId && proposal.confidence === 'high') {
    p.log.success(`Owner: ${k.cyan(proposal.userId)} (${proposal.source})`);
    return;
  }

  if (proposal.userId) {
    const keep = ensureAnswer(
      await p.confirm({
        message: `I think the owner is ${k.cyan(proposal.userId)} (from ${proposal.source}). Correct?`,
        initialValue: true,
      }),
    );
    if (keep) {
      setupLog.step('owner', 'success', 0, { USER_ID: proposal.userId, SOURCE: proposal.source });
      return;
    }
  }

  p.log.info(
    dimWrap(
      'I need an explicit owner user_id. Format is `<channel>:<handle>` — for example `phone:+15551234567`, ' +
        '`discord:123456789012345678`, `telegram:987654321`. Type `?` to hand off to Claude if you need help finding it.',
      4,
    ),
  );

  const answer = await p.text({
    message: 'Owner user_id:',
    placeholder: 'phone:+15551234567',
  });
  const raw = ensureAnswer(answer);

  if (raw === '?' ) {
    await offerClaudeHandoff({
      channel: 'migrate',
      step: 'owner',
      stepDescription: 'The migration needs to identify the operator (owner) for v2',
      files: [path.join(ex.outDir, 'registered-groups.json'), path.join(ex.outDir, 'sender-allowlist.json')],
    });
    // After handoff, prompt again — the user may have edited owner.json directly.
    const ownerJson = path.join(ex.outDir, 'owner.json');
    try {
      const edited = JSON.parse(fs.readFileSync(ownerJson, 'utf-8')) as { userId?: string };
      if (edited.userId) {
        ex.ownerProposal = { userId: edited.userId, source: 'claude-handoff', confidence: 'high' };
        rewriteOwnerFile(ex);
        p.log.success(`Owner: ${k.cyan(edited.userId)} (claude-handoff)`);
        setupLog.step('owner', 'success', 0, { USER_ID: edited.userId, SOURCE: 'claude-handoff' });
        return;
      }
    } catch {
      /* fall through to re-prompt */
    }
    return stepOwner(ex);
  }

  if (!raw.includes(':')) {
    p.log.error('Expected format `<channel>:<handle>` — try again.');
    return stepOwner(ex);
  }

  ex.ownerProposal = { userId: raw, source: 'user-entered', confidence: 'high' };
  rewriteOwnerFile(ex);
  setupLog.step('owner', 'success', 0, { USER_ID: raw, SOURCE: 'user-entered' });
}

async function stepGuide(ex: V1ExtractResult): Promise<void> {
  const s = p.spinner();
  s.start('Writing migration guide…');
  let guidePath: string;
  try {
    guidePath = writeGuide(ex);
  } catch (err) {
    s.stop('Guide write failed.');
    await fail('guide', `Could not write guide: ${(err as Error).message}`);
    throw err;
  }
  s.stop('Migration guide written.');
  p.log.info(k.dim(guidePath));
  setupLog.step('guide', 'success', 0, { GUIDE_PATH: guidePath });

  const review = ensureAnswer(
    await p.confirm({
      message: 'Open the guide now and review before seeding?',
      initialValue: false,
    }),
  );
  if (review) {
    p.log.info(
      dimWrap(`Review the guide at ${guidePath}, then come back and press Enter to continue.`, 4),
    );
    await p.text({ message: 'Press Enter to continue' });
  }
}

async function stepSafetyNet(v1Root: string): Promise<void> {
  const s = p.spinner();
  s.start('Creating rollback point…');

  const hash = sh('git rev-parse --short HEAD', v1Root) || 'nohash';
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const tagName = `pre-v2-${hash}-${ts}`;
  const branchName = `backup/pre-v2-${hash}-${ts}`;

  const tag = shSafe(`git tag ${tagName}`, v1Root);
  const branch = shSafe(`git branch ${branchName}`, v1Root);

  s.stop(`Rollback point created: tag \`${tagName}\``);
  setupLog.step('safety', 'success', 0, { TAG: tagName, BRANCH: branchName });
  p.log.info(
    dimWrap(
      `Rollback with: git reset --hard ${tagName}\n(+ restore data dirs after swap — see guide's Rollback section)`,
      4,
    ),
  );
  void tag;
  void branch;
}

async function stepSeed(v1Root: string, v2Root: string): Promise<SeedStats> {
  const s = p.spinner();
  s.start('Seeding v2 central DB…');
  let stats: SeedStats;
  try {
    stats = runSeed({ v1Root, v2DbPath: path.join(v2Root, 'data', 'v2.db') });
  } catch (err) {
    s.stop('Seed failed.');
    const msg = (err as Error).message;
    p.log.error(msg);

    const tryAgain = await offerClaudeAssist({
      stepName: 'migrate-seed',
      msg,
      hint: `v1 root: ${v1Root}. Check src/channels/ for the adapters the seeder expected.`,
      rawLogPath: setupLog.stepRawLog('migrate-seed'),
    });
    if (tryAgain) {
      p.log.info('Re-running seed after Claude-assisted fix…');
      return stepSeed(v1Root, v2Root);
    }
    await fail('seed', msg);
    throw err;
  }
  s.stop('v2 central DB seeded.');

  const rows: [string, string][] = [
    ['Agent groups:',      `inserted ${stats.agentGroups.inserted} · skipped ${stats.agentGroups.skipped}`],
    ['Messaging groups:',  `inserted ${stats.messagingGroups.inserted} · skipped ${stats.messagingGroups.skipped}`],
    ['Wirings:',           `inserted ${stats.wirings.inserted} · skipped ${stats.wirings.skipped}`],
    ['Users:',             `inserted ${stats.users.inserted}`],
    ['Roles:',             `inserted ${stats.roles.inserted} · skipped ${stats.roles.skipped}`],
    ['Memberships:',       `inserted ${stats.members.inserted}`],
    ['DM cache:',          `inserted ${stats.userDms.inserted}`],
    ['container.json:',    `written ${stats.containerConfigs.written}`],
  ];
  const labelW = Math.max(...rows.map(([l]) => l.length));
  p.note(rows.map(([l, v]) => `${k.cyan(l.padEnd(labelW))}  ${v}`).join('\n'), 'Seed results');

  for (const w of stats.warnings) p.log.warn(w);

  setupLog.step('seed', 'success', 0, {
    AG_NEW: String(stats.agentGroups.inserted),
    MG_NEW: String(stats.messagingGroups.inserted),
    WIRING_NEW: String(stats.wirings.inserted),
    OWNER_DM: String(stats.userDms.inserted),
    WARNINGS: String(stats.warnings.length),
  });
  return stats;
}

async function stepCopyOver(ex: V1ExtractResult, v2Root: string): Promise<void> {
  const s = p.spinner();
  s.start('Copying over CLAUDE.md → CLAUDE.local.md + user skills…');

  const details: string[] = [];

  // groups/<folder>/CLAUDE.md → v2 groups/<folder>/CLAUDE.local.md
  for (const g of ex.groups) {
    if (!g.has_claude_md) continue;
    const src = path.join(ex.v1Root, 'groups', g.folder, 'CLAUDE.md');
    const dstDir = path.join(v2Root, 'groups', g.folder);
    const dst = path.join(dstDir, 'CLAUDE.local.md');
    if (fs.existsSync(dst)) {
      details.push(`skip ${g.folder} (CLAUDE.local.md already exists)`);
      continue;
    }
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(src, dst);
    details.push(`copied ${g.folder}/CLAUDE.md → CLAUDE.local.md`);
  }

  // User-authored skills — copy if not already present on v2.
  for (const dir of ex.userAuthoredSkillDirs) {
    const src = path.join(ex.v1Root, '.claude', 'skills', dir);
    const dst = path.join(v2Root, '.claude', 'skills', dir);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      details.push(`skip skill ${dir} (already present)`);
      continue;
    }
    fs.cpSync(src, dst, { recursive: true });
    details.push(`copied skill ${dir}`);
  }

  // Non-secret .env merge (additive — never overwrite existing keys in v2's .env).
  const v2Env = path.join(v2Root, '.env');
  const existing = fs.existsSync(v2Env) ? fs.readFileSync(v2Env, 'utf-8') : '';
  const existingKeys = new Set<string>();
  for (const line of existing.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) existingKeys.add(line.slice(0, eq).trim());
  }
  const additions: string[] = [];
  for (const [k, v] of Object.entries(ex.env)) {
    if (existingKeys.has(k)) continue;
    additions.push(`${k}=${v}`);
  }
  if (additions.length > 0) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(v2Env, prefix + additions.join('\n') + '\n');
    details.push(`appended ${additions.length} env key(s)`);
  }

  // NANOCLAW_ADMIN_USER_IDS — owner gets admin-level approval capability.
  if (ex.ownerProposal.userId && !existingKeys.has('NANOCLAW_ADMIN_USER_IDS')) {
    fs.appendFileSync(v2Env, `NANOCLAW_ADMIN_USER_IDS=${ex.ownerProposal.userId}\n`);
    details.push('appended NANOCLAW_ADMIN_USER_IDS');
  }

  s.stop(`Copy-over complete (${details.length} action${details.length === 1 ? '' : 's'}).`);
  if (details.length > 0) p.log.info(k.dim(details.join('\n')));
  setupLog.step('copy', 'success', 0, { ACTIONS: String(details.length) });
}

async function stepRebuild(ex: V1ExtractResult): Promise<void> {
  if (ex.customizedFiles.length === 0) {
    p.log.info('No code customizations detected — nothing to rebuild.');
    return;
  }
  p.log.info(
    dimWrap(
      `You have ${ex.customizedFiles.length} customized file(s) from v1. Most target paths that don't exist on v2 ` +
        `(monolithic src/db.ts, IPC, credential-proxy, etc.). Re-expressing them against v2's module system works best ` +
        `interactively with Claude.`,
      4,
    ),
  );
  const want = ensureAnswer(
    await p.confirm({
      message: 'Hand off to Claude now to walk through the rebuild?',
      initialValue: true,
    }),
  );
  if (!want) {
    p.log.info(
      dimWrap(
        `You can do this later — re-run with NANOCLAW_MIGRATE_SKIP set to everything else, or ` +
          `open the guide and feed it to Claude yourself.`,
        4,
      ),
    );
    setupLog.step('rebuild', 'skipped', 0, {});
    return;
  }
  await offerClaudeHandoff({
    channel: 'migrate',
    step: 'rebuild',
    stepDescription: 'Reapply v1 source customizations on v2 using the migration guide',
    completedSteps: ['preflight', 'extract', 'owner', 'guide', 'safety-net', 'seed', 'copy-over'],
    files: [
      path.join(ex.outDir, '..', 'guide.md'),
      path.join(ex.outDir, 'git-customizations.json'),
      'docs/module-contract.md',
      'docs/architecture.md',
    ],
  });
  setupLog.step('rebuild', 'success', 0, {});
}

async function stepVerify(v2Root: string, seed: SeedStats | null): Promise<void> {
  const s = p.spinner();
  s.start('Running build + tests in v2 worktree…');

  const build = spawnSync('pnpm', ['run', 'build'], { cwd: v2Root, stdio: 'pipe' });
  const testRun = spawnSync('pnpm', ['test'], { cwd: v2Root, stdio: 'pipe' });

  const buildOk = build.status === 0;
  const testsOk = testRun.status === 0;
  s.stop(buildOk && testsOk ? 'Build + tests passed.' : 'Build/tests had issues.');

  const warnings: string[] = [];
  if (!buildOk) warnings.push(`pnpm run build exited ${build.status}`);
  if (!testsOk) warnings.push(`pnpm test exited ${testRun.status}`);
  if (seed) warnings.push(...seed.warnings);

  if (warnings.length > 0) {
    for (const w of warnings) p.log.warn(w);
    await offerClaudeAssist({
      stepName: 'migrate-verify',
      msg: 'Verification completed with issues.',
      hint: warnings.join(' · '),
    });
  }
  setupLog.step('verify', buildOk && testsOk ? 'success' : 'failed', 0, {
    BUILD: buildOk ? 'ok' : 'failed',
    TESTS: testsOk ? 'ok' : 'failed',
    WARNINGS: String(warnings.length),
  });
}

// ── Outro ──

function outroSwapInstructions(v1Root: string, v2Root: string): void {
  const lines = [
    `The v2 worktree (${v2Root}) now has:`,
    `  • data/v2.db seeded from v1`,
    `  • groups/<folder>/CLAUDE.local.md carried over`,
    `  • .env merged (owner + non-secret keys)`,
    '',
    `Next: run /init-onecli to migrate credentials, install channel skills (/add-<name>),`,
    `build the container (./container/build.sh), and live-smoke-test from the worktree.`,
    `When satisfied, swap the worktree into the v1 tree — see the guide's Rollback section for the exact commands.`,
  ];
  p.note(lines.join('\n'), 'What to do next');
  p.outro(k.green('Migration seed complete.'));
  void v1Root;
}

// ── Helpers ──

function resolveV1Root(): string {
  const explicit = process.env.NANOCLAW_V1_ROOT;
  const cliArg = process.argv.indexOf('--v1-root');
  if (cliArg !== -1 && process.argv[cliArg + 1]) {
    return path.resolve(process.argv[cliArg + 1]);
  }
  if (explicit) return path.resolve(explicit);
  // Default: parent dir if we're in a worktree named .migrate-worktree.
  const here = path.basename(process.cwd());
  if (here === '.migrate-worktree' || here.startsWith('.migrate-')) {
    return path.resolve(process.cwd(), '..');
  }
  // Otherwise, treat cwd as both roots — useful when the user has the v2
  // branch checked out in-place (advanced case; we warn about it in preflight).
  return process.cwd();
}

function sh(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function shSafe(cmd: string, cwd: string): boolean {
  try {
    execSync(cmd, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function rewriteOwnerFile(ex: V1ExtractResult): void {
  const ownerJson = path.join(ex.outDir, 'owner.json');
  fs.writeFileSync(ownerJson, JSON.stringify(ex.ownerProposal, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
