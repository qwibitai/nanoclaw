import { GATEWAY_URL, WORKER_POLL_INTERVAL } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type { WorkItem, WorkResult } from '../shared/types.js';
import { runAgent } from './agent.js';
import { getSessionId, saveSessionId } from './sessions.js';
import { buildWorkspace } from './workspace.js';

async function fetchWork(): Promise<WorkItem | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/work/next`);
    const data = (await res.json()) as { status: string; item?: WorkItem };
    if (data.status === 'work' && data.item) {
      return data.item;
    }
    return null;
  } catch (err) {
    logger.error({ err }, 'Failed to fetch work from gateway');
    return null;
  }
}

async function submitResult(result: WorkResult): Promise<void> {
  try {
    await fetch(`${GATEWAY_URL}/work/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to submit result to gateway');
  }
}

async function processWork(item: WorkItem): Promise<void> {
  logger.info(
    { id: item.id, groupId: item.groupId },
    'Processing work item',
  );

  // Get existing session for conversation continuity
  const sessionId = item.sessionId || getSessionId(item.groupId);

  // Build workspace with skills and knowledge
  const { cwd, systemPrompt } = buildWorkspace(item.groupId);

  // Run agent
  const agentResult = await runAgent({
    prompt: item.prompt,
    cwd,
    sessionId,
    systemPrompt,
  });

  // Save session for next time
  if (agentResult.sessionId) {
    saveSessionId(item.groupId, agentResult.sessionId);
  }

  // Submit result back to gateway
  const result: WorkResult = {
    id: item.id,
    status: agentResult.status,
    result: agentResult.result,
    sessionId: agentResult.sessionId,
    error: agentResult.error,
    completedAt: new Date().toISOString(),
  };

  await submitResult(result);
  logger.info(
    { id: item.id, status: agentResult.status },
    'Work item completed',
  );
}

async function pollLoop(): Promise<void> {
  logger.info({ gatewayUrl: GATEWAY_URL }, 'Worker started, polling for work');

  while (true) {
    const item = await fetchWork();

    if (item) {
      try {
        await processWork(item);
      } catch (err) {
        logger.error({ err, id: item.id }, 'Error processing work item');
        await submitResult({
          id: item.id,
          status: 'error',
          result: null,
          error: err instanceof Error ? err.message : String(err),
          completedAt: new Date().toISOString(),
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, WORKER_POLL_INTERVAL));
  }
}

pollLoop();
