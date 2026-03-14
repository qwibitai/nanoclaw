import http from 'http';

import { WEBHOOK_LISTENER_PORT } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup, WebhookListener } from './types.js';

export interface WebhookServerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getAllWebhookListeners: () => WebhookListener[];
  runAgent: (group: RegisteredGroup, prompt: string, jid: string) => Promise<'success' | 'error'>;
}

function getNestedValue(obj: unknown, path: string): string {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) return '';
  if (typeof current === 'object') return JSON.stringify(current);
  return String(current);
}

function buildPrompt(template: string, plugin: string, action: string, event: unknown): string {
  const eventStr = JSON.stringify(event, null, 2).slice(0, 8000);
  return template
    .replace(/\{\{event\.([^}]+)\}\}/g, (_, path) => getNestedValue(event, path))
    .replace(/\{\{event\}\}/g, eventStr)
    .replace(/\{\{plugin\}\}/g, plugin)
    .replace(/\{\{action\}\}/g, action);
}

export function startWebhookServer(deps: WebhookServerDeps): http.Server {
  const webhookSecret = process.env.WEBHOOK_SECRET;

  const server = http.createServer((req, res) => {
    // Only accept POST /webhook
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    // Check Authorization header if WEBHOOK_SECRET is set
    if (webhookSecret) {
      const authHeader = req.headers['authorization'];
      if (authHeader !== `Bearer ${webhookSecret}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
        return;
      }
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed: { plugin: string; action?: string; event?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      const { plugin, action = '', event = {} } = parsed;
      if (!plugin) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing plugin' }));
        return;
      }

      const listeners = deps.getAllWebhookListeners();
      const matched = listeners.filter(
        (l) =>
          l.status === 'active' &&
          l.plugin === plugin &&
          (!l.action || l.action === action),
      );

      const groups = deps.registeredGroups();

      for (const listener of matched) {
        // Find the group by folder
        const group = Object.values(groups).find((g) => g.folder === listener.group_folder);
        if (!group) {
          logger.warn(
            { groupFolder: listener.group_folder, listenerId: listener.id },
            'Webhook listener group not found, skipping',
          );
          continue;
        }

        const prompt = buildPrompt(listener.prompt_template, plugin, action, event);

        deps.runAgent(group, prompt, listener.target_jid).catch((err) => {
          logger.error({ listenerId: listener.id, err }, 'Webhook agent run error');
        });
      }

      logger.info({ plugin, action, matched: matched.length }, 'Webhook event received');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, matched: matched.length }));
    });

    req.on('error', (err) => {
      logger.error({ err }, 'Webhook request error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Internal error' }));
    });
  });

  server.listen(WEBHOOK_LISTENER_PORT, () => {
    logger.info({ port: WEBHOOK_LISTENER_PORT }, 'Webhook server listening');
  });

  return server;
}
