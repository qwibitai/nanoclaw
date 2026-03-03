/**
 * Unix Socket IPC Server for NanoClaw
 *
 * Replaces file-based IPC polling with NDJSON over Unix sockets.
 * Each group gets its own socket at data/ipc/{group}/nc.sock.
 * Container processes (MCP server + agent-runner) connect as clients.
 * Host broadcasts inbound messages to all connected clients.
 */
import net from 'net';
import fs from 'fs';
import os from 'os';

import { IpcDeps, processTaskIpc } from './ipc.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

// macOS sun_path limit is 104 bytes, Linux is 108
const MAX_SOCKET_PATH = os.platform() === 'darwin' ? 104 : 108;

/**
 * NDJSON parser: buffers partial data from a socket and emits
 * complete JSON objects delimited by newlines.
 */
export class NdjsonParser {
  private buffer = '';

  /**
   * Feed raw data into the parser.
   * Returns an array of parsed JSON objects (may be empty if no complete lines yet).
   */
  feed(data: string): object[] {
    this.buffer += data;
    const results: object[] = [];

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        results.push(JSON.parse(line));
      } catch {
        logger.warn({ line: line.slice(0, 200) }, 'Invalid JSON in IPC socket data, skipping');
      }
    }

    return results;
  }
}

interface GroupSocketState {
  server: net.Server;
  socketPath: string;
  connections: Set<net.Socket>;
}

export interface IpcSocketServer {
  createGroupSocket(groupFolder: string): string;
  destroyGroupSocket(groupFolder: string): void;
  sendToGroup(groupFolder: string, message: object): void;
  shutdown(): void;
}

export function createIpcSocketServer(deps: IpcDeps): IpcSocketServer {
  const groups = new Map<string, GroupSocketState>();

  function getIsMain(sourceGroup: string): boolean {
    const registeredGroups = deps.registeredGroups();
    for (const group of Object.values(registeredGroups)) {
      if (group.folder === sourceGroup && group.isMain) return true;
    }
    return false;
  }

  async function handleIncomingMessage(
    data: Record<string, unknown>,
    sourceGroup: string,
  ): Promise<void> {
    const type = data.type as string;
    const isMain = getIsMain(sourceGroup);

    if (type === 'message') {
      // Replicate the authorization check from the old file-based watcher
      const chatJid = data.chatJid as string;
      const text = data.text as string;
      if (!chatJid || !text) return;

      const registeredGroups = deps.registeredGroups();
      const targetGroup = registeredGroups[chatJid];

      if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
        await deps.sendMessage(chatJid, text);
        logger.info({ chatJid, sourceGroup }, 'IPC message sent');
      } else {
        logger.warn(
          { chatJid, sourceGroup },
          'Unauthorized IPC message attempt blocked',
        );
      }
    } else {
      // Task types: schedule_task, pause_task, resume_task, cancel_task, refresh_groups, register_group
      await processTaskIpc(data as Parameters<typeof processTaskIpc>[0], sourceGroup, isMain, deps);
    }
  }

  function createGroupSocket(groupFolder: string): string {
    const groupIpcDir = resolveGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });

    const socketPath = groupIpcDir + '/nc.sock';

    // Validate socket path length
    if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH) {
      throw new Error(
        `Socket path too long (${Buffer.byteLength(socketPath)} bytes, max ${MAX_SOCKET_PATH}). ` +
        `Shorten your project path or group folder name. Path: ${socketPath}`,
      );
    }

    // Remove stale socket file from previous run
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // fine if it doesn't exist
    }

    const connections = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      connections.add(socket);
      logger.debug({ groupFolder }, 'IPC socket client connected');

      const parser = new NdjsonParser();

      socket.on('data', (raw) => {
        const messages = parser.feed(raw.toString());
        for (const msg of messages) {
          handleIncomingMessage(msg as Record<string, unknown>, groupFolder).catch(
            (err) => logger.error({ err, groupFolder }, 'Error handling IPC socket message'),
          );
        }
      });

      socket.on('close', () => {
        connections.delete(socket);
        logger.debug({ groupFolder }, 'IPC socket client disconnected');
      });

      socket.on('error', (err) => {
        connections.delete(socket);
        logger.debug({ groupFolder, err: err.message }, 'IPC socket client error');
      });
    });

    server.on('error', (err) => {
      logger.error({ groupFolder, err }, 'IPC socket server error');
    });

    server.listen(socketPath, () => {
      logger.debug({ groupFolder, socketPath }, 'IPC socket server listening');
    });

    groups.set(groupFolder, { server, socketPath, connections });
    return socketPath;
  }

  function destroyGroupSocket(groupFolder: string): void {
    const state = groups.get(groupFolder);
    if (!state) return;

    for (const conn of state.connections) {
      conn.destroy();
    }
    state.connections.clear();

    state.server.close();

    try {
      fs.unlinkSync(state.socketPath);
    } catch {
      // ignore
    }

    groups.delete(groupFolder);
    logger.debug({ groupFolder }, 'IPC socket server destroyed');
  }

  function sendToGroup(groupFolder: string, message: object): void {
    const state = groups.get(groupFolder);
    if (!state) {
      logger.warn({ groupFolder }, 'No socket server for group, cannot send');
      return;
    }

    const payload = JSON.stringify(message) + '\n';
    for (const conn of state.connections) {
      if (!conn.destroyed) {
        conn.write(payload);
      }
    }
  }

  function shutdown(): void {
    for (const [groupFolder] of groups) {
      destroyGroupSocket(groupFolder);
    }
    logger.info('IPC socket servers shut down');
  }

  return { createGroupSocket, destroyGroupSocket, sendToGroup, shutdown };
}
