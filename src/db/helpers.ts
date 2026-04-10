import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import type { RegisteredGroupRow } from './types.js';

export function mapRowToRegisteredGroup(
  row: RegisteredGroupRow,
): (RegisteredGroup & { jid: string }) | undefined {
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
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
  };
}

export function serializeRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): unknown[] {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  return [
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain === true ? 1 : 0,
  ];
}
