import { resolve } from '@std/path';
import { GATEWAY_URL, WORKER_POLL_INTERVAL, WORKSPACE_DIR, STORE_URL } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { setStoreUrl, saveJsonl, getJsonl } from '../shared/store-client.ts';
import type { Attachment, WorkItem, WorkResult } from '../shared/types.ts';
import { runAgent } from './agent.ts';
import { getSessionId, saveSessionId } from './sessions.ts';
import { buildWorkspace, cleanupOldWorkspaces } from './workspace.ts';

/**
 * Compute the Agent SDK session directory from a workspace cwd.
 * The SDK stores sessions at ~/.claude/projects/<encoded-cwd>/
 * where encoded-cwd replaces every non-alphanumeric char with -
 */
function getAgentSessionDir(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const home = Deno.env.get('HOME') || '/home/nexus';
  return resolve(home, '.claude', 'projects', encoded);
}

/**
 * Get the path to a session's JSONL file.
 */
function getJsonlPath(agentSessionId: string, cwd: string): string {
  const dir = getAgentSessionDir(cwd);
  return resolve(dir, `${agentSessionId}.jsonl`);
}

/**
 * Get JSONL file size (0 if doesn't exist).
 */
function jsonlFileSize(path: string): number {
  try {
    return Deno.statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Restore JSONL from store only if the file doesn't exist locally.
 * On first message after restart/deploy, the file is missing and we restore.
 * On subsequent messages, the file exists and we skip (already have it).
 */
async function restoreJsonl(
  gatewaySessionId: string,
  agentSessionId: string | undefined,
  cwd: string,
): Promise<void> {
  if (!agentSessionId) return;
  const file = getJsonlPath(agentSessionId, cwd);

  // Skip if we already have the file locally
  if (jsonlFileSize(file) > 0) {
    logger.debug({ gatewaySessionId }, 'JSONL exists locally, skipping restore');
    return;
  }

  try {
    const content = await getJsonl(gatewaySessionId);
    if (!content) return;
    const dir = getAgentSessionDir(cwd);
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeFileSync(file, content);
    logger.info({ gatewaySessionId, size: content.length }, 'JSONL restored from store');
  } catch (err) {
    logger.warn({ err }, 'Failed to restore JSONL from store');
  }
}

/**
 * Save JSONL to store only if the file size changed (new messages added).
 */
async function persistJsonl(
  gatewaySessionId: string,
  agentSessionId: string | undefined,
  cwd: string,
  sizeBefore: number,
): Promise<void> {
  if (!agentSessionId) return;
  const file = getJsonlPath(agentSessionId, cwd);
  const sizeAfter = jsonlFileSize(file);

  if (sizeAfter <= sizeBefore) {
    logger.debug({ gatewaySessionId }, 'JSONL unchanged, skipping upload');
    return;
  }

  try {
    const content = Deno.readFileSync(file);
    await saveJsonl(gatewaySessionId, content);
    logger.debug(
      { gatewaySessionId, sizeBefore, sizeAfter },
      'JSONL saved to store',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to persist JSONL to store');
  }
}

// Configure store client
setStoreUrl(STORE_URL);

// Clean up workspaces for sessions inactive > 7 days
cleanupOldWorkspaces().catch(() => {});

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
    item.agentSessionId || (await getSessionId(item.sessionId));

  const { cwd, systemPrompt } = buildWorkspace(item.sessionId);

  // Restore JSONL from store if not present locally (first message after restart)
  await restoreJsonl(item.sessionId, agentSessionId, cwd);

  // Track JSONL size before query to detect changes
  const jsonlPath = agentSessionId
    ? getJsonlPath(agentSessionId, cwd)
    : '';
  const jsonlSizeBefore = jsonlPath ? jsonlFileSize(jsonlPath) : 0;

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

  // Persist Agent SDK session ID and JSONL transcript
  const finalSessionId = agentResult.sessionId || agentSessionId;
  if (agentResult.sessionId) {
    await saveSessionId(item.sessionId, agentResult.sessionId);
  }
  const finalJsonlPath = finalSessionId
    ? getJsonlPath(finalSessionId, cwd)
    : jsonlPath;
  const finalSizeBefore =
    finalSessionId === agentSessionId ? jsonlSizeBefore : 0;
  await persistJsonl(
    item.sessionId,
    finalSessionId,
    cwd,
    finalSizeBefore,
  );

  const result: WorkResult = {
    id: item.id,
    gatewaySessionId: item.sessionId,
    channel: item.channel,
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
          gatewaySessionId: item.sessionId,
          channel: item.channel,
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
