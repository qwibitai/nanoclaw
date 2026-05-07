import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { openMnemonIngestDb, runMnemonIngestMigrations } from '../db/migrations/019-mnemon-ingest-db.js';
import { HealthRecorder } from './health.js';
import { setDeadLettersDb, getDueRetries, deleteAfterSuccess } from './dead-letters.js';
import { runChatStreamSweep, setIngestDb } from './classifier.js';
import { SourceIngester, setIngestDb as setSourceIngestDb, isNonSymlinkChain } from './source-ingest.js';
import { readContainerConfig, isFeedbackEnabled } from '../container-config.js';
import { GROUPS_DIR, CC_PROJECTS_DIR, CC_MEMORY_MARKER } from '../config.js';
import type { MemoryStore } from '../modules/memory/store.js';
import { processPendingJudgments } from './recall-judge/judge.js';

const SWEEP_INTERVAL_MS = 60_000;

export interface DiscoveredGroup {
  agentGroupId: string;
  folder: string;
  // Absolute path to the directory that contains `sources/`. For
  // GROUPS_DIR-discovered groups this is `<GROUPS_DIR>/<folder>`. For
  // CC-discovered groups this is `<CC_PROJECTS_DIR>/<slug>`. Consumers compute
  // inbox / processed paths from this base.
  sourcesBasePath: string;
  enabled: boolean;
  feedbackEnabled: boolean;
}

// Exported for unit tests. Production code calls it from runSweep below.
export function discoverMemoryGroups(health?: HealthRecorder): DiscoveredGroup[] {
  const groups: DiscoveredGroup[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(GROUPS_DIR);
    // Successful re-read clears any prior groups-dir failure so the operator
    // can see "transient error → recovered" in memory-health.json instead of
    // a stale failure counter.
    health?.clearMemoryEnabledCheckFailure('__groups_dir__');
  } catch (err) {
    console.warn('[memory-daemon] failed to read groups dir:', err);
    // Emit health signal with a synthetic group key so the failure is visible
    // in memory-health.json even when we can't enumerate group IDs.
    health?.recordMemoryEnabledCheckFailure('__groups_dir__', String(err));
    return groups;
  }

  for (const entry of entries) {
    const fullPath = path.join(GROUPS_DIR, entry);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    let config;
    try {
      config = readContainerConfig(entry);
    } catch (err) {
      console.warn(`[memory-daemon] failed to read container config for ${entry}:`, err);
      health?.recordMemoryEnabledCheckFailure(entry, String(err));
      continue;
    }

    const agentGroupId = config.agentGroupId;
    if (!agentGroupId) continue;

    // Only clear the failure once we've confirmed the config is actually
    // valid (has agentGroupId). readContainerConfig swallows malformed JSON
    // and returns an empty config, so a clean throwless return doesn't
    // necessarily mean the file is recovered — it could just be empty.
    health?.clearMemoryEnabledCheckFailure(entry);

    // Codex F6 round 2 (2026-05-05): legacy agent groups have the same
    // bypass surface as CC projects — `<group>/sources/inbox` could be a
    // symlink to another group's inbox, breaking cross-tenant isolation.
    // Skip the group entirely on intermediate-symlink detection.
    if (!isNonSymlinkChain(fullPath, 'sources', 'inbox')) continue;

    groups.push({
      agentGroupId,
      folder: entry,
      sourcesBasePath: fullPath,
      enabled: config.memory?.enabled === true,
      feedbackEnabled: isFeedbackEnabled(config.memory),
    });
  }

  // Drop stale entries for groups that no longer exist on disk. The per-loop
  // clear above doesn't fire for deleted entries (the loop never visits them).
  health?.pruneMemoryEnabledCheckFailures(new Set(entries));

  // CC-side discovery: walk ~/.claude/projects/<slug>/ for `.memory-enabled`
  // markers. Each marked project becomes a discovered group with agentGroupId
  // `cc-<slug>` and per-project store at the same name. CC sessions opt in by
  // dropping the marker (the CC hooks at ~/.claude/hooks/cc-mnemon/ create it
  // on first turn for default-on behavior). Discovery is best-effort — a
  // missing CC_PROJECTS_DIR is normal on hosts that don't run CC.
  // Codex F6 (2026-05-05): a previous version used fs.statSync + fs.existsSync
  // which both follow symlinks. A symlink under CC_PROJECTS_DIR pointing at
  // another marked project would be discovered as a new cc-<slug> group with
  // sourcesBasePath set to the symlink path; downstream realpath checks
  // validate against the inbox path (not the project root), so files from one
  // project could be ingested into another's store, breaking cross-tenant
  // isolation. Hardening:
  //   1. readdirSync with withFileTypes:true → reject Dirents that ARE symlinks
  //   2. realpath project root, require it to be a direct child of realpath(CC_PROJECTS_DIR)
  //   3. lstat the marker (not existsSync) and require it to be a regular file
  let ccDirents: fs.Dirent[];
  try {
    ccDirents = fs.readdirSync(CC_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return groups;
  }
  let ccRootReal: string;
  try {
    ccRootReal = fs.realpathSync(CC_PROJECTS_DIR);
  } catch {
    return groups;
  }
  for (const dirent of ccDirents) {
    const entry = dirent.name;
    const projectPath = path.join(CC_PROJECTS_DIR, entry);
    // Reject symlinks at the readdir level — Dirent.isSymbolicLink() reflects
    // the lstat type, so we don't follow the link before classifying it.
    if (dirent.isSymbolicLink()) continue;
    if (!dirent.isDirectory()) continue;
    // Realpath the project to defend against bind-mounts or hard-link tricks
    // that bypass the Dirent symlink check, and require it to be a direct
    // child of CC_PROJECTS_DIR's realpath.
    let projectReal: string;
    try {
      projectReal = fs.realpathSync(projectPath);
    } catch {
      continue;
    }
    if (path.dirname(projectReal) !== ccRootReal) continue;
    // Marker must be a regular file (not a symlink, not a directory).
    const markerPath = path.join(projectPath, CC_MEMORY_MARKER);
    let markerStat: fs.Stats;
    try {
      markerStat = fs.lstatSync(markerPath);
    } catch {
      continue;
    }
    if (!markerStat.isFile()) continue;
    // Codex F6 round 2 (2026-05-05): also reject if `sources` or
    // `sources/inbox` are symlinks. A project with a non-symlink root and
    // marker can still symlink an intermediate dir to another project's
    // inbox; readdirSync/realpathSync at sweep time would follow the link
    // and ingest victim files into this group's store. The chain check
    // closes that bypass at discovery (and is re-checked at use time).
    if (!isNonSymlinkChain(projectPath, 'sources', 'inbox')) continue;
    groups.push({
      agentGroupId: `cc-${entry}`,
      folder: entry,
      sourcesBasePath: projectPath,
      enabled: true,
      feedbackEnabled: true, // CC groups default feedback=true
    });
  }

  return groups;
}

export async function runSweep(
  ingester: SourceIngester,
  health: HealthRecorder,
  store: MemoryStore,
  ingestDb?: import('better-sqlite3').Database,
): Promise<void> {
  const allGroups = discoverMemoryGroups(health);
  const enabledGroups = allGroups.filter((g) => g.enabled);

  ingester.reconcileWatchers(allGroups);

  await runChatStreamSweep(enabledGroups, store, health);

  for (const group of enabledGroups) {
    // Codex F6 round 2: re-validate the chain at use time. Discovery
    // already filtered, but a symlink swap between sweeps could TOCTOU
    // around the discovery-time check. Cheap to re-run; closes the window.
    if (!isNonSymlinkChain(group.sourcesBasePath, 'sources', 'inbox')) continue;
    const inboxPath = path.join(group.sourcesBasePath, 'sources', 'inbox');
    let files: string[];
    let inboxRealPath: string;
    try {
      files = fs.readdirSync(inboxPath);
      inboxRealPath = fs.realpathSync(inboxPath);
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(inboxPath, file);
      // lstat (not stat) so we don't follow symlinks. A container with write
      // access to its own sources/inbox could plant a symlink to another
      // group's file or any host-readable path; following it would let the
      // classifier read & extract facts from cross-tenant data.
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      // Require the realpath to stay under the inbox root — defense in depth
      // in case lstat reports false-negative on a hard link or unusual fs.
      let realPath: string;
      try {
        realPath = fs.realpathSync(filePath);
      } catch {
        continue;
      }
      if (!realPath.startsWith(inboxRealPath + path.sep)) continue;
      await ingester.processInboxFile(group.agentGroupId, group.sourcesBasePath, realPath, store, health);
    }
  }

  for (const group of enabledGroups) {
    const due = getDueRetries(group.agentGroupId, new Date());
    for (const retry of due) {
      if (retry.itemType === 'turn-pair') {
        await runChatStreamSweep([group], store, health);
        break;
      } else if (retry.itemType === 'source-file') {
        if (fs.existsSync(retry.itemKey)) {
          await ingester.processInboxFile(group.agentGroupId, group.sourcesBasePath, retry.itemKey, store, health);
        } else {
          // File no longer exists at the recorded path — already moved to
          // processed/ (success or binary-guard skip) or manually removed.
          // Without this clear, the dead_letter row sits forever and the
          // retry loop keeps finding it on every sweep, doing nothing.
          deleteAfterSuccess(retry.itemKey, group.agentGroupId);
        }
      }
    }
  }

  // Judge processor: score pending recall outcomes for feedback-enabled groups
  for (const group of enabledGroups) {
    if (!group.feedbackEnabled) continue;
    try {
      await processPendingJudgments({ agentGroupId: group.agentGroupId });
    } catch (err) {
      console.error(`[memory-daemon] judge processor error for ${group.agentGroupId}:`, err);
    }
  }

  // Nightly task: run once per UTC day at ≥ 4am
  if (ingestDb) {
    const nowUtc = new Date();
    const utcHour = nowUtc.getUTCHours();
    const todayUtc = nowUtc.toISOString().slice(0, 10); // YYYY-MM-DD

    const lastNightlyRow = ingestDb.prepare(`SELECT value FROM daemon_state WHERE key = 'lastNightlyAt'`).get() as
      | { value: string }
      | undefined;
    const lastNightlyAt = lastNightlyRow?.value ?? null;

    if (utcHour >= 4 && lastNightlyAt !== todayUtc) {
      try {
        ingestDb
          .prepare(`DELETE FROM recall_outcomes WHERE created_at < ?`)
          .run(new Date(Date.now() - 90 * 24 * 3_600_000).toISOString());
        const nowIso = nowUtc.toISOString();
        ingestDb
          .prepare(
            `INSERT INTO daemon_state (key, value, updated_at) VALUES ('lastNightlyAt', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(todayUtc, nowIso);
        console.log(`[memory-daemon] nightly tasks complete (${todayUtc})`);
      } catch (err) {
        console.error('[memory-daemon] nightly task error:', err);
      }
    }
  }

  // Merge host Ollama status before flush
  await health.mergeHostOllamaStatus();

  await health.flush();
}

async function main(): Promise<void> {
  // G3 prereq verification
  try {
    execSync('bash scripts/verify-memory-prereqs.sh', { stdio: 'inherit' });
  } catch {
    const scriptExists = fs.existsSync('scripts/verify-memory-prereqs.sh');
    if (scriptExists) {
      console.error('[memory-daemon] prereq verification failed — exiting');
      process.exit(1);
    } else {
      console.warn('[memory-daemon] scripts/verify-memory-prereqs.sh not found — skipping prereq check');
    }
  }

  const db = openMnemonIngestDb();
  runMnemonIngestMigrations(db);

  setIngestDb(db);
  setSourceIngestDb(db);
  setDeadLettersDb(db);

  const health = new HealthRecorder();
  health.setIngestDbForTest(db); // wire production DB for recall_quality queries

  // Lazy import MnemonStore (Group A)
  const { MnemonStore } = await import('../modules/memory/mnemon-impl.js');
  const store = new MnemonStore();

  const ingester = new SourceIngester();
  // Wire the production runtime so the inotify watcher's fast-path can write
  // facts via MemoryStore. Without this, the watcher silently no-ops because
  // its setImmediate callback hits the Database-only test branch.
  ingester.setRuntime(store, health);

  let inFlight = false;
  let shutdownRequested = false;
  // Wake-up handle so SIGTERM can exit the inter-sweep wait without burning
  // up to SWEEP_INTERVAL_MS of TimeoutStopSec budget.
  let wakeWait: (() => void) | null = null;

  async function sweepLoop(): Promise<void> {
    while (!shutdownRequested) {
      inFlight = true;
      try {
        await runSweep(ingester, health, store, db);
      } catch (err) {
        console.error('[memory-daemon] sweep error:', err);
      } finally {
        inFlight = false;
      }

      if (shutdownRequested) break;

      await new Promise<void>((resolve) => {
        // The timer is intentionally NOT unref'd — it's the daemon's primary
        // event-loop anchor between sweeps. With it unref'd, Node would see
        // no active handles and exit cleanly the moment a sweep returns.
        // This was a long-standing bug: the daemon was exiting after every
        // sweep cycle, surviving only as long as a sweep took to complete.
        // shutdown() wakes this wait early via wakeWait() so SIGTERM still
        // exits within a few hundred ms.
        const timer = setTimeout(() => {
          wakeWait = null;
          resolve();
        }, SWEEP_INTERVAL_MS);
        wakeWait = () => {
          clearTimeout(timer);
          wakeWait = null;
          resolve();
        };
      });
    }
  }

  async function shutdown(): Promise<void> {
    console.log('[memory-daemon] SIGTERM received — waiting for in-flight sweep to complete');
    shutdownRequested = true;
    // Wake the inter-sweep wait so we don't burn up to 60s on TimeoutStopSec.
    if (wakeWait) wakeWait();

    while (inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await ingester.shutdown();
    await health.flush();
    console.log('[memory-daemon] shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown();
  });

  process.on('SIGINT', () => {
    void shutdown();
  });

  console.log('[memory-daemon] starting sweep loop (interval: 60s)');
  await sweepLoop();
}

main().catch((err) => {
  console.error('[memory-daemon] fatal error:', err);
  process.exit(1);
});
