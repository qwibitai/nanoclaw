import {
  ASSISTANT_NAME,
  CONTROL_PLANE_CONTEXT_MODE,
  CONTROL_PLANE_GROUP_FOLDER,
} from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllTasks,
  getSession,
  setSession,
  deleteSession,
} from './db.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ControlPlaneGroupSelection {
  jid: string;
  group: RegisteredGroup;
}

export interface ExecuteControlPlaneTaskOptions {
  taskId: string;
  prompt: string;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export interface ExecuteControlPlaneTaskResult {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

export function resolveControlPlaneGroup(
  requestedFolder: string | undefined = CONTROL_PLANE_GROUP_FOLDER,
): ControlPlaneGroupSelection {
  const groups = getAllRegisteredGroups();
  const entries = Object.entries(groups);

  if (entries.length === 0) {
    throw new Error(
      'No NanoClaw groups are registered. Register a local group before starting the control-plane worker.',
    );
  }

  if (requestedFolder) {
    const match = entries.find(([, group]) => group.folder === requestedFolder);
    if (!match) {
      throw new Error(
        `CONTROL_PLANE_GROUP_FOLDER "${requestedFolder}" was not found in registered groups.`,
      );
    }
    return { jid: match[0], group: match[1] };
  }

  const mainGroup = entries.find(([, group]) => group.isMain === true);
  if (mainGroup) {
    return { jid: mainGroup[0], group: mainGroup[1] };
  }

  if (entries.length === 1) {
    return { jid: entries[0][0], group: entries[0][1] };
  }

  throw new Error(
    'Multiple NanoClaw groups are registered. Set CONTROL_PLANE_GROUP_FOLDER to choose which local group should execute control-plane tasks.',
  );
}

export async function executeControlPlaneTask(
  selection: ControlPlaneGroupSelection,
  options: ExecuteControlPlaneTaskOptions,
): Promise<ExecuteControlPlaneTaskResult> {
  const { jid, group } = selection;
  const isMain = group.isMain === true;
  const useGroupContext = CONTROL_PLANE_CONTEXT_MODE === 'group';
  const sessionId = useGroupContext ? getSession(group.folder) : undefined;

  writeCurrentSnapshots(group.folder, isMain, Object.keys(getAllRegisteredGroups()));

  const output = await runContainerAgent(
    group,
    {
      prompt: options.prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: `control-plane:${options.taskId}`,
      isMain,
      assistantName: ASSISTANT_NAME,
    },
    () => {},
    options.onOutput
      ? async (streamedOutput) => {
          if (useGroupContext && streamedOutput.newSessionId) {
            setSession(group.folder, streamedOutput.newSessionId);
          }
          await options.onOutput?.(streamedOutput);
        }
      : undefined,
  );

  if (useGroupContext && output.newSessionId) {
    setSession(group.folder, output.newSessionId);
  }

  if (
    output.status === 'error' &&
    sessionId &&
    output.error &&
    /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
      output.error,
    )
  ) {
    logger.warn(
      { group: group.name, staleSessionId: sessionId, error: output.error },
      'Stale session detected during control-plane task — clearing session',
    );
    deleteSession(group.folder);
  }

  if (output.status === 'error') {
    return {
      status: 'error',
      result: null,
      error: output.error || 'Unknown task execution error',
    };
  }

  return {
    status: 'success',
    result: output.result,
  };
}

function writeCurrentSnapshots(
  groupFolder: string,
  isMain: boolean,
  registeredJids: string[],
): void {
  const tasks = getAllTasks();
  writeTasksSnapshot(
    groupFolder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      script: task.script || undefined,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );

  const chats = getAllChats();
  writeGroupsSnapshot(
    groupFolder,
    isMain,
    chats
      .filter((chat) => chat.jid !== '__group_sync__' && chat.is_group)
      .map((chat) => ({
        jid: chat.jid,
        name: chat.name,
        lastActivity: chat.last_message_time,
        isRegistered: registeredJids.includes(chat.jid),
      })),
    new Set(registeredJids),
  );
}
