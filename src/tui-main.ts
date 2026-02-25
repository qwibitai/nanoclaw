/**
 * NanoClaw Terminal UI - Interactive chat via terminal using Ink
 *
 * Usage: npm run tui
 *
 * This provides a local terminal channel to interact with the NanoClaw agent
 * without requiring WhatsApp or Feishu. Messages are processed through the
 * same container agent pipeline.
 */
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  STORE_DIR,
} from './config.js';
import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  getAllChats,
  getAllTasks,
  getSession,
  initDatabase,
  setSession,
} from './db.js';
import { logger } from './logger.js';
import { startTui, TuiCallbacks } from './tui.js';
import { RegisteredGroup } from './types.js';

// ─── State ───────────────────────────────────────────────────────────────────

const TUI_CHAT_JID = 'tui:local';

const tuiGroup: RegisteredGroup = {
  name: 'terminal',
  folder: MAIN_GROUP_FOLDER,
  trigger: '.*',
  added_at: new Date().toISOString(),
};

// ─── Setup ───────────────────────────────────────────────────────────────────

function ensureDirectoriesExist(): void {
  const directories = [STORE_DIR, DATA_DIR, GROUPS_DIR];
  for (const dir of directories) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const mainGroupDir = path.join(GROUPS_DIR, MAIN_GROUP_FOLDER);
  const globalGroupDir = path.join(GROUPS_DIR, 'global');
  for (const dir of [mainGroupDir, globalGroupDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// ─── Agent Runner ────────────────────────────────────────────────────────────

async function runAgent(prompt: string): Promise<string | null> {
  const groupFolder = tuiGroup.folder;
  const sessionId = getSession(groupFolder);

  // Write snapshots for container
  const tasks = getAllTasks();
  writeTasksSnapshot(
    groupFolder,
    true,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const chats = getAllChats();
  const availableGroups = chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: false,
    }));
  writeGroupsSnapshot(groupFolder, true, availableGroups, new Set());

  try {
    let resultReceived = false;
    let resolveResult!: (value: string | null) => void;
    const resultPromise = new Promise<string | null>((resolve) => {
      resolveResult = resolve;
    });

    runContainerAgent(
      tuiGroup,
      {
        prompt: `<messages>\n<message sender="User" time="${new Date().toISOString()}">${escapeXml(prompt)}</message>\n</messages>`,
        sessionId,
        groupFolder,
        chatJid: TUI_CHAT_JID,
        isMain: true,
        assistantName: ASSISTANT_NAME,
      },
      // onProcess callback — no-op for TUI (no need to track child process)
      () => {},
      // onOutput callback — handle streaming results
      async (output) => {
        let outputData = output;
        if (typeof output === 'string') {
          outputData = JSON.parse(output);
        }
        if (outputData.newSessionId) {
          setSession(groupFolder, outputData.newSessionId);
        }

        if (outputData.status === 'error') {
          logger.error({ error: outputData.error }, 'Container agent error');
          if (!resultReceived) {
            resultReceived = true;
            resolveResult(`[Error] ${outputData.error}`);
            setCloseSignal(groupFolder);
          }
          return;
        }

        // Process the result and strip internal tags
        if (outputData.result && !resultReceived) {
          const raw = typeof outputData.result === 'string' ? outputData.result : JSON.stringify(outputData.result);
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          const finalResult = text || outputData.result;
          resultReceived = true;
          resolveResult(finalResult);
          setCloseSignal(groupFolder);
        }
      }
    );

    return await resultPromise;
  } catch (err) {
    logger.error({ err }, 'Agent error');
    return `[Error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setCloseSignal(groupFolder: string): void {
  const ipcDir = resolveGroupIpcPath(groupFolder);
  const inputDir = path.join(ipcDir, 'input');
  const closeSignalPath = path.join(inputDir, '_close');
  
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(closeSignalPath, '');
    logger.debug({ groupFolder, closeSignalPath }, 'Close signal set');
  } catch (err) {
    logger.error({ err, groupFolder, closeSignalPath }, 'Failed to set close signal');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDirectoriesExist();
  ensureContainerRuntimeRunning();
  initDatabase();

  logger.info(`Starting NanoClaw Terminal UI (assistant: ${ASSISTANT_NAME})`);

  const callbacks: TuiCallbacks = {
    onSendMessage: async (content: string) => {
      return runAgent(content);
    },
  };

  startTui(callbacks);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start TUI');
  process.exit(1);
});
