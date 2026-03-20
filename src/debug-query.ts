/**
 * Debug Query — sends a question to a container agent and waits for a response.
 * Used by the /ask-agent Claude Code skill.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  DEBUG_QUERY_TIMEOUT_ACTIVE,
  DEBUG_QUERY_TIMEOUT_FRESH,
} from './config.js';
import { ContainerInput, runContainerAgent } from './container-runner.js';
import { getAllRegisteredGroups } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface DebugQueryResult {
  status: 'success' | 'error' | 'timeout';
  answer?: string;
  error?: string;
}

/**
 * Find the groupJid for a given groupFolder from registered groups.
 */
function findGroupJid(
  groupFolder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === groupFolder) return jid;
  }
  return null;
}

/**
 * List registered groups with their active status.
 */
export function listGroupsForDebug(
  groupQueue: GroupQueue,
): Array<{ name: string; folder: string; jid: string; isActive: boolean }> {
  const groups = getAllRegisteredGroups();
  const result: Array<{
    name: string;
    folder: string;
    jid: string;
    isActive: boolean;
  }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    result.push({
      name: group.name,
      folder: group.folder,
      jid,
      isActive: groupQueue.isActive(jid),
    });
  }
  return result;
}

/**
 * Resolve the IPC debug directory path for a group (and optionally a thread).
 * Sets uid 1000 ownership so the container's node user can write responses.
 */
function getDebugDir(groupFolder: string, threadId?: string): string {
  const base = threadId
    ? path.join(DATA_DIR, 'ipc', groupFolder, threadId, 'debug')
    : path.join(DATA_DIR, 'ipc', groupFolder, 'debug');
  fs.mkdirSync(base, { recursive: true });
  try {
    fs.chownSync(base, 1000, 1000);
  } catch {
    // Best-effort — may fail if not running as root
  }
  return base;
}

/**
 * Write a debug query file and wait for the response.
 */
function pollForResponse(
  debugDir: string,
  queryId: string,
  timeoutMs: number,
  abortSignal?: { aborted: boolean },
): Promise<DebugQueryResult> {
  return new Promise((resolve) => {
    const responseFile = path.join(debugDir, 'response.json');
    const startTime = Date.now();

    const poll = () => {
      if (abortSignal?.aborted) {
        cleanup(debugDir, queryId);
        resolve({
          status: 'error',
          error: 'Container exited before responding',
        });
        return;
      }

      if (Date.now() - startTime > timeoutMs) {
        cleanup(debugDir, queryId);
        resolve({
          status: 'timeout',
          error: `Agent did not respond within ${timeoutMs / 1000}s`,
        });
        return;
      }

      try {
        if (fs.existsSync(responseFile)) {
          const data = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          if (data.id === queryId) {
            cleanup(debugDir, queryId);
            // Signal the container to exit after a short delay.
            // The agent-runner needs time to finish the query loop and
            // enter the idle wait before it will see the _close sentinel.
            setTimeout(() => closeContainer(debugDir), 3000);
            const status = VALID_RESPONSE_STATUSES.has(data.status)
              ? data.status
              : 'success';
            resolve({
              status,
              answer: data.answer,
            });
            return;
          }
        }
      } catch {
        // File may be partially written, retry
      }

      setTimeout(poll, 500);
    };

    poll();
  });
}

/**
 * Signal the container to exit by writing a _close sentinel.
 * The debug dir is at .../debug/, the input dir is its sibling at .../input/.
 */
function closeContainer(debugDir: string): void {
  const inputDir = path.join(path.dirname(debugDir), 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, '_close'), '');
  } catch {
    // Best-effort
  }
}

/**
 * Clean up debug query and response files.
 */
function cleanup(debugDir: string, queryId: string): void {
  for (const file of ['query.json', 'response.json']) {
    const filePath = path.join(debugDir, file);
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.id === queryId) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
  }
}

const VALID_RESPONSE_STATUSES = new Set(['success', 'error', 'timeout']);

/**
 * Check if a query.json file is stale (older than the max timeout + buffer).
 */
function isStaleQuery(queryFile: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(queryFile, 'utf-8'));
    const age = Date.now() - (data.timestamp || 0);
    return age > DEBUG_QUERY_TIMEOUT_FRESH + 30_000;
  } catch {
    return true; // Unparseable = stale
  }
}

/**
 * Send a debug query to a container agent.
 *
 * If the agent is active, delivers via IPC input with a debug prefix.
 * If no agent is active, spawns a fresh container in debug mode.
 */
export async function sendDebugQuery(
  groupFolder: string,
  question: string,
  groupQueue: GroupQueue,
  registeredGroups: Record<string, RegisteredGroup>,
  externalQueryId?: string,
): Promise<DebugQueryResult> {
  const queryId = externalQueryId || crypto.randomUUID();
  const groupJid = findGroupJid(groupFolder, registeredGroups);
  if (!groupJid) {
    return {
      status: 'error',
      error: `No registered group found for folder: ${groupFolder}`,
    };
  }

  const group = registeredGroups[groupJid];
  const activeInfo = groupQueue.getActiveThreadInfo(groupJid);

  if (activeInfo) {
    // Active container — deliver via IPC input + poll debug response
    const debugDir = getDebugDir(groupFolder, activeInfo.threadId);

    // Check for existing query (allow override if stale)
    const queryFile = path.join(debugDir, 'query.json');
    if (fs.existsSync(queryFile)) {
      if (!isStaleQuery(queryFile)) {
        return {
          status: 'error',
          error: 'A debug query is already in progress for this group',
        };
      }
      logger.info({ groupFolder }, 'Removing stale debug query file');
      try {
        fs.unlinkSync(queryFile);
      } catch {
        /* ignore */
      }
    }

    // Write query file (for the agent to find context about what's being asked)
    const query = { id: queryId, question, timestamp: Date.now() };
    fs.writeFileSync(queryFile, JSON.stringify(query));

    // Deliver the debug question via IPC input (existing mechanism)
    const debugPrompt =
      `[NANOCLAW_DEBUG_QUERY:${queryId}]\n` +
      `[DEBUG QUERY FROM SUPERVISOR]\n` +
      `A supervising agent is asking you the following question for debugging purposes.\n` +
      `Respond concisely and factually about your current state, what you're working on, any errors, etc.\n\n` +
      `Question: ${question}\n\n` +
      `IMPORTANT: Send your response using the mcp__nanoclaw__debug_response tool with id="${queryId}" and your answer. Do NOT use Write or Bash to create the response file.`;

    const sent = groupQueue.sendMessage(
      groupJid,
      activeInfo.threadId,
      debugPrompt,
    );
    if (!sent) {
      cleanup(debugDir, queryId);
      return {
        status: 'error',
        error: 'Failed to deliver debug query to active container',
      };
    }

    logger.info(
      { groupFolder, queryId, threadId: activeInfo.threadId },
      'Debug query sent to active container',
    );
    return pollForResponse(debugDir, queryId, DEBUG_QUERY_TIMEOUT_ACTIVE);
  }

  // No active container — spawn a fresh one in debug mode
  const debugDir = getDebugDir(groupFolder);

  // Check for existing query (allow override if stale)
  const queryFile = path.join(debugDir, 'query.json');
  if (fs.existsSync(queryFile)) {
    if (!isStaleQuery(queryFile)) {
      return {
        status: 'error',
        error: 'A debug query is already in progress for this group',
      };
    }
    logger.info({ groupFolder }, 'Removing stale debug query file');
    try {
      fs.unlinkSync(queryFile);
    } catch {
      /* ignore */
    }
  }

  // Write query file
  const queryData = { id: queryId, question, timestamp: Date.now() };
  fs.writeFileSync(queryFile, JSON.stringify(queryData));

  const debugPrompt =
    `[DEBUG QUERY FROM SUPERVISOR]\n` +
    `A supervising agent is asking you the following question for debugging purposes.\n` +
    `Respond concisely and factually about your current state, the group's workspace, any recent activity, errors, etc.\n` +
    `Review the group's CLAUDE.md, recent conversation archives, and workspace files to provide a thorough answer.\n\n` +
    `Question: ${question}\n\n` +
    `Write your response to /workspace/ipc/debug/response.json as JSON: ` +
    `{"id": "${queryId}", "answer": "your answer here", "status": "success", "timestamp": ${Date.now()}}`;

  const containerInput: ContainerInput = {
    prompt: debugPrompt,
    groupFolder,
    chatJid: groupJid,
    isMain: group.isMain === true,
    debugQuery: { id: queryId, question },
  };

  const abortSignal = { aborted: false };

  // Start polling for response before spawning container
  const responsePromise = pollForResponse(
    debugDir,
    queryId,
    DEBUG_QUERY_TIMEOUT_FRESH,
    abortSignal,
  );

  // Spawn container (fire and forget — response comes via IPC file)
  runContainerAgent(group, containerInput, (proc, containerName) => {
    logger.info(
      { containerName, groupFolder, queryId },
      'Debug container spawned',
    );
    proc.on('close', () => {
      abortSignal.aborted = true;
    });
  }).catch((err) => {
    logger.error({ err, groupFolder, queryId }, 'Debug container failed');
    abortSignal.aborted = true;
  });

  logger.info({ groupFolder, queryId }, 'Debug query sent via fresh container');
  return responsePromise;
}
