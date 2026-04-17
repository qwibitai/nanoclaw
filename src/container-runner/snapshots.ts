import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from '../group-folder.js';

import type { AvailableGroup } from './types.js';

export interface SnapshotTask {
  id: string;
  name?: string | null;
  groupFolder: string;
  prompt: string;
  script?: string | null;
  schedule_type: string;
  schedule_value: string;
  context_mode?: string;
  silent?: boolean | number;
  model?: string | null;
  status: string;
  next_run: string | null;
}

/**
 * Write the `current_tasks.json` snapshot into a group's folder.
 * Main groups see every task; others are filtered to their own.
 */
export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: SnapshotTask[],
): void {
  // Write to the group directory (not IPC) so the snapshot is available
  // regardless of which IPC channel spawns the agent (service vs CLI).
  const groupDir = resolveGroupFolderPath(groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

/**
 * Write the `available_groups.json` snapshot for a group.
 * Main groups can see every group (for activation); others see nothing.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      { groups: visibleGroups, lastSync: new Date().toISOString() },
      null,
      2,
    ),
  );
}
