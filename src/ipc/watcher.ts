import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';

import { processMessageFiles } from './message-handler.js';
import { processTaskIpc } from './task-handler.js';
import type { IpcDeps, IpcTaskPayload } from './types.js';

let ipcWatcherRunning = false;

/** @internal - for tests only. Resets the singleton guard. */
export function _resetIpcWatcherForTests(): void {
  ipcWatcherRunning = false;
}

/**
 * Start the per-group IPC watcher. Polls every `IPC_POLL_INTERVAL` ms
 * and dispatches each file to either processMessageFiles or
 * processTaskIpc, then removes or quarantines it.
 *
 * Idempotent: a second call while the first is running is a no-op.
 */
export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const errorsDir = path.join(ipcBaseDir, 'errors');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      try {
        await processMessageFiles(
          messagesDir,
          sourceGroup,
          isMain,
          deps,
          errorsDir,
        );
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data: IpcTaskPayload = JSON.parse(
                fs.readFileSync(filePath, 'utf-8'),
              );
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              fs.mkdirSync(errorsDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorsDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}
