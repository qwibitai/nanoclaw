import express from 'express';
import { executePermission, processWebhook } from 'corsair';

import { corsair, db } from './corsair.js';
import { writeIpcMessage } from './corsair-mcp.js';
import { MAIN_GROUP_FOLDER, WEBHOOK_LISTENER_PORT } from './config.js';
import { getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';

type PermRow = {
  id: string;
  plugin: string;
  endpoint: string;
  args: string;
  status: string;
  expires_at: string;
};

// ── HTML helpers ──────────────────────────────────────────────────────────────

function permissionPage(title: string, body: string, token?: string): string {
  const form = token
    ? `<form method="POST" style="margin-top:1.5rem">
        <button type="submit">Approve</button>
       </form>
       <p style="margin-top:1rem;color:#6b7280">To deny: close this page and reply to the agent.</p>`
    : '';
  return `<!DOCTYPE html><html><head><title>${title}</title><style>
    body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:1rem;color:#111}
    h1{font-size:1.5rem;margin-bottom:0.5rem}
    .badge{display:inline-block;background:#f3f4f6;border-radius:0.25rem;padding:0.25rem 0.5rem;font-family:monospace;font-size:0.9rem}
    table{width:100%;border-collapse:collapse;margin:1rem 0}
    td{padding:0.5rem 0.75rem;border:1px solid #e5e7eb;vertical-align:top;word-break:break-word}
    td:first-child{font-weight:600;width:30%;background:#f9fafb;white-space:nowrap}
    pre{margin:0;white-space:pre-wrap;font-size:0.85rem}
    button{background:#2563eb;color:#fff;border:none;padding:0.75rem 2rem;font-size:1rem;border-radius:0.375rem;cursor:pointer}
    button:hover{background:#1d4ed8}
    .warn{background:#fef9c3;border:1px solid #fde68a;padding:0.75rem;border-radius:0.375rem;margin:1rem 0;font-size:0.9rem}
    .ok{background:#dcfce7;border:1px solid #86efac;padding:0.75rem;border-radius:0.375rem;margin:1rem 0}
    .err{background:#fee2e2;border:1px solid #fca5a5;padding:0.75rem;border-radius:0.375rem;margin:1rem 0}
  </style></head><body>${body}${form}</body></html>`;
}

function renderArgs(rawArgs: string): string {
  let args: Record<string, unknown>;
  try { args = JSON.parse(rawArgs); } catch { return `<pre>${rawArgs}</pre>`; }

  const rows = Object.entries(args).map(([k, v]) => {
    const val = typeof v === 'string'
      ? v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')
      : `<pre>${JSON.stringify(v, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    return `<tr><td>${k}</td><td>${val}</td></tr>`;
  }).join('');

  return `<table>${rows}</table>`;
}

// ── Server entry point ────────────────────────────────────────────────────────

export function startCorsairWebhookServer(port: number): void {
  const app = express();
  app.use(express.json());

  // ── Inbound webhook events ─────────────────────────────────────────────────

  app.post('/webhooks', async (req, res) => {
    try {
      const webhookResponse = await processWebhook(
        corsair,
        req.headers,
        req.body,
        { tenantId: 'default' },
      );

      logger.info(
        { plugin: webhookResponse.plugin, action: webhookResponse.action },
        'Webhook received',
      );

      // Send HTTP response immediately — listeners fire after
      if (webhookResponse.response !== undefined) {
        res.json(webhookResponse.response);
      } else if (webhookResponse.plugin) {
        // Webhook matched a plugin but handler returned no explicit response — return 200 OK
        // so callers (e.g. Slack) don't retry the delivery.
        res.json({ ok: true });
      } else {
        res.status(404).json({ success: false, message: 'No matching webhook handler found' });
      }

      // Forward to the webhook listener server (SQLite-backed listeners)
      if (webhookResponse.plugin) {
        fetch(`http://localhost:${WEBHOOK_LISTENER_PORT}/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin: webhookResponse.plugin,
            action: webhookResponse.action ?? '',
            event: webhookResponse.body,
          }),
        }).catch((err) =>
          logger.error({ err, plugin: webhookResponse.plugin }, 'Webhook listener forward error'),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Corsair webhook error');
      if (!res.headersSent) res.sendStatus(500);
    }
  });

  // ── Permission approval page ───────────────────────────────────────────────
  // GET: show a human-readable page with the action details and an Approve button

  app.get('/api/permission/:token', (req, res) => {
    const perm = db.prepare(
      'SELECT id, plugin, endpoint, args, status, expires_at FROM corsair_permissions WHERE token=?',
    ).get(req.params.token) as PermRow | undefined;

    if (!perm) {
      return res.status(404).send(permissionPage('Not Found',
        '<h1>Not Found</h1><div class="err">This permission request does not exist.</div>'));
    }
    if (perm.status !== 'pending') {
      return res.status(410).send(permissionPage('Already Handled',
        `<h1>Already Handled</h1><div class="ok">This permission is already <strong>${perm.status}</strong>.</div>`));
    }
    if (new Date(perm.expires_at) < new Date()) {
      return res.status(410).send(permissionPage('Expired',
        '<h1>Expired</h1><div class="err">This permission request has expired. The agent will need to try again.</div>'));
    }

    const body = `
      <h1>Approve Action</h1>
      <div class="warn">⚠️ Clicking <strong>Approve</strong> will immediately execute this action.</div>
      <p>Action: <span class="badge">${perm.plugin}.${perm.endpoint}</span></p>
      ${renderArgs(perm.args)}
      <p style="font-size:0.85rem;color:#6b7280">Expires: ${new Date(perm.expires_at).toLocaleString()}</p>
    `;
    res.send(permissionPage('Approve Action', body, req.params.token));
  });

  // POST: user clicked Approve — set status to approved then execute

  app.post('/api/permission/:token', async (req, res) => {
    const { token } = req.params;

    const perm = db.prepare(
      'SELECT id, plugin, endpoint, status, expires_at FROM corsair_permissions WHERE token=?',
    ).get(token) as PermRow | undefined;

    if (!perm) {
      return res.status(404).send(permissionPage('Not Found',
        '<h1>Not Found</h1><div class="err">This permission request does not exist.</div>'));
    }
    if (perm.status !== 'pending') {
      return res.status(410).send(permissionPage('Already Handled',
        `<h1>Already Handled</h1><div class="ok">This permission is <strong>${perm.status}</strong>.</div>`));
    }
    if (new Date(perm.expires_at) < new Date()) {
      return res.status(410).send(permissionPage('Expired',
        '<h1>Expired</h1><div class="err">This request has expired.</div>'));
    }

    // Transition to approved so executePermission can run it
    db.prepare("UPDATE corsair_permissions SET status='approved', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), perm.id);

    const outcome = await executePermission(corsair, token);
    logger.info({ plugin: perm.plugin, endpoint: perm.endpoint, error: outcome.error }, 'Permission executed');

    const groups = getAllRegisteredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.folder === MAIN_GROUP_FOLDER);

    if (outcome.error) {
      if (mainEntry) {
        const [mainJid, mainGroup] = mainEntry;
        writeIpcMessage(mainGroup.folder, mainJid,
          `⚠️ Approved action failed\n\nAction: \`${perm.plugin}.${perm.endpoint}\`\nError: ${outcome.error}\n\nThe agent will attempt to recover.`,
        );
      }
      return res.status(500).send(permissionPage('Action Failed',
        `<h1>Action Failed</h1><div class="err"><strong>${perm.plugin}.${perm.endpoint}</strong> could not be executed.<br><br>${outcome.error}</div>
         <p>The agent has been notified and will attempt to recover.</p>`));
    }

    if (mainEntry) {
      const [mainJid, mainGroup] = mainEntry;
      writeIpcMessage(mainGroup.folder, mainJid,
        `✅ Approved: \`${perm.plugin}.${perm.endpoint}\` executed successfully.`,
      );
    }

    res.send(permissionPage('Approved',
      `<h1>✓ Approved</h1><div class="ok"><strong>${perm.plugin}.${perm.endpoint}</strong> was executed successfully.</div>`));
  });

  app.listen(port, () => logger.info(`Corsair webhook server on :${port}`));
}
