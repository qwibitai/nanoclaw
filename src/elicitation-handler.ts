/**
 * Elicitation Handler for Sovereign
 * Watches IPC for elicitation requests, sends structured questions to channels,
 * collects responses (reactions or text), writes answers back via IPC.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  formatQuestion,
  getReactionEmojis,
  resolveReaction,
  parseTextReply,
  buildResponse,
  ElicitationRequest,
} from './structured-elicitation.js';
import { Channel } from './types.js';

// Track active elicitations to prevent duplicates
const activeElicitations = new Set<string>();

export interface ElicitationDeps {
  findChannel: (jid: string) => Channel | undefined;
  addReactions: (jid: string, messageId: string, emojis: string[]) => Promise<void>;
  waitForResponse: (
    jid: string,
    messageId: string,
    options: string[],
    allowFreetext: boolean,
    timeoutMs: number,
  ) => Promise<{ chosen: string | null; freetext: string | null; timeout: boolean }>;
}

export function startElicitationHandler(deps: ElicitationDeps): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');

  const processElicitations = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        try {
          return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors';
        } catch {
          return false;
        }
      });
    } catch {
      setTimeout(processElicitations, 1000);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const requestsDir = path.join(ipcBaseDir, sourceGroup, 'elicitation-requests');
      if (!fs.existsSync(requestsDir)) continue;

      let requestFiles: string[];
      try {
        requestFiles = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of requestFiles) {
        const filePath = path.join(requestsDir, file);
        let request: ElicitationRequest;

        try {
          request = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (err) {
          logger.error({ file, err }, 'Failed to parse elicitation request');
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }

        if (activeElicitations.has(request.id)) continue;

        // Remove request file immediately
        try { fs.unlinkSync(filePath); } catch {}
        activeElicitations.add(request.id);

        // Process in background
        handleElicitation(request, sourceGroup, ipcBaseDir, deps).finally(() => {
          activeElicitations.delete(request.id);
        });
      }
    }

    setTimeout(processElicitations, 500);
  };

  processElicitations();
  logger.info('Elicitation handler started');
}

async function handleElicitation(
  request: ElicitationRequest,
  sourceGroup: string,
  ipcBaseDir: string,
  deps: ElicitationDeps,
): Promise<void> {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'elicitation-responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${request.id}.json`);

  const channel = deps.findChannel(request.sourceChatJid);
  if (!channel) {
    writeResponse(responsePath, buildResponse(request.id, null, null, true));
    return;
  }

  // Format and send the question
  const questionText = formatQuestion(request.question, request.options, request.allowFreetext);

  try {
    await channel.sendMessage(request.sourceChatJid, questionText);
  } catch (err) {
    logger.error({ elicitationId: request.id, err }, 'Failed to send elicitation question');
    writeResponse(responsePath, buildResponse(request.id, null, null, true));
    return;
  }

  // For now, use a simple timeout-based approach
  // Future: integrate with Discord reactions via addReactions + waitForResponse
  const timeoutMs = request.timeoutSeconds * 1000;

  try {
    const result = await deps.waitForResponse(
      request.sourceChatJid,
      request.id,
      request.options,
      request.allowFreetext,
      timeoutMs,
    );

    writeResponse(responsePath, buildResponse(
      request.id,
      result.chosen,
      result.freetext,
      result.timeout,
    ));

    logger.info(
      { elicitationId: request.id, chosen: result.chosen, timeout: result.timeout },
      'Elicitation completed',
    );
  } catch (err) {
    logger.error({ elicitationId: request.id, err }, 'Elicitation failed');
    writeResponse(responsePath, buildResponse(request.id, null, null, true));
  }
}

function writeResponse(responsePath: string, data: unknown): void {
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, responsePath);
}
