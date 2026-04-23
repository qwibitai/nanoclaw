/**
 * Step: migrate-groups
 *
 * Copy v1 group folders into v2. For each folder selected in migrate-db:
 *   - Create groups/<folder>/ in v2 if missing
 *   - Copy v1's CLAUDE.md to v2 as CLAUDE.local.md (v2 composes CLAUDE.md at
 *     container spawn — don't write directly to CLAUDE.md)
 *   - If v1 had a container_config JSON, write it to .v1-container-config.json
 *     for the /migrate-from-v1 skill to reconcile (v2's container.json shape
 *     has drifted enough that a silent 1:1 copy would be wrong)
 *   - Preserve any other non-standard files from the v1 folder (e.g. SOUL.md,
 *     personality.md, custom subdirs) — rsync-style, skipping destination files
 *     that already exist.
 *
 * Does not overwrite files already present in v2 — re-running is safe.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { log } from '../../src/log.js';
import { emitStatus } from '../status.js';
import {
  readHandoff,
  recordStep,
  safeJsonStringify,
  scanForV1Patterns,
  v1PathsFor,
  writeHandoff,
} from './shared.js';

const SKIP_NAMES = new Set(['CLAUDE.md', 'logs', '.git', '.DS_Store', 'node_modules']);

/**
 * Copy everything in src except SKIP_NAMES. CLAUDE.md is handled separately.
 * Returns the count of files actually written (skipped-existing not counted).
 */
function copyTree(src: string, dst: string): number {
  let written = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      written += copyTree(s, d);
      continue;
    }
    // Don't clobber files v2 already has (e.g. CLAUDE.local.md that the
    // operator already wrote). Append-only semantics for this step.
    if (fs.existsSync(d)) continue;
    fs.copyFileSync(s, d);
    written += 1;
  }
  return written;
}

export async function run(_args: string[]): Promise<void> {
  const h = readHandoff();
  if (!h.v1_path) {
    recordStep('migrate-groups', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_GROUPS', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  if (h.group_selection.selected_folders.length === 0) {
    recordStep('migrate-groups', {
      status: 'skipped',
      fields: { REASON: 'no-folders-selected' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_GROUPS', { STATUS: 'skipped', REASON: 'no_selection' });
    return;
  }

  const paths = v1PathsFor(h.v1_path);
  const v2GroupsDir = path.join(process.cwd(), 'groups');
  fs.mkdirSync(v2GroupsDir, { recursive: true });

  // Pull container_config for each selected folder up-front so we can write
  // the .v1-container-config.json sidecar without holding the DB open per-folder.
  const containerConfigs = new Map<string, string | null>();
  try {
    const v1Db = new Database(paths.db, { readonly: true, fileMustExist: true });
    const rows = v1Db
      .prepare('SELECT folder, container_config FROM registered_groups WHERE folder IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(h.group_selection.selected_folders)) as Array<{ folder: string; container_config: string | null }>;
    for (const r of rows) containerConfigs.set(r.folder, r.container_config);
    v1Db.close();
  } catch (err) {
    // Older sqlite without json_each would break the query. Fall back to
    // per-folder reads — slower but reliable.
    log.info('Falling back to per-folder container_config lookup', { err });
    try {
      const v1Db = new Database(paths.db, { readonly: true, fileMustExist: true });
      const stmt = v1Db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?');
      for (const folder of h.group_selection.selected_folders) {
        const row = stmt.get(folder) as { container_config: string | null } | undefined;
        containerConfigs.set(folder, row?.container_config ?? null);
      }
      v1Db.close();
    } catch {
      // Give up — we still migrate files; the skill handles missing config.
    }
  }

  let foldersProcessed = 0;
  let foldersSkippedMissing = 0;
  let claudeMdMigrated = 0;
  let claudeLocalPreserved = 0;
  let containerConfigsStashed = 0;
  let otherFilesCopied = 0;
  const followups: string[] = [];

  for (const folder of h.group_selection.selected_folders) {
    const v1Folder = path.join(paths.groups, folder);
    const v2Folder = path.join(v2GroupsDir, folder);

    if (!fs.existsSync(v1Folder)) {
      foldersSkippedMissing += 1;
      followups.push(
        `Folder "${folder}" was in v1's registered_groups but not on disk at ${v1Folder} — DB entry was seeded, no files to migrate.`,
      );
      continue;
    }

    fs.mkdirSync(v2Folder, { recursive: true });

    // CLAUDE.md → CLAUDE.local.md. Don't write CLAUDE.md directly — v2's
    // group-init.ts composes that file from shared + fragments + local.
    const v1Claude = path.join(v1Folder, 'CLAUDE.md');
    const v2Local = path.join(v2Folder, 'CLAUDE.local.md');
    let claudeContent: string | null = null;
    if (fs.existsSync(v1Claude)) {
      if (fs.existsSync(v2Local)) {
        claudeLocalPreserved += 1;
        try {
          claudeContent = fs.readFileSync(v2Local, 'utf-8');
        } catch {
          claudeContent = null;
        }
      } else {
        try {
          claudeContent = fs.readFileSync(v1Claude, 'utf-8');
          fs.writeFileSync(v2Local, claudeContent);
          claudeMdMigrated += 1;
        } catch (err) {
          followups.push(`Failed to copy CLAUDE.md for "${folder}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Scan the copied content for v1-specific infrastructure patterns. If we
    // find any, add a followup so the /migrate-from-v1 skill can triage the
    // file with the user. We DON'T edit the file — v1 CLAUDE.md can be
    // author-specific and heuristic translation is worse than a flag.
    if (claudeContent) {
      const matches = scanForV1Patterns(claudeContent);
      if (matches.length > 0) {
        const summary = matches
          .map((m) => `${m.description} (lines ${m.lines.join(',')})`)
          .join('; ');
        followups.push(
          `Folder "${folder}" CLAUDE.local.md references v1-specific infrastructure: ${summary}. The skill should read the file and translate patterns using docs/v1-to-v2-changes.md.`,
        );
      }
    }

    // Stash container_config JSON so the skill can reconcile it.
    const config = containerConfigs.get(folder);
    if (config) {
      const sidecar = path.join(v2Folder, '.v1-container-config.json');
      try {
        // Pretty-print so humans can read it during reconciliation.
        const parsed = JSON.parse(config) as unknown;
        fs.writeFileSync(sidecar, safeJsonStringify(parsed));
        containerConfigsStashed += 1;
        followups.push(
          `Folder "${folder}" has a v1 container_config — stashed at ${path.relative(process.cwd(), sidecar)}. The /migrate-from-v1 skill will map it to v2's container.json shape.`,
        );
      } catch {
        // Non-JSON container_config — write raw so the skill can still read it.
        fs.writeFileSync(sidecar, config);
        containerConfigsStashed += 1;
      }
    }

    otherFilesCopied += copyTree(v1Folder, v2Folder);
    foldersProcessed += 1;
  }

  // Merge followups.
  const handoffAfter = readHandoff();
  handoffAfter.followups = [...new Set([...handoffAfter.followups, ...followups])];
  writeHandoff(handoffAfter);

  const partial = foldersSkippedMissing > 0;
  recordStep('migrate-groups', {
    status: partial ? 'partial' : 'success',
    fields: {
      FOLDERS_PROCESSED: foldersProcessed,
      FOLDERS_SKIPPED_MISSING: foldersSkippedMissing,
      CLAUDE_MD_MIGRATED: claudeMdMigrated,
      CLAUDE_LOCAL_PRESERVED: claudeLocalPreserved,
      CONTAINER_CONFIGS_STASHED: containerConfigsStashed,
      OTHER_FILES_COPIED: otherFilesCopied,
    },
    notes: followups,
    at: new Date().toISOString(),
  });

  emitStatus('MIGRATE_GROUPS', {
    STATUS: partial ? 'partial' : 'success',
    FOLDERS_PROCESSED: String(foldersProcessed),
    FOLDERS_SKIPPED_MISSING: String(foldersSkippedMissing),
    CLAUDE_MD_MIGRATED: String(claudeMdMigrated),
    CONTAINER_CONFIGS_STASHED: String(containerConfigsStashed),
    OTHER_FILES_COPIED: String(otherFilesCopied),
  });
}
