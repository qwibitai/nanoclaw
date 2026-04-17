import type { AvailableGroup } from '../container-runner.js';
import type { RegisteredGroup } from '../types.js';

/**
 * Dependencies for the IPC watcher. Every side effect (sending a
 * message, registering a group, syncing metadata, persisting task
 * state) goes through this interface so the watcher stays testable.
 */
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

/**
 * Shape of every incoming IPC task payload. Individual handlers pick
 * out the fields they care about; unknown fields are allowed (forward
 * compatibility).
 */
export interface IpcTaskPayload {
  type: string;
  taskId?: string;
  prompt?: string;
  schedule_type?: string;
  schedule_value?: string;
  context_mode?: string;
  script?: string;
  model?: string;
  effort?: string;
  thinking_budget?: string;
  taskName?: string;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  // For register_group
  jid?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  containerConfig?: RegisteredGroup['containerConfig'];
}
