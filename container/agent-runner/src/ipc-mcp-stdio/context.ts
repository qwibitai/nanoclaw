import path from 'path';

import { writeIpcFile } from './ipc-writer.js';

/**
 * Everything the tool handlers need to know about the surrounding
 * agent-runner instance. Built once from environment variables in
 * `ipc-mcp-stdio.ts` and passed into each factory so the handlers
 * themselves stay pure and trivially unit-testable.
 */
export interface ToolContext {
  /** JID of the chat/group this MCP server is bound to. */
  chatJid: string;
  /** Folder name for this group (e.g. `telegram_family`). */
  groupFolder: string;
  /** Whether this is the main group (elevated privileges). */
  isMain: boolean;
  /** Mount point for per-group IPC directories. */
  ipcDir: string;
  /** Mount point for this group's shared group directory. */
  groupDir: string;
  /** Resolved messages directory (`ipcDir/messages`). */
  messagesDir: string;
  /** Resolved tasks directory (`ipcDir/tasks`). */
  tasksDir: string;
  /** File writer — injectable so tests can verify payloads without fs I/O. */
  writeIpcFile: (dir: string, data: object) => string;
}

/**
 * Build a ToolContext from the `NANOCLAW_*` environment variables that
 * the agent-runner sets when launching the MCP subprocess.
 */
export function createToolContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ToolContext {
  const ipcDir = env.NANOCLAW_IPC_DIR || '/workspace/ipc';
  const groupDir = env.NANOCLAW_GROUP_DIR || '/workspace';
  return {
    chatJid: env.NANOCLAW_CHAT_JID ?? '',
    groupFolder: env.NANOCLAW_GROUP_FOLDER ?? '',
    isMain: env.NANOCLAW_IS_MAIN === '1',
    ipcDir,
    groupDir,
    messagesDir: path.join(ipcDir, 'messages'),
    tasksDir: path.join(ipcDir, 'tasks'),
    writeIpcFile,
  };
}
