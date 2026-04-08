import { resolve } from '@std/path';
import { GATEWAY_URL, WORKER_POLL_INTERVAL, WORKSPACE_DIR } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import type { Attachment, WorkItem, WorkResult } from '../shared/types.ts';
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

async function downloadAttachments(
  sessionId: string,
  attachments: Attachment[],
): Promise<string[]> {
  const attachDir = resolve(WORKSPACE_DIR, sessionId, 'attachments');
  Deno.mkdirSync(attachDir, { recursive: true });

  const paths: string[] = [];
  for (const att of attachments) {
    try {
      const response = await fetch(att.url);
      const data = new Uint8Array(await response.arrayBuffer());
      const filepath = resolve(attachDir, att.filename);
      Deno.writeFileSync(filepath, data);
      paths.push(`attachments/${att.filename}`);
      logger.info({ filename: att.filename, size: data.length }, 'Attachment downloaded');
    } catch (err) {
      logger.error({ err, filename: att.filename }, 'Failed to download attachment');
    }
  }
  return paths;
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

  // Download attachments to workspace before running agent
  let prompt = item.prompt;
  if (item.attachments && item.attachments.length > 0) {
    const imagePaths = await downloadAttachments(item.sessionId, item.attachments);
    if (imagePaths.length > 0) {
      const refs = imagePaths.map(p => `[Attached image: ${p}]`).join('\n');
      prompt = prompt
        ? `${prompt}\n\n${refs}`
        : `The user sent ${imagePaths.length} image(s). Please examine them.\n\n${refs}`;
    }
  }

  const agentResult = await runAgent({
    prompt,
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
