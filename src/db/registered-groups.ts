import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';

import { getDb } from './connection.js';

interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  model: string | null;
  effort: string | null;
  thinking_budget: string | null;
}

function rowToGroup(row: RegisteredGroupRow): RegisteredGroup {
  return {
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    model: row.model || undefined,
    effort: row.effort || undefined,
    thinking_budget: row.thinking_budget || undefined,
  };
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = getDb()
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return { jid: row.jid, ...rowToGroup(row) };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, model, effort, thinking_budget)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
      group.isMain ? 1 : 0,
      group.model || null,
      group.effort || null,
      group.thinking_budget || null,
    );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = getDb()
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = rowToGroup(row);
  }
  return result;
}

export function setGroupModel(jid: string, model: string | null): void {
  getDb()
    .prepare('UPDATE registered_groups SET model = ? WHERE jid = ?')
    .run(model, jid);
}

export function setGroupEffort(jid: string, effort: string | null): void {
  getDb()
    .prepare('UPDATE registered_groups SET effort = ? WHERE jid = ?')
    .run(effort, jid);
}

export function setGroupThinkingBudget(
  jid: string,
  thinkingBudget: string | null,
): void {
  getDb()
    .prepare('UPDATE registered_groups SET thinking_budget = ? WHERE jid = ?')
    .run(thinkingBudget, jid);
}
