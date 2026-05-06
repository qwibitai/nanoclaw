/**
 * Walk the central DB + filesystem to produce the list of things to back up.
 *
 * Structure mirrors the on-disk layout: each agent group has zero or more
 * sessions, each session has its own directory under
 * `data/v2-sessions/<agent_group_id>/<session_id>/`. The `.claude-shared/`
 * tree is one-per-agent-group, parked under `data/v2-sessions/<agent_group_id>/`.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { sessionDir, sessionsBaseDir } from '../session-manager.js';
import type { AgentGroup, Session } from '../types.js';

export interface BackupSession {
  session: Session;
  dir: string;
}

export interface BackupAgentGroup {
  group: AgentGroup;
  groupFolderDir: string;
  claudeSharedDir: string;
  sessions: BackupSession[];
}

export interface BackupTargets {
  agent_groups: BackupAgentGroup[];
}

export function enumerateBackupTargets(): BackupTargets {
  const agent_groups = getAllAgentGroups().map<BackupAgentGroup>((group) => {
    const sessions = getSessionsByAgentGroup(group.id).map<BackupSession>((session) => ({
      session,
      dir: sessionDir(group.id, session.id),
    }));
    return {
      group,
      groupFolderDir: path.join(GROUPS_DIR, group.folder),
      claudeSharedDir: path.join(sessionsBaseDir(), group.id, '.claude-shared'),
      sessions,
    };
  });

  return { agent_groups };
}

/**
 * Walk a directory tree, returning relative paths (POSIX separators) for every
 * regular file under it. Symlinks are returned as their own entries so the
 * caller can decide to skip them — `.claude-shared/skills/` is full of
 * symlinks that get regenerated on group init, so backup skips them.
 */
export function walkFiles(rootDir: string, opts?: { skipRelativePrefixes?: string[] }): WalkedFile[] {
  if (!fs.existsSync(rootDir)) return [];
  const skipPrefixes = opts?.skipRelativePrefixes ?? [];
  const out: WalkedFile[] = [];

  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = rel === '' ? rootDir : path.join(rootDir, rel);
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : path.posix.join(rel, entry.name);
      if (skipPrefixes.some((p) => childRel === p || childRel.startsWith(p + '/'))) continue;
      if (entry.isSymbolicLink()) {
        // Skill symlinks under .claude-shared/skills/ are regenerated on
        // group init; pointing at host-local source paths means restoring
        // them on a different machine would be wrong anyway. Drop.
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (entry.isFile()) {
        const absChild = path.join(rootDir, childRel);
        const stat = fs.statSync(absChild);
        out.push({ relativePath: childRel, absolutePath: absChild, size: stat.size });
      }
    }
  }

  out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return out;
}

export interface WalkedFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}
