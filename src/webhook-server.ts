import http from 'http';

import { processWebhook } from 'corsair';

import { corsair } from './corsair.js';
import { logger } from './logger.js';

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3002', 10);
const SLACK_CHANNEL = 'sdk-test';

export function startWebhookServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400);
        res.end('Bad Request: invalid JSON');
        return;
      }

      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = value;
      }

      try {
        const result = await processWebhook(
          corsair as Parameters<typeof processWebhook>[0],
          headers,
          body as Record<string, unknown>,
        );

        logger.debug(
          { plugin: result.plugin, action: result.action },
          'Webhook received',
        );

        if (result.plugin === 'linear' && result.action === 'issues.create') {
          const payload = result.body as {
            data?: { title?: string; identifier?: string };
            url?: string;
          };
          const title = payload?.data?.title ?? 'Untitled';
          const identifier = payload?.data?.identifier ?? '';
          const url = payload?.url ?? '';

          const text = url
            ? `New Linear issue created: *${identifier ? `${identifier}: ` : ''}${title}* — ${url}`
            : `New Linear issue created: *${identifier ? `${identifier}: ` : ''}${title}*`;

          await corsair.slack.api.messages.post({
            channel: SLACK_CHANNEL,
            text,
          });

          logger.info(
            { title, identifier, channel: SLACK_CHANNEL },
            'Slack notification sent for new Linear issue',
          );
        }

        const statusCode = result.response?.statusCode ?? 200;
        const returnBody = result.response?.returnToSender ?? {};
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(returnBody));
      } catch (err) {
        logger.error({ err }, 'Webhook processing error');
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    req.on('error', (err) => {
      logger.error({ err }, 'Webhook request error');
      res.writeHead(500);
      res.end('Internal Server Error');
    });
  });

  server.listen(WEBHOOK_PORT, () => {
    logger.info({ port: WEBHOOK_PORT }, 'Webhook server listening');
  });

  return server;
}
