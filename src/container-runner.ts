/**
 * Container Runner for NanoClaw
 * Thin re-export layer for backward compatibility.
 * Actual implementation is in backends/local-backend.ts.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { resolveBackend } from './backends/index.js';
import { ContainerProcess, RegisteredGroup, Agent } from './types.js';
import type { AgentOrGroup } from './backends/types.js';

// Re-export types from backends
export type { ContainerInput, ContainerOutput } from './backends/types.js';

/**
 * Run an agent via the appropriate backend.
 * @deprecated Use resolveBackend(group).runAgent() directly.
 */
export async function runContainerAgent(
  group: AgentOrGroup,
  input: import('./backends/types.js').ContainerInput,
  onProcess: (proc: ContainerProcess, containerName: string) => void,
  onOutput?: (output: import('./backends/types.js').ContainerOutput) => Promise<void>,
): Promise<import('./backends/types.js').ContainerOutput> {
  const backend = resolveBackend(group);
  return backend.runAgent(group, input, onProcess, onOutput);
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
