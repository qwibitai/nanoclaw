import express from 'express';
import type Database from 'better-sqlite3';
import { renderTaskDetail } from './templates/task-detail.js';
import { renderEmailFull } from './templates/email-full.js';
import { renderDraftDiff } from './templates/draft-diff.js';
import {
  getCachedEmailBody,
  cacheEmailBody,
  getCachedEmailMeta,
  cacheEmailMeta,
} from '../email-preview.js';
import type { GmailOps } from '../gmail-ops.js';
import type { DraftEnrichmentWatcher } from '../draft-enrichment.js';
import { logger } from '../logger.js';
import type { TaskStep, TaskLog } from './templates/task-detail.js';
import { PendingSendRegistry } from './pending-send.js';

export interface MiniAppServerOpts {
  port: number;
  db: Database.Database;
  gmailOps?: GmailOps;
  draftWatcher?: DraftEnrichmentWatcher;
  eventBus?: import('../event-bus.js').EventBus;
  pendingSendRegistry?: PendingSendRegistry;
}

export function createMiniAppServer(opts: MiniAppServerOpts): express.Express {
  const registry = opts.pendingSendRegistry ?? new PendingSendRegistry();
  const app = express();
  app.use(express.json());

  // Root page — opened when user taps the "📱 App" menu button in Telegram.
  // Lists the attention and archive queues with live counts so the user has
  // somewhere to land. Individual item links go to existing /email/:id etc.
  app.get('/', (_req, res) => {
    const attention = opts.db
      .prepare(
        `SELECT id, title, detected_at FROM tracked_items
         WHERE state IN ('pushed','pending','held')
           AND classification = 'push'
         ORDER BY detected_at DESC
         LIMIT 20`,
      )
      .all() as Array<{ id: string; title: string; detected_at: number }>;
    const archive = opts.db
      .prepare(
        `SELECT id, title, action_intent, detected_at FROM tracked_items
         WHERE classification = 'digest' AND state = 'queued'
         ORDER BY detected_at DESC
         LIMIT 20`,
      )
      .all() as Array<{
      id: string;
      title: string;
      action_intent: string | null;
      detected_at: number;
    }>;

    const esc = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c] ?? c,
      );
    const row = (it: { id: string; title: string; detected_at: number }) => {
      const mins = Math.round((Date.now() - it.detected_at) / 60_000);
      return `<li><a href="/email/${esc(it.id)}">${esc(it.title || '(no subject)')}</a> <span class="age">${mins}m</span></li>`;
    };

    res.type('html').send(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nanoclaw</title>
<style>
body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#f4f6f8;color:#111}
h1{font-size:18px;margin:0 0 16px}
h2{font-size:15px;margin:20px 0 8px;color:#444}
ul{list-style:none;padding:0;margin:0;background:#fff;border-radius:10px;overflow:hidden}
li{padding:10px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;gap:8px;align-items:baseline}
li:last-child{border-bottom:none}
a{color:#0366d6;text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.age{color:#888;font-size:12px;flex:none}
.empty{color:#888;font-style:italic;padding:10px 14px;background:#fff;border-radius:10px}
</style></head><body>
<h1>nanoclaw</h1>
<h2>📥 Attention (${attention.length})</h2>
${attention.length === 0 ? '<div class="empty">Inbox is clear.</div>' : `<ul>${attention.map(row).join('')}</ul>`}
<h2>🗂 Archive queue (${archive.length})</h2>
${archive.length === 0 ? '<div class="empty">Nothing queued for archive.</div>' : `<ul>${archive.map(row).join('')}</ul>`}
</body></html>`);
  });

  function lookupDraftAccount(draftId: string): string | null {
    const row = opts.db
      .prepare('SELECT account FROM draft_originals WHERE draft_id = ?')
      .get(draftId) as { account: string } | undefined;
    return row?.account ?? null;
  }

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
        logger.warn(
          { emailId, err },
          'Failed to fetch email meta for Mini App',
        );
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
      meta = {
        subject: '',
        from: '',
        to: '',
        date: '',
        body: body || 'Email body could not be loaded.',
      };
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

  // --- Archive email API ---
  app.post('/api/email/:emailId/archive', async (req, res) => {
    const { emailId } = req.params;
    const { account, threadId } = req.body;
    if (!opts.gmailOps || !account) {
      res.status(400).json({ error: 'Missing account or gmailOps' });
      return;
    }
    try {
      await opts.gmailOps.archiveThread(account, threadId || emailId);
      res.json({ success: true });
    } catch (err) {
      logger.error({ emailId, err }, 'Mini app archive failed');
      res.status(500).json({ error: 'Archive failed' });
    }
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

  // --- Reply view (render) ---
  app.get('/reply/:draftId', async (req, res) => {
    const { draftId } = req.params;
    const account = lookupDraftAccount(draftId);
    if (!account) {
      res
        .type('html')
        .send(
          '<html><body style="background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;padding:24px;"><h2>Draft no longer exists</h2><p>The draft may have been sent or deleted.</p></body></html>',
        );
      return;
    }
    if (!opts.gmailOps) {
      res.status(500).type('html').send('Gmail ops not configured');
      return;
    }
    try {
      const ctx = await opts.gmailOps.getDraftReplyContext(account, draftId);
      if (!ctx) {
        res
          .type('html')
          .send(
            '<html><body style="background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;padding:24px;"><h2>Draft no longer exists</h2><p>The draft may have been sent or deleted.</p></body></html>',
          );
        return;
      }
      const html = renderEmailFull({
        mode: 'reply',
        draftId,
        account,
        subject: ctx.incoming.subject,
        from: ctx.incoming.from,
        to: ctx.incoming.to,
        cc: ctx.incoming.cc,
        date: ctx.incoming.date,
        body: ctx.body,
        attachments: [],
      });
      res.type('html').send(html);
    } catch (err) {
      logger.error({ draftId, err }, 'Failed to render /reply');
      res.status(500).type('html').send('Failed to load draft');
    }
  });

  // --- Save draft body ---
  app.patch('/api/draft/:draftId/save', async (req, res) => {
    const { draftId } = req.params;
    const body = req.body?.body;
    if (typeof body !== 'string') {
      res.status(400).json({
        ok: false,
        error: 'body field must be a string',
        code: 'INVALID_BODY',
      });
      return;
    }
    const account = lookupDraftAccount(draftId);
    if (!account) {
      res.status(404).json({
        ok: false,
        error: 'Draft not found',
        code: 'DRAFT_NOT_FOUND',
      });
      return;
    }
    if (!opts.gmailOps) {
      res
        .status(500)
        .json({ ok: false, error: 'Gmail not configured', code: 'INTERNAL' });
      return;
    }
    try {
      await opts.gmailOps.updateDraft(account, draftId, body);
      logger.info(
        { account, draftId, bodyLen: body.length, component: 'mini-app' },
        'Draft save via mini-app',
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error(
        { account, draftId, err, component: 'mini-app' },
        'Draft save failed from mini-app',
      );
      res.status(500).json({
        ok: false,
        error: 'Gmail API error',
        code: 'GMAIL_API_ERROR',
      });
    }
  });

  // --- Schedule send with 10s undo window ---
  app.post('/api/draft/:draftId/send', async (req, res) => {
    const { draftId } = req.params;
    const account = lookupDraftAccount(draftId);
    if (!account) {
      res.status(404).json({
        ok: false,
        error: 'Draft not found',
        code: 'DRAFT_NOT_FOUND',
      });
      return;
    }
    if (!opts.gmailOps) {
      res
        .status(500)
        .json({ ok: false, error: 'Gmail not configured', code: 'INTERNAL' });
      return;
    }
    const delayMs = 10_000;
    const { sendAt } = registry.schedule(
      draftId,
      account,
      delayMs,
      async (id, acct) => {
        try {
          await opts.gmailOps!.sendDraft(acct, id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { account: acct, draftId: id, err, component: 'mini-app' },
            'Draft send failed',
          );
          opts.eventBus?.emit('email.draft.send_failed', {
            type: 'email.draft.send_failed',
            source: 'mini-app',
            timestamp: Date.now(),
            payload: { draftId: id, account: acct, error: message },
          });
        }
      },
    );
    logger.info(
      { account, draftId, sendAt, delayMs, component: 'mini-app' },
      'Draft send scheduled',
    );
    res.json({ ok: true, sendAt });
  });

  // --- Cancel pending send ---
  app.post('/api/draft/:draftId/send/cancel', (req, res) => {
    const { draftId } = req.params;
    const cancelled = registry.cancel(draftId);
    if (cancelled) {
      logger.info({ draftId, component: 'mini-app' }, 'Draft send cancelled');
    }
    res.json({ ok: true, cancelled });
  });

  return app;
}

export function startMiniAppServer(opts: MiniAppServerOpts): {
  server: ReturnType<express.Application['listen']>;
  registry: PendingSendRegistry;
} {
  const registry = new PendingSendRegistry();
  const app = createMiniAppServer({ ...opts, pendingSendRegistry: registry });
  const server = app.listen(opts.port, () => {
    logger.info({ port: opts.port }, 'Mini App server started');
  });
  return { server, registry };
}
