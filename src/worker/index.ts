import { GATEWAY_URL, WORKER_POLL_INTERVAL } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import type { WorkItem, WorkResult } from '../shared/types.ts';
import { runAgent } from './agent.ts';
import { getSessionId, saveSessionId } from './sessions.ts';
import { buildWorkspace } from './workspace.ts';

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
    { id: item.id, session: item.sessionId, channel: item.channel },
    'Processing work item',
  );

  // Use Agent SDK session ID from the gateway session, or from local persistence
  const agentSessionId =
    item.agentSessionId || getSessionId(item.sessionId);

  const { cwd, systemPrompt } = buildWorkspace(item.sessionId);

  const agentResult = await runAgent({
    prompt: item.prompt,
    cwd,
    sessionId: agentSessionId,
    systemPrompt,
  });

  // Persist Agent SDK session ID locally for resume across restarts
  if (agentResult.sessionId) {
    saveSessionId(item.sessionId, agentResult.sessionId);
  }

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
    { id: item.id, session: item.sessionId, status: agentResult.status },
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
