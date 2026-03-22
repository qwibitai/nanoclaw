import fs from 'fs';
import path from 'path';

import type pino from 'pino';

import { DATA_DIR, IPC_FALLBACK_POLL_INTERVAL } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { handleFeedbackIpc } from './ipc/feedback-handler.js';
import { handleMessageIpc } from './ipc/message-handler.js';
import { handleTaskIpc } from './ipc/task-handler.js';
import { createCorrelationLogger, logger } from './logger.js';
import { RegisteredGroup } from './types.js';

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
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  let processing = false;

  const processIpcFiles = async () => {
    // Prevent concurrent processing from overlapping watch + poll triggers
    if (processing) return;
    processing = true;

    try {
      // Scan all group IPC directories (identity determined by directory)
      let groupFolders: string[];
      try {
        groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
          const stat = fs.statSync(path.join(ipcBaseDir, f));
          return stat.isDirectory() && f !== 'errors';
        });
      } catch (err) {
        logger.error({ err }, 'Error reading IPC base directory');
        return;
      }

      const registeredGroups = deps.registeredGroups();

      // Build folder→isMain lookup from registered groups
      const folderIsMain = new Map<string, boolean>();
      for (const group of Object.values(registeredGroups)) {
        if (group.isMain) folderIsMain.set(group.folder, true);
      }

      for (const sourceGroup of groupFolders) {
        const isMain = folderIsMain.get(sourceGroup) === true;
        const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
        const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

        // Process messages from this group's IPC directory
        try {
          if (fs.existsSync(messagesDir)) {
            const messageFiles = fs
              .readdirSync(messagesDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of messageFiles) {
              const filePath = path.join(messagesDir, file);
              const log = createCorrelationLogger(undefined, {
                op: 'ipc-message',
                sourceGroup,
                file,
              });
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                await handleMessageIpc(
                  data,
                  sourceGroup,
                  isMain,
                  deps,
                  registeredGroups,
                  log,
                );
                fs.unlinkSync(filePath);
              } catch (err) {
                log.error({ err }, 'Error processing IPC message');
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC messages directory',
          );
        }

        // Process tasks from this group's IPC directory
        try {
          if (fs.existsSync(tasksDir)) {
            const taskFiles = fs
              .readdirSync(tasksDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of taskFiles) {
              const filePath = path.join(tasksDir, file);
              const log = createCorrelationLogger(undefined, {
                op: 'ipc-task',
                sourceGroup,
                file,
              });
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                // Pass source group identity to processTaskIpc for authorization
                await processTaskIpc(data, sourceGroup, isMain, deps, log);
                fs.unlinkSync(filePath);
              } catch (err) {
                log.error({ err }, 'Error processing IPC task');
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC tasks directory',
          );
        }
      }
    } finally {
      processing = false;
    }
  };

  // Debounced trigger: coalesces rapid fs.watch events into a single processing run
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerProcessing = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      processIpcFiles();
    }, 50);
  };

  // Primary: fs.watch for sub-second responsiveness
  try {
    const watcher = fs.watch(
      ipcBaseDir,
      { recursive: true },
      (_eventType, _filename) => {
        triggerProcessing();
      },
    );
    watcher.on('error', (err) => {
      logger.warn(
        { err },
        'fs.watch error on IPC directory — fallback polling will continue',
      );
    });
    logger.info('IPC watcher started with fs.watch (per-group namespaces)');
  } catch (err) {
    logger.warn(
      { err },
      'fs.watch failed to initialize — using polling only for IPC',
    );
  }

  // Fallback: periodic polling to catch any events fs.watch may miss
  setInterval(processIpcFiles, IPC_FALLBACK_POLL_INTERVAL);

  // Initial scan for any files already present
  processIpcFiles();
}

/**
 * Dispatch a single IPC task/feedback command to the appropriate handler.
 * Kept as public API for backwards compatibility with tests.
 */
export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For feedback
    feedbackType?: string;
    title?: string;
    description?: string;
    email?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  log?: pino.Logger,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  if (data.type === 'feedback') {
    await handleFeedbackIpc(data, sourceGroup, log);
  } else {
    await handleTaskIpc(data, sourceGroup, isMain, deps, registeredGroups, log);
  }
}
