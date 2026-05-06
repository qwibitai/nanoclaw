/**
 * Restore from a backup archive — full project or per-agent slice.
 *
 * Refuses to run if any container has `container_status IN ('running', 'idle')`.
 * Full restore renames existing files to `*.pre-restore-<ts>` rather than
 * delete. Per-agent restore opens the archive's central DB read-only, copies
 * INSERT-OR-REPLACE rows scoped to one agent_group_id, and resolves FK
 * references against the live DB; orphans require `--force-orphan`.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { getDb } from '../db/connection.js';
import { getRunningSessions } from '../db/sessions.js';
import { sessionDir, sessionsBaseDir } from '../session-manager.js';

import { extractArchive, readManifestFromExtracted } from './extract.js';
import { LocalStorageBackend } from './storage/local.js';
import { S3StorageBackend } from './storage/s3.js';

export interface RestoreOptions {
  archiveName: string;
  from: 'local' | 's3';
  onlyAgentGroupId?: string;
  dryRun?: boolean;
  forceOrphan?: boolean;
}

export interface RestoreResult {
  dryRun: boolean;
  plannedRows: PlannedRows;
  orphans: string[];
}

interface PlannedRows {
  agent_groups: number;
  messaging_group_agents: number;
  agent_group_members: number;
  user_roles: number;
  sessions: number;
  pending_sender_approvals: number;
  pending_questions: number;
  pending_approvals: number;
}

function emptyPlannedRows(): PlannedRows {
  return {
    agent_groups: 0,
    messaging_group_agents: 0,
    agent_group_members: 0,
    user_roles: 0,
    sessions: 0,
    pending_sender_approvals: 0,
    pending_questions: 0,
    pending_approvals: 0,
  };
}

function ensureNoLiveContainers(): void {
  const live = getRunningSessions();
  if (live.length > 0) {
    throw new Error(`Refusing restore: ${live.length} session(s) report a running container. Stop the host first.`);
  }
}

async function fetchToLocal(archiveName: string, from: 'local' | 's3'): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restore-fetch-'));
  const dest = path.join(tmpDir, archiveName);
  if (from === 'local') {
    await new LocalStorageBackend().fetchArchive(archiveName, dest);
  } else {
    await new S3StorageBackend().fetchArchive(archiveName, dest);
  }
  return dest;
}

export async function restoreArchive(opts: RestoreOptions): Promise<RestoreResult> {
  ensureNoLiveContainers();

  const fetched = await fetchToLocal(opts.archiveName, opts.from);

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restore-extract-'));
  const filterPrefixes = opts.onlyAgentGroupId ? ['central', `agent-groups/${opts.onlyAgentGroupId}`] : undefined;
  await extractArchive(fetched, stagingDir, { filterPrefixes });

  const manifest = readManifestFromExtracted(stagingDir);

  if (opts.onlyAgentGroupId) {
    return restorePerAgent({ ...opts, stagingDir, manifestAgentIds: manifest.agent_groups.map((a) => a.id) });
  }
  return restoreFull({ stagingDir, dryRun: !!opts.dryRun });
}

interface FullRestoreArgs {
  stagingDir: string;
  dryRun: boolean;
}

async function restoreFull({ stagingDir, dryRun }: FullRestoreArgs): Promise<RestoreResult> {
  const planned = emptyPlannedRows();

  // Count rows we'd write so the dry-run summary is informative.
  const stagedCentral = path.join(stagingDir, 'central', 'v2.db');
  if (fs.existsSync(stagedCentral)) {
    const src = new Database(stagedCentral, { readonly: true });
    try {
      planned.agent_groups = (src.prepare('SELECT COUNT(*) AS c FROM agent_groups').get() as { c: number }).c;
      planned.sessions = (src.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    } finally {
      src.close();
    }
  }

  if (dryRun) {
    return { dryRun: true, plannedRows: planned, orphans: [] };
  }

  // Move existing on-disk state aside (NEVER delete).
  const ts = timestampSuffix();
  movePreRestore(path.join(DATA_DIR, 'v2.db'), ts);
  movePreRestore(path.join(DATA_DIR, 'v2.db-wal'), ts);
  movePreRestore(path.join(DATA_DIR, 'v2.db-shm'), ts);

  // Sessions and groups: walk the archive and overlay onto live tree.
  if (fs.existsSync(stagedCentral)) {
    fs.copyFileSync(stagedCentral, path.join(DATA_DIR, 'v2.db'));
  }

  const stagedAgents = path.join(stagingDir, 'agent-groups');
  if (fs.existsSync(stagedAgents)) {
    for (const agId of fs.readdirSync(stagedAgents)) {
      copyAgentGroupFiles(stagingDir, agId, ts);
    }
  }

  return { dryRun: false, plannedRows: planned, orphans: [] };
}

interface PerAgentArgs extends RestoreOptions {
  stagingDir: string;
  manifestAgentIds: string[];
}

async function restorePerAgent(args: PerAgentArgs): Promise<RestoreResult> {
  const { onlyAgentGroupId, stagingDir, dryRun = false, forceOrphan = false } = args;
  if (!onlyAgentGroupId) throw new Error('onlyAgentGroupId required for per-agent restore');

  const stagedCentral = path.join(stagingDir, 'central', 'v2.db');
  if (!fs.existsSync(stagedCentral)) {
    throw new Error('Per-agent restore needs central/v2.db in archive');
  }
  const src = new Database(stagedCentral, { readonly: true });
  const live = getDb();

  let planned: PlannedRows;
  let orphans: string[];

  try {
    const liveMessagingGroupIds = new Set(
      (live.prepare('SELECT id FROM messaging_groups').all() as Array<{ id: string }>).map((r) => r.id),
    );
    const liveUserIds = new Set((live.prepare('SELECT id FROM users').all() as Array<{ id: string }>).map((r) => r.id));

    // Collect rows from the staged DB.
    const agentRow = src.prepare('SELECT * FROM agent_groups WHERE id = ?').get(onlyAgentGroupId) as
      | Record<string, unknown>
      | undefined;
    if (!agentRow) {
      throw new Error(`Agent group ${onlyAgentGroupId} not in archive`);
    }

    const sessions = src.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(onlyAgentGroupId) as Array<
      Record<string, unknown>
    >;
    const mgaRows = src
      .prepare('SELECT * FROM messaging_group_agents WHERE agent_group_id = ?')
      .all(onlyAgentGroupId) as Array<Record<string, unknown>>;
    const memberRows = tableExistsIn(src, 'agent_group_members')
      ? (src.prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ?').all(onlyAgentGroupId) as Array<
          Record<string, unknown>
        >)
      : [];
    const roleRows = tableExistsIn(src, 'user_roles')
      ? (src.prepare('SELECT * FROM user_roles WHERE agent_group_id = ?').all(onlyAgentGroupId) as Array<
          Record<string, unknown>
        >)
      : [];
    const senderApprovalRows = tableExistsIn(src, 'pending_sender_approvals')
      ? (src.prepare('SELECT * FROM pending_sender_approvals WHERE agent_group_id = ?').all(onlyAgentGroupId) as Array<
          Record<string, unknown>
        >)
      : [];

    // FK orphan detection — track which rows would dangle.
    const sessionIds = new Set(sessions.map((s) => String(s.id)));
    const orphanList: string[] = [];

    const keptSessions = sessions.filter((s) => {
      const mgId = s.messaging_group_id as string | null;
      if (mgId && !liveMessagingGroupIds.has(mgId)) {
        orphanList.push(`sessions(${String(s.id)}) → messaging_groups(${mgId}) missing`);
        return false;
      }
      return true;
    });
    const keptMga = mgaRows.filter((r) => {
      const mgId = r.messaging_group_id as string;
      if (!liveMessagingGroupIds.has(mgId)) {
        orphanList.push(`messaging_group_agents(${String(r.id)}) → messaging_groups(${mgId}) missing`);
        return false;
      }
      return true;
    });
    const keptMembers = memberRows.filter((r) => {
      const userId = r.user_id as string;
      if (!liveUserIds.has(userId)) {
        orphanList.push(`agent_group_members → users(${userId}) missing`);
        return false;
      }
      return true;
    });
    const keptRoles = roleRows.filter((r) => {
      const userId = r.user_id as string;
      if (!liveUserIds.has(userId)) {
        orphanList.push(`user_roles → users(${userId}) missing`);
        return false;
      }
      return true;
    });

    if (orphanList.length > 0 && !forceOrphan) {
      throw new Error(
        `Per-agent restore would create ${orphanList.length} orphan reference(s). Re-run with --force-orphan to drop them.\n` +
          orphanList.map((o) => `  - ${o}`).join('\n'),
      );
    }

    planned = {
      ...emptyPlannedRows(),
      agent_groups: 1,
      messaging_group_agents: keptMga.length,
      agent_group_members: keptMembers.length,
      user_roles: keptRoles.length,
      sessions: keptSessions.length,
      pending_sender_approvals: senderApprovalRows.length,
      pending_questions: 0,
      pending_approvals: 0,
    };

    if (dryRun) {
      return { dryRun: true, plannedRows: planned, orphans: orphanList };
    }

    // Apply within a single transaction; on any error the live DB is unchanged.
    const tx = live.transaction(() => {
      replaceRow(live, 'agent_groups', agentRow);
      for (const r of keptMga) replaceRow(live, 'messaging_group_agents', r);
      for (const r of keptMembers) replaceRow(live, 'agent_group_members', r);
      for (const r of keptRoles) replaceRow(live, 'user_roles', r);
      for (const r of keptSessions) replaceRow(live, 'sessions', r);
      for (const r of senderApprovalRows) replaceRow(live, 'pending_sender_approvals', r);
      // pending_questions/approvals scoped via session_id ∈ keptSessions.
      const keepIds = new Set(keptSessions.map((s) => String(s.id)));
      void sessionIds;
      if (tableExistsIn(src, 'pending_questions')) {
        const pq = src.prepare('SELECT * FROM pending_questions').all() as Array<Record<string, unknown>>;
        for (const r of pq) {
          if (typeof r.session_id === 'string' && keepIds.has(r.session_id)) {
            replaceRow(live, 'pending_questions', r);
            planned.pending_questions++;
          }
        }
      }
      if (tableExistsIn(src, 'pending_approvals')) {
        const pa = src.prepare('SELECT * FROM pending_approvals').all() as Array<Record<string, unknown>>;
        for (const r of pa) {
          if (typeof r.session_id === 'string' && keepIds.has(r.session_id)) {
            replaceRow(live, 'pending_approvals', r);
            planned.pending_approvals++;
          }
        }
      }
    });
    tx();

    orphans = orphanList;
  } finally {
    src.close();
  }

  // Copy on-disk session + group files for the restored agent.
  const ts = timestampSuffix();
  copyAgentGroupFiles(stagingDir, onlyAgentGroupId, ts);

  return { dryRun: false, plannedRows: planned, orphans };
}

function tableExistsIn(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(name) as
    | { '1': number }
    | undefined;
  return row !== undefined;
}

function replaceRow(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const placeholders = columns.map((c) => `@${c}`).join(', ');
  const colList = columns.join(', ');
  db.prepare(`INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${placeholders})`).run(row);
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function movePreRestore(targetPath: string, ts: string): void {
  if (!fs.existsSync(targetPath)) return;
  fs.renameSync(targetPath, `${targetPath}.pre-restore-${ts}`);
}

function copyAgentGroupFiles(stagingDir: string, agentGroupId: string, ts: string): void {
  const stagedAg = path.join(stagingDir, 'agent-groups', agentGroupId);
  if (!fs.existsSync(stagedAg)) return;

  // groups/<folder>/  — needs the folder name from the agent_groups row in
  // the staged DB (which we may not have re-opened here). Read the file
  // names we care about deterministically: group/CLAUDE.local.md and
  // group/container.json.
  const stagedGroup = path.join(stagedAg, 'group');
  if (fs.existsSync(stagedGroup)) {
    // Resolve the folder name via the staged central DB if present.
    const stagedCentral = path.join(stagingDir, 'central', 'v2.db');
    let folder: string | null = null;
    if (fs.existsSync(stagedCentral)) {
      const src = new Database(stagedCentral, { readonly: true });
      try {
        const row = src.prepare('SELECT folder FROM agent_groups WHERE id = ?').get(agentGroupId) as
          | { folder: string }
          | undefined;
        folder = row?.folder ?? null;
      } finally {
        src.close();
      }
    }
    if (folder) {
      const liveGroupDir = path.join(GROUPS_DIR, folder);
      fs.mkdirSync(liveGroupDir, { recursive: true });
      for (const name of ['CLAUDE.local.md', 'container.json']) {
        const stagedFile = path.join(stagedGroup, name);
        if (fs.existsSync(stagedFile)) {
          const dst = path.join(liveGroupDir, name);
          movePreRestore(dst, ts);
          fs.copyFileSync(stagedFile, dst);
        }
      }
    }
  }

  // .claude-shared lives under data/v2-sessions/<agId>/.claude-shared
  const stagedShared = path.join(stagedAg, 'claude-shared');
  if (fs.existsSync(stagedShared)) {
    const liveShared = path.join(sessionsBaseDir(), agentGroupId, '.claude-shared');
    if (fs.existsSync(liveShared)) {
      fs.renameSync(liveShared, `${liveShared}.pre-restore-${ts}`);
    }
    fs.mkdirSync(liveShared, { recursive: true });
    copyDirRecursive(stagedShared, liveShared);
  }

  // sessions/<sessionId>/<contents>
  const stagedSessions = path.join(stagedAg, 'sessions');
  if (fs.existsSync(stagedSessions)) {
    for (const sessionId of fs.readdirSync(stagedSessions)) {
      const stagedSess = path.join(stagedSessions, sessionId);
      const liveSess = sessionDir(agentGroupId, sessionId);
      if (fs.existsSync(liveSess)) {
        fs.renameSync(liveSess, `${liveSess}.pre-restore-${ts}`);
      }
      fs.mkdirSync(liveSess, { recursive: true });
      copyDirRecursive(stagedSess, liveSess);
    }
  }
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
