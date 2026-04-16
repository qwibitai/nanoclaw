import { createHmac, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';

import { eventBus } from '../event-bus.js';
import type { NanoClawEvent } from '../events.js';
import { logger } from '../logger.js';

/**
 * Validates an HMAC-SHA256 webhook signature.
 *
 * @param body - Raw request body string
 * @param signature - Signature from x-hub-signature-256 header (format: "sha256=<hex>")
 * @param secret - HMAC secret
 * @returns true if signature is valid
 */
export function validateWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const provided = signature.slice('sha256='.length);
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(provided, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Converts a raw webhook payload into a NanoClawEvent.
 *
 * @param source - Webhook source identifier (e.g. "github", "notion", "generic")
 * @param payload - Parsed JSON payload object
 * @returns NanoClawEvent with type `webhook.${source}`
 */
export function parseWebhookPayload(
  source: string,
  payload: Record<string, unknown>,
): NanoClawEvent {
  return {
    type: `webhook.${source}`,
    source: 'webhook',
    timestamp: Date.now(),
    payload: {
      webhookSource: source,
      data: payload,
    },
  };
}

/**
 * Reads the full body from an IncomingMessage.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Starts the webhook HTTP server.
 *
 * POST /  — accepts webhook events; validates HMAC if secret is set
 *
 * @param port - Port to listen on (0 = disabled, server won't start)
 * @param secret - HMAC secret; empty string skips signature validation
 * @returns The HTTP server instance (already listening), or null if port === 0
 */
export function startWebhookServer(
  port: number,
  secret: string,
): import('http').Server | null {
  if (port <= 0) {
    logger.info('Webhook server disabled (WEBHOOK_PORT=0)');
    return null;
  }

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch (err) {
        logger.warn({ err }, 'Webhook: failed to read request body');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      // Validate HMAC signature when secret is configured
      if (secret !== '') {
        const signature =
          (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
        if (!validateWebhookSignature(body, signature, secret)) {
          logger.warn(
            { signature: signature.slice(0, 16) },
            'Webhook: invalid signature — request rejected',
          );
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
      }

      // Parse JSON body
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error('Payload must be a JSON object');
        }
        payload = parsed as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, 'Webhook: invalid JSON body');
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      const webhookSource =
        (req.headers['x-webhook-source'] as string | undefined) ?? 'generic';

      const event = parseWebhookPayload(webhookSource, payload);

      // Emit using the generic NanoClawEvent path — webhook types are not in the
      // typed EventMap, so we cast to the closest compatible event type that
      // accepts arbitrary payload shapes.
      eventBus.emit(
        'webhook.received',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        event as any,
      );

      logger.info(
        { source: webhookSource, type: event.type },
        'Webhook: event received and emitted',
      );

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    },
  );

  server.listen(port, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    logger.info({ port: boundPort }, 'Webhook server listening');
  });

  return server;
}
