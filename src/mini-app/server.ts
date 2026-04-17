import express from 'express';
import type Database from 'better-sqlite3';
import { renderTaskDetail } from './templates/task-detail.js';
import { renderEmailFull } from './templates/email-full.js';
import { renderDraftDiff } from './templates/draft-diff.js';
import { getCachedEmailBody, cacheEmailBody, getCachedEmailMeta, cacheEmailMeta } from '../email-preview.js';
import type { GmailOps } from '../gmail-ops.js';
import type { DraftEnrichmentWatcher } from '../draft-enrichment.js';
import { logger } from '../logger.js';
import type { TaskStep, TaskLog } from './templates/task-detail.js';

export interface MiniAppServerOpts {
  port: number;
  db: Database.Database;
  gmailOps?: GmailOps;
  draftWatcher?: DraftEnrichmentWatcher;
}

export function createMiniAppServer(opts: MiniAppServerOpts): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId) as Record<string, string> | undefined;

    if (!row) {
      res.status(404).send('Task not found');
      return;
    }

    const html = renderTaskDetail({
      taskId: row.task_id,
      title: row.title,
      status: row.status as 'active' | 'blocked' | 'complete',
      steps: JSON.parse(row.steps_json) as TaskStep[],
      logs: JSON.parse(row.log_json) as TaskLog[],
      startedAt: row.started_at,
    });

    res.type('html').send(html);
  });

  // SSE endpoint for live task updates
  app.get('/api/task/:taskId/stream', (req, res) => {
    const { taskId } = req.params;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send current state immediately
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);
    if (row) {
      res.write(`data: ${JSON.stringify(row)}\n\n`);
    }

    // Poll for changes every 2 seconds
    const intervalId = setInterval(() => {
      const current = opts.db
        .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
        .get(taskId) as Record<string, string> | undefined;
      if (current) {
        res.write(`data: ${JSON.stringify(current)}\n\n`);
        // Stop polling if task is complete
        if (current.status === 'complete') {
          res.write('event: complete\ndata: {}\n\n');
          clearInterval(intervalId);
          res.end();
        }
      }
    }, 2000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(intervalId);
    });
  });

  app.get('/api/task/:taskId/state', (req, res) => {
    const { taskId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get(taskId);

    if (!row) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json(row);
  });

  // --- Email full view ---
  app.get('/email/:emailId', async (req, res) => {
    const { emailId } = req.params;
    const account = (req.query.account as string) || '';

    let meta = getCachedEmailMeta(emailId);

    if (!meta && opts.gmailOps && account) {
      try {
        if ('getMessageMeta' in opts.gmailOps) {
          meta = await (opts.gmailOps as any).getMessageMeta(account, emailId);
          if (meta) cacheEmailMeta(emailId, meta);
        }
      } catch (err) {
        logger.warn({ emailId, err }, 'Failed to fetch email meta for Mini App');
      }
    }

    if (!meta) {
      let body = getCachedEmailBody(emailId);
      if (!body && opts.gmailOps && account) {
        try {
          body = await opts.gmailOps.getMessageBody(account, emailId);
          if (body) cacheEmailBody(emailId, body);
        } catch (err) {
          logger.warn(
            { emailId, err },
            'Failed to fetch email body for Mini App',
          );
        }
      }
      meta = { subject: '', from: '', to: '', date: '', body: body || 'Email body could not be loaded.' };
    }

    const html = renderEmailFull({
      subject: meta.subject || `Email ${emailId}`,
      from: meta.from || '',
      to: meta.to || '',
      date: meta.date || '',
      body: meta.body || 'Email body could not be loaded.',
      cc: meta.cc,
      attachments: [],
      emailId,
      account,
    });
    res.type('html').send(html);
  });

  // --- Draft diff view ---
  app.get('/draft-diff/:draftId', (req, res) => {
    const { draftId } = req.params;
    const row = opts.db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get(draftId) as
      | { account: string; original_body: string; enriched_at: string }
      | undefined;

    if (!row) {
      res.status(404).send('Draft not found');
      return;
    }

    const html = renderDraftDiff({
      draftId,
      account: row.account,
      originalBody: row.original_body,
      enrichedBody: null,
      enrichedAt: row.enriched_at,
    });
    res.type('html').send(html);
  });

  // --- Draft revert API ---
  app.post('/api/draft/:draftId/revert', async (req, res) => {
    const { draftId } = req.params;
    if (!opts.draftWatcher) {
      res
        .status(503)
        .json({ success: false, error: 'Draft watcher not configured' });
      return;
    }
    try {
      const success = await opts.draftWatcher.revert(draftId);
      res.json({ success });
    } catch (err) {
      logger.error({ draftId, err }, 'Draft revert failed');
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  return app;
}

export function startMiniAppServer(opts: MiniAppServerOpts): void {
  const app = createMiniAppServer(opts);
  app.listen(opts.port, () => {
    logger.info({ port: opts.port }, 'Mini App server started');
  });
}
