/**
 * Paperclip webhook receiver.
 * Receives HTTP adapter heartbeats from Paperclip and routes issues
 * to the configured agent group as task messages.
 *
 * Config:
 *   PAPERCLIP_URL             Paperclip base URL (default: http://paperclip:3100)
 *   PAPERCLIP_API_KEY         Paperclip API key (for fetching full issue details)
 *   PAPERCLIP_WEBHOOK_SECRET  Bearer token Paperclip sends on every heartbeat
 *   PAPERCLIP_GROUP_FOLDER    Folder name of the group that handles Paperclip tasks
 *   PAPERCLIP_WEBHOOK_PORT    Port to listen on (default: 3102)
 */
import { createServer, Server } from 'http';

import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

export interface PaperclipWebhookDeps {
  storeMessage: (msg: NewMessage) => void;
  enqueueGroup: (chatJid: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface HeartbeatPayload {
  agentId?: string;
  runId?: string;
  context?: {
    issueId?: string;
    title?: string;
    body?: string;
    labels?: string[];
    assignee?: string;
    [key: string]: unknown;
  };
}

async function fetchIssue(
  paperclipUrl: string,
  apiKey: string,
  issueId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${paperclipUrl}/api/issues/${encodeURIComponent(issueId)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Paperclip API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

export function startPaperclipWebhookServer(
  port: number,
  deps: PaperclipWebhookDeps,
): Server {
  const secret = process.env.PAPERCLIP_WEBHOOK_SECRET;
  const paperclipUrl = (
    process.env.PAPERCLIP_URL ?? 'http://paperclip:3100'
  ).replace(/\/$/, '');
  const apiKey = process.env.PAPERCLIP_API_KEY ?? '';
  const groupFolder = process.env.PAPERCLIP_GROUP_FOLDER ?? '';

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/paperclip/heartbeat') {
      res.writeHead(404).end();
      return;
    }

    // Authenticate
    const authHeader = req.headers['authorization'] ?? '';
    if (secret && authHeader !== `Bearer ${secret}`) {
      logger.warn('Paperclip heartbeat: unauthorized request');
      res.writeHead(401).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // Respond immediately — processing is fire and forget
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"ok":true}');

      (async () => {
        let body: HeartbeatPayload;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          logger.warn('Paperclip heartbeat: invalid JSON body');
          return;
        }

        const { runId, context } = body;
        if (!runId) {
          logger.warn('Paperclip heartbeat: missing runId');
          return;
        }

        // Resolve the target group JID from PAPERCLIP_GROUP_FOLDER
        const groups = deps.registeredGroups();
        const entry = Object.entries(groups).find(
          ([, g]) => g.folder === groupFolder,
        );
        if (!entry) {
          logger.error(
            { groupFolder },
            'Paperclip heartbeat: PAPERCLIP_GROUP_FOLDER does not match any registered group',
          );
          return;
        }
        const [chatJid] = entry;

        // Optionally fetch full issue details from Paperclip API
        let issueData: Record<string, unknown> | null = null;
        if (context?.issueId && apiKey) {
          try {
            issueData = await fetchIssue(paperclipUrl, apiKey, context.issueId);
          } catch (e) {
            logger.warn(
              { err: e },
              'Paperclip heartbeat: failed to fetch issue details, using context payload',
            );
          }
        }

        const issue = issueData ?? context ?? {};
        const issueId =
          (issue.issueId as string | undefined) ?? context?.issueId ?? '';
        const title =
          (issue.title as string | undefined) ?? context?.title ?? '(no title)';
        const body2 = (issue.body as string | undefined) ?? context?.body ?? '';
        const rawLabels = (issue.labels ?? context?.labels ?? []) as string[];
        const labels = rawLabels.join(', ');

        const lines = [
          `[Paperclip Task] Run: ${runId}`,
          issueId ? `Issue: ${issueId} — ${title}` : `Task: ${title}`,
          labels ? `Labels: ${labels}` : '',
          '',
          body2 || '(no description)',
          '',
          `To post a comment back: node /app/dist/paperclip-reporter.js ${runId} "<comment>"`,
        ];
        const taskText = lines
          .filter((l) => l !== null)
          .join('\n')
          .trim();

        const now = new Date().toISOString();
        deps.storeMessage({
          id: `paperclip-${runId}-${Date.now()}`,
          chat_jid: chatJid,
          sender: 'paperclip',
          sender_name: 'Paperclip',
          content: taskText,
          timestamp: now,
          is_from_me: false,
          is_bot_message: false,
        });

        deps.enqueueGroup(chatJid);
        logger.info(
          { runId, issueId, chatJid },
          'Paperclip task routed to group',
        );
      })();
    });
  });

  server.listen(port, () => {
    logger.info({ port }, 'Paperclip webhook server listening');
  });

  return server;
}
