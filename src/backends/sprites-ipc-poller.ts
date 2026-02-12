/**
 * Sprites IPC Poller for NanoClaw
 * Polls IPC directories on remote Sprites for messages and tasks,
 * analogous to the local filesystem polling in ipc.ts.
 */

import { IPC_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { SpritesBackend } from './sprites-backend.js';

const API_BASE = 'https://api.sprites.dev/v1';

interface SpritesIpcPollerDeps {
  spritesBackend: SpritesBackend;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Process an IPC message file's contents */
  processMessage: (sourceGroup: string, data: any) => Promise<void>;
  /** Process an IPC task file's contents */
  processTask: (sourceGroup: string, isMain: boolean, data: any) => Promise<void>;
}

let pollerRunning = false;

/**
 * Start polling Sprites-backed groups for IPC output.
 * Reads /workspace/ipc/messages/ and /workspace/ipc/tasks/ via filesystem API.
 */
export function startSpritesIpcPoller(deps: SpritesIpcPollerDeps): void {
  if (pollerRunning) return;
  pollerRunning = true;

  const token = process.env.SPRITES_TOKEN;
  if (!token) {
    logger.debug('SPRITES_TOKEN not set, skipping Sprites IPC poller');
    return;
  }

  const poll = async () => {
    const groups = deps.registeredGroups();

    // Find groups using Sprites backend
    const spritesGroups = Object.entries(groups).filter(
      ([, g]) => g.backend === 'sprites',
    );

    if (spritesGroups.length === 0) {
      setTimeout(poll, IPC_POLL_INTERVAL);
      return;
    }

    for (const [jid, group] of spritesGroups) {
      const spriteName = `nanoclaw-${group.folder.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      const isMain = group.folder === 'main';

      try {
        // List and process message files
        await pollDirectory(
          token,
          spriteName,
          '/workspace/ipc/messages',
          async (filename, content) => {
            const data = JSON.parse(content);
            await deps.processMessage(group.folder, data);
          },
        );

        // List and process task files
        await pollDirectory(
          token,
          spriteName,
          '/workspace/ipc/tasks',
          async (filename, content) => {
            const data = JSON.parse(content);
            await deps.processTask(group.folder, isMain, data);
          },
        );
      } catch (err) {
        // Only warn on non-404 errors (sprite may be hibernating)
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('404')) {
          logger.warn(
            { group: group.folder, sprite: spriteName, error: msg },
            'Error polling Sprite IPC',
          );
        }
      }
    }

    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
  logger.info('Sprites IPC poller started');
}

/**
 * List JSON files in a remote directory, process each one, then delete it.
 */
async function pollDirectory(
  token: string,
  spriteName: string,
  dirPath: string,
  handler: (filename: string, content: string) => Promise<void>,
): Promise<void> {
  // List directory via filesystem API
  const listResp = await fetch(
    `${API_BASE}/sprites/${spriteName}/fs/list?path=${encodeURIComponent(dirPath)}`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );

  if (!listResp.ok) {
    if (listResp.status === 404) return; // Directory doesn't exist yet
    throw new Error(`List failed: ${listResp.status}`);
  }

  const body = await listResp.json() as { entries: Array<{ name: string; type: string }> | null };
  const entries = body.entries || [];
  const jsonFiles = entries.filter((e) => e.type === 'file' && e.name.endsWith('.json'));

  for (const entry of jsonFiles) {
    const filePath = `${dirPath}/${entry.name}`;

    try {
      // Read file
      const readResp = await fetch(
        `${API_BASE}/sprites/${spriteName}/fs/read?path=${encodeURIComponent(filePath)}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );

      if (!readResp.ok) continue;
      const content = await readResp.text();

      // Process it
      await handler(entry.name, content);

      // Delete after successful processing
      await fetch(`${API_BASE}/sprites/${spriteName}/fs/delete`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: filePath }),
      });
    } catch (err) {
      logger.warn(
        { sprite: spriteName, file: filePath, error: err },
        'Error processing Sprite IPC file',
      );
    }
  }
}
