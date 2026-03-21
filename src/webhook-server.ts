/**
 * Minimal HTTP webhook receiver for NanoClaw.
 * Lets the crewops dashboard (and any other host process) push messages
 * into WhatsApp without going through the IPC file system.
 *
 * POST /webhook
 *   { "channel": "main", "message": "text" }   → sends to the main group
 *   { "jid": "...", "message": "text" }         → sends to a specific JID
 */
import http from 'http';

import { logger } from './logger.js';
import { findChannel } from './router.js';
import { Channel, RegisteredGroup } from './types.js';

export function startWebhookServer(
  port: number,
  getChannels: () => Channel[],
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body) as {
          channel?: string;
          jid?: string;
          message?: string;
          file_path?: string;
          caption?: string;
        };

        const { message, file_path, caption } = payload;
        if (!message && !file_path) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message or file_path is required' }));
          return;
        }

        // Resolve target JID: explicit jid, or find the main group
        let targetJid = payload.jid;
        if (!targetJid) {
          const groups = getRegisteredGroups();
          for (const [jid, g] of Object.entries(groups)) {
            if (g.isMain) {
              targetJid = jid;
              break;
            }
          }
        }

        if (!targetJid) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No main group registered yet' }));
          return;
        }

        const channel = findChannel(getChannels(), targetJid);
        if (!channel) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: `No channel owns JID: ${targetJid}` }),
          );
          return;
        }

        if (file_path) {
          if (!channel.sendMedia) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Channel does not support sendMedia' }));
            return;
          }
          await channel.sendMedia(targetJid, file_path, caption);
          if (message) await channel.sendMessage(targetJid, message);
          logger.info({ targetJid, file_path }, 'Webhook document sent');
        } else {
          await channel.sendMessage(targetJid, message!);
          logger.info(
            { targetJid, length: message!.length },
            'Webhook message sent',
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jid: targetJid }));
      } catch (err) {
        logger.error({ err }, 'Webhook handler error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'Webhook server listening on 127.0.0.1');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Webhook server error');
  });

  return server;
}
