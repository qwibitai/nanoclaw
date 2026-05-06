/**
 * Build a backup tar.gz from an enumerated set of files.
 *
 * Layout written (all paths POSIX, all relative to tar root):
 *
 *   manifest.json                              (always first, for streaming readers)
 *   central/v2.db
 *   agent-groups/<agent_group_id>/group/CLAUDE.local.md
 *   agent-groups/<agent_group_id>/group/container.json
 *   agent-groups/<agent_group_id>/claude-shared/<...>
 *   agent-groups/<agent_group_id>/sessions/<session_id>/inbound.db
 *   agent-groups/<agent_group_id>/sessions/<session_id>/outbound.db
 *   agent-groups/<agent_group_id>/sessions/<session_id>/<rest of session dir>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { create as tarCreate } from 'tar';

import { walkFiles } from './inventory.js';
import { FORMAT_VERSION, MANIFEST_FILENAME, type Manifest, type ManifestAgentGroup } from './manifest.js';
import { snapshotSqlite } from './sqlite-snapshot.js';
import { INSTALL_SLUG } from '../config.js';
import { inboundDbPath, outboundDbPath } from '../session-manager.js';
import { log } from '../log.js';
import type { BackupTargets } from './inventory.js';

export interface BuildArchiveArgs {
  targets: BackupTargets;
  centralDbPath: string;
  archivePath: string;
  /** Path to the staging directory used for SQLite snapshots. Cleaned at end. */
  stagingDir: string;
  /** Read package.json once, pass in. */
  nanoclawVersion: string;
  /** List of table names present in the central DB at backup time. */
  centralTablesPresent: string[];
}

const CLAUDE_SHARED_SKIP = ['skills'];

export async function buildArchive(args: BuildArchiveArgs): Promise<{ bytes: number; manifest: Manifest }> {
  const { targets, centralDbPath, archivePath, stagingDir, nanoclawVersion, centralTablesPresent } = args;

  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });

  // 1. Snapshot central DB into staging.
  const stagedCentralDb = path.join(stagingDir, 'central-v2.db');
  await snapshotSqlite(centralDbPath, stagedCentralDb);
  const centralDbSize = fs.statSync(stagedCentralDb).size;

  // 2. Snapshot each session DB into staging. Keyed by tar-relative path
  //    so we can splice them in at the right place during pack. Doing the
  //    DBs first means an inbox attachment recorded in messages_in is
  //    guaranteed to still exist on disk when we tar it (the live writer
  //    can't roll the message back after we've snapshotted).
  const stagedSessionDbs: Array<{ tarPath: string; stagedPath: string; size: number }> = [];
  const manifestAgentGroups: ManifestAgentGroup[] = [];

  for (const ag of targets.agent_groups) {
    const sessionEntries: ManifestAgentGroup['sessions'] = [];

    for (const s of ag.sessions) {
      const inSrc = inboundDbPath(ag.group.id, s.session.id);
      const outSrc = outboundDbPath(ag.group.id, s.session.id);

      const inDst = path.join(stagingDir, `${ag.group.id}-${s.session.id}-inbound.db`);
      const outDst = path.join(stagingDir, `${ag.group.id}-${s.session.id}-outbound.db`);

      let inboundSize = 0;
      let outboundSize = 0;
      if (fs.existsSync(inSrc)) {
        await snapshotSqlite(inSrc, inDst);
        inboundSize = fs.statSync(inDst).size;
        stagedSessionDbs.push({
          tarPath: `agent-groups/${ag.group.id}/sessions/${s.session.id}/inbound.db`,
          stagedPath: inDst,
          size: inboundSize,
        });
      }
      if (fs.existsSync(outSrc)) {
        await snapshotSqlite(outSrc, outDst);
        outboundSize = fs.statSync(outDst).size;
        stagedSessionDbs.push({
          tarPath: `agent-groups/${ag.group.id}/sessions/${s.session.id}/outbound.db`,
          stagedPath: outDst,
          size: outboundSize,
        });
      }

      // Walk the session dir for everything else (inbox, outbox, agent, group, ipc).
      const sessionFiles = walkFiles(s.dir, {
        skipRelativePrefixes: ['inbound.db', 'outbound.db', 'inbound.db-journal', 'outbound.db-journal', '.heartbeat'],
      });

      sessionEntries.push({
        id: s.session.id,
        inbound_size: inboundSize,
        outbound_size: outboundSize,
        session_dir_files: sessionFiles.length,
        session_dir_bytes: sessionFiles.reduce((acc, f) => acc + f.size, 0),
      });
    }

    const claudeLocalMdPath = path.join(ag.groupFolderDir, 'CLAUDE.local.md');
    const containerJsonPath = path.join(ag.groupFolderDir, 'container.json');
    const claudeSharedFiles = walkFiles(ag.claudeSharedDir, { skipRelativePrefixes: CLAUDE_SHARED_SKIP });

    manifestAgentGroups.push({
      id: ag.group.id,
      name: ag.group.name,
      folder: ag.group.folder,
      has_claude_local_md: fs.existsSync(claudeLocalMdPath),
      has_container_json: fs.existsSync(containerJsonPath),
      claude_shared_bytes: claudeSharedFiles.reduce((acc, f) => acc + f.size, 0),
      sessions: sessionEntries,
    });
  }

  // 3. Build manifest, write to staging so tar can pick it up by file path.
  const manifest: Manifest = {
    format_version: FORMAT_VERSION,
    nanoclaw_version: nanoclawVersion,
    install_slug: INSTALL_SLUG,
    created_at: new Date().toISOString(),
    central_db_size: centralDbSize,
    agent_groups: manifestAgentGroups,
    central_tables_present: centralTablesPresent,
  };
  const manifestStagedPath = path.join(stagingDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestStagedPath, JSON.stringify(manifest, null, 2));

  // 4. Pack: assemble a temp directory whose layout mirrors the desired
  //    tar layout, then tar it. This is the simplest way to use node-tar
  //    streaming without building a custom Pack stream — staging is local
  //    and short-lived so the duplication cost is bounded.
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-backup-pack-'));
  try {
    fs.copyFileSync(manifestStagedPath, path.join(packRoot, MANIFEST_FILENAME));

    fs.mkdirSync(path.join(packRoot, 'central'), { recursive: true });
    fs.copyFileSync(stagedCentralDb, path.join(packRoot, 'central', 'v2.db'));

    for (const ag of targets.agent_groups) {
      const agRoot = path.join(packRoot, 'agent-groups', ag.group.id);
      const groupOut = path.join(agRoot, 'group');
      const sharedOut = path.join(agRoot, 'claude-shared');
      fs.mkdirSync(groupOut, { recursive: true });
      fs.mkdirSync(sharedOut, { recursive: true });

      const claudeLocalMdPath = path.join(ag.groupFolderDir, 'CLAUDE.local.md');
      const containerJsonPath = path.join(ag.groupFolderDir, 'container.json');
      if (fs.existsSync(claudeLocalMdPath)) {
        fs.copyFileSync(claudeLocalMdPath, path.join(groupOut, 'CLAUDE.local.md'));
      }
      if (fs.existsSync(containerJsonPath)) {
        fs.copyFileSync(containerJsonPath, path.join(groupOut, 'container.json'));
      }

      const sharedFiles = walkFiles(ag.claudeSharedDir, { skipRelativePrefixes: CLAUDE_SHARED_SKIP });
      for (const f of sharedFiles) {
        const dst = path.join(sharedOut, f.relativePath);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(f.absolutePath, dst);
      }

      for (const s of ag.sessions) {
        const sessRoot = path.join(agRoot, 'sessions', s.session.id);
        fs.mkdirSync(sessRoot, { recursive: true });

        const inDst = path.join(sessRoot, 'inbound.db');
        const outDst = path.join(sessRoot, 'outbound.db');
        const stagedIn = stagedSessionDbs.find(
          (e) => e.tarPath === `agent-groups/${ag.group.id}/sessions/${s.session.id}/inbound.db`,
        );
        const stagedOut = stagedSessionDbs.find(
          (e) => e.tarPath === `agent-groups/${ag.group.id}/sessions/${s.session.id}/outbound.db`,
        );
        if (stagedIn) fs.copyFileSync(stagedIn.stagedPath, inDst);
        if (stagedOut) fs.copyFileSync(stagedOut.stagedPath, outDst);

        const sessionFiles = walkFiles(s.dir, {
          skipRelativePrefixes: [
            'inbound.db',
            'outbound.db',
            'inbound.db-journal',
            'outbound.db-journal',
            '.heartbeat',
          ],
        });
        for (const f of sessionFiles) {
          const dst = path.join(sessRoot, f.relativePath);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(f.absolutePath, dst);
        }
      }
    }

    // 5. tar.gz the prepared root. node-tar gzips natively when `gzip: true`.
    //    The list is the children of packRoot — keeps relative paths inside
    //    the tar without a leading `./<tmpname>/`.
    const entries = fs.readdirSync(packRoot);
    await tarCreate(
      {
        gzip: true,
        file: archivePath,
        cwd: packRoot,
        // Sorted entries → reproducible-ish tarballs (timestamps still differ).
        portable: true,
      },
      entries.sort(),
    );
  } finally {
    fs.rmSync(packRoot, { recursive: true, force: true });
  }

  const bytes = fs.statSync(archivePath).size;
  log.info('Backup archive built', { archivePath, bytes });
  return { bytes, manifest };
}
