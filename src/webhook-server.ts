import http from 'http';

import { processWebhook } from 'corsair';

import { corsair } from './corsair.js';
import { logger } from './logger.js';
import { WEBHOOK_PORT } from './config.js';

// Lazily resolved cache for sdk-test channel ID and Linear team ID
let sdkTestChannelId: string | null = null;
let linearTeamId: string | null = null;

async function resolveChannelId(name: string): Promise<string | null> {
  try {
    const result = await (corsair.slack.api as any).channels.list({});
    const channels: Array<{ id: string; name: string }> =
      (result as any)?.channels ?? [];
    return channels.find((c) => c.name === name)?.id ?? null;
  } catch (err) {
    logger.warn({ err }, 'Failed to list Slack channels');
    return null;
  }
}

async function resolveLinearTeamId(): Promise<string | null> {
  try {
    const result = await (corsair.linear.api as any).teams.list({});
    const nodes: Array<{ id: string }> = (result as any)?.nodes ?? [];
    return nodes[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err }, 'Failed to list Linear teams');
    return null;
  }
}

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
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end('Bad Request: invalid JSON');
        return;
      }

      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;

      try {
        const result = await processWebhook(
          corsair as Parameters<typeof processWebhook>[0],
          headers,
          body as Record<string, unknown>,
        );

        logger.info(
          { plugin: result.plugin, action: result.action },
          'Webhook received',
        );

        // When a Slack message is sent in sdk-test, create a Linear issue
        if (result.plugin === 'slack' && result.action === 'messages.message') {
          const event = (body as any)?.event as
            | Record<string, unknown>
            | undefined;
          const channelId = event?.channel as string | undefined;
          const text = (event?.text as string) || 'New message from sdk-test';

          if (channelId) {
            // Resolve sdk-test channel ID (cached after first call)
            if (!sdkTestChannelId) {
              sdkTestChannelId = await resolveChannelId('sdk-test');
            }

            if (sdkTestChannelId && channelId === sdkTestChannelId) {
              // Resolve Linear team ID (cached after first call)
              if (!linearTeamId) {
                linearTeamId = await resolveLinearTeamId();
              }

              if (linearTeamId) {
                try {
                  const issue = await (corsair.linear.api as any).issues.create(
                    {
                      title: text.slice(0, 200),
                      description: `Created from Slack #sdk-test message:\n\n${text}`,
                      teamId: linearTeamId,
                    },
                  );
                  logger.info(
                    { issueId: issue?.id, identifier: issue?.identifier },
                    'Linear issue created from Slack message',
                  );
                } catch (linearErr) {
                  logger.error(
                    { linearErr },
                    'Failed to create Linear issue from Slack message',
                  );
                }
              } else {
                logger.warn('No Linear team found, skipping issue creation');
              }
            }
          }
        }

        // When a Linear issue is created, send a Slack notification to sdk-test
        if (result.plugin === 'linear' && result.action === 'issues.create') {
          const issue = (result.body as Record<string, unknown> | null) ?? {};
          const data = (issue['data'] as Record<string, unknown>) ?? issue;
          const title = (data['title'] as string) ?? 'Untitled';
          const url = (data['url'] as string) ?? '';
          const identifier = (data['identifier'] as string) ?? '';
          const text = url
            ? `Test *New Linear issue created:* <${url}|${identifier}: ${title}>`
            : `Test *New Linear issue created:* ${identifier}: ${title}`;

          try {
            await corsair.slack.api.messages.post({
              channel: 'sdk-test',
              text,
            });
            logger.info(
              { channel: 'sdk-test', issue: identifier },
              'Slack notification sent',
            );
          } catch (slackErr) {
            logger.error({ slackErr }, 'Failed to send Slack notification');
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        logger.error({ err }, 'Webhook error');
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  });

  server.listen(WEBHOOK_PORT, () =>
    logger.info({ port: WEBHOOK_PORT }, 'Webhook server listening'),
  );
  return server;
}
