/**
 * Delegation Handler for NanoClaw
 * Watches IPC for delegate-requests, spawns worker containers, writes responses.
 * Workers are lightweight: isolated session, no conversation history, group tools only.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { logger } from './logger.js';
import { selectModel, loadModelRoutingConfig } from './model-router.js';
import { RegisteredGroup } from './types.js';

interface DelegateRequest {
  id: string;
  prompt: string;
  model: string | null;
  timeout_seconds: number;
  source_group: string;
  source_chat_jid: string;
  timestamp: string;
}

// Track active delegations to prevent duplicate processing
const activeDelegations = new Set<string>();

// Max concurrent workers to prevent resource exhaustion
const MAX_CONCURRENT_WORKERS = 3;

export function startDelegationHandler(
  registeredGroups: () => Record<string, RegisteredGroup>,
): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');

  const processDelegations = async () => {
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
      setTimeout(processDelegations, 1000);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const requestsDir = path.join(ipcBaseDir, sourceGroup, 'delegate-requests');
      if (!fs.existsSync(requestsDir)) continue;

      let requestFiles: string[];
      try {
        requestFiles = fs.readdirSync(requestsDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of requestFiles) {
        if (activeDelegations.size >= MAX_CONCURRENT_WORKERS) {
          logger.debug(
            { active: activeDelegations.size },
            'Max concurrent workers reached, deferring',
          );
          break;
        }

        const filePath = path.join(requestsDir, file);
        let request: DelegateRequest;

        try {
          request = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (err) {
          logger.error({ file, err }, 'Failed to parse delegate request');
          try { fs.unlinkSync(filePath); } catch {}
          continue;
        }

        // Skip if already processing
        if (activeDelegations.has(request.id)) continue;

        // Remove request file immediately to prevent re-processing
        try { fs.unlinkSync(filePath); } catch {}

        activeDelegations.add(request.id);

        logger.info(
          { delegateId: request.id, sourceGroup, model: request.model },
          'Processing delegation request',
        );

        // Spawn worker in background (don't block the poll loop)
        spawnWorker(request, sourceGroup, ipcBaseDir, registeredGroups).finally(() => {
          activeDelegations.delete(request.id);
        });
      }
    }

    setTimeout(processDelegations, 500);
  };

  processDelegations();
  logger.info('Delegation handler started');
}

async function spawnWorker(
  request: DelegateRequest,
  sourceGroup: string,
  ipcBaseDir: string,
  registeredGroups: () => Record<string, RegisteredGroup>,
): Promise<void> {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'delegate-responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${request.id}.json`);

  // Find the registered group for this source
  const groups = registeredGroups();
  let group: RegisteredGroup | undefined;
  for (const [_jid, g] of Object.entries(groups)) {
    if (g.folder === sourceGroup) {
      group = g;
      break;
    }
  }

  if (!group) {
    writeResponse(responsePath, {
      error: `Source group '${sourceGroup}' not registered`,
      model: request.model,
    });
    return;
  }

  // Build a delegation-specific prompt that gives the worker context
  const workerPrompt = [
    `You are a worker agent delegated a task. Complete it and output your findings.`,
    `Do NOT use send_message — your output goes directly back to the delegating agent.`,
    `Be concise and focused. The delegating agent will use your output.`,
    ``,
    `## Task`,
    request.prompt,
  ].join('\n');

  try {
    let lastResult: string | null = null;

    const output = await runContainerAgent(
      group,
      {
        prompt: workerPrompt,
        groupFolder: sourceGroup,
        chatJid: request.source_chat_jid,
        isMain: false, // Workers are never main — restricted permissions
        isScheduledTask: true, // Treat like a scheduled task (isolated)
        assistantName: 'Worker',
        model: request.model || selectModel(
          request.prompt,
          loadModelRoutingConfig(sourceGroup),
        ).model,
      },
      (_proc, _name) => {
        // We don't track the process — container-runner handles cleanup
      },
      // Streaming callback: accumulate last non-null result
      async (streamOutput: ContainerOutput) => {
        if (streamOutput.result) {
          lastResult = streamOutput.result;
        }
      },
    );

    // Write response from accumulated streaming results or final output
    const finalResult = lastResult || output.result;
    if (output.status === 'success' || finalResult) {
      writeResponse(responsePath, {
        result: finalResult || '(worker completed with no output)',
        model: request.model,
        status: output.status,
      });
    } else {
      writeResponse(responsePath, {
        error: output.error || 'Worker failed with unknown error',
        model: request.model,
      });
    }

    logger.info(
      { delegateId: request.id, status: output.status },
      'Delegation completed',
    );
  } catch (err) {
    logger.error(
      { delegateId: request.id, err },
      'Delegation failed',
    );
    writeResponse(responsePath, {
      error: `Worker error: ${err instanceof Error ? err.message : String(err)}`,
      model: request.model,
    });
  }
}

function writeResponse(
  responsePath: string,
  data: { result?: string; error?: string; model: string | null; status?: string },
): void {
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    ...data,
    timestamp: new Date().toISOString(),
  }, null, 2));
  fs.renameSync(tempPath, responsePath);
}
