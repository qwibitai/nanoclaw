/**
 * Pushover MCP Server for NanoClaw
 * Allows agents to send push notifications to user's devices.
 * Credentials passed via environment variables (main channel only).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

function log(message: string): void {
  console.error(`[notifications-mcp] ${message}`);
}

export function createPushoverMcp() {
  const userKey = process.env.PUSHOVER_USER_KEY;
  const appToken = process.env.PUSHOVER_APP_TOKEN;
  const defaultDevice = process.env.PUSHOVER_DEVICE;

  return createSdkMcpServer({
    name: 'notifications',
    version: '1.0.0',
    tools: [
      tool(
        'send_notification',
        `Send a push notification to the user's device.

Use this to alert the user about important events, reminders, or when you need their attention outside of WhatsApp/chat.

Priority levels:
- -2: Lowest (no notification, just badge)
- -1: Low (quiet notification)
-  0: Normal (default)
-  1: High (bypass quiet hours)
-  2: Emergency (requires acknowledgment, use sparingly)`,
        {
          title: z.string().describe('Notification title (short, descriptive)'),
          message: z.string().describe('Notification body text'),
          priority: z
            .number()
            .min(-2)
            .max(2)
            .optional()
            .describe('Priority level (-2 to 2, default: 0)'),
          url: z.string().optional().describe('Optional URL to include'),
          url_title: z
            .string()
            .optional()
            .describe('Title for the URL (if url provided)'),
          sound: z
            .string()
            .optional()
            .describe('Notification sound (e.g., "default", "bike", "none")'),
        },
        async (args) => {
          if (!userKey || !appToken) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Push notifications not configured',
                },
              ],
              isError: true,
            };
          }

          try {
            const body = new URLSearchParams({
              token: appToken,
              user: userKey,
              title: args.title,
              message: args.message,
              priority: String(args.priority ?? 0),
            });

            if (defaultDevice) {
              body.append('device', defaultDevice);
            }

            if (args.url) {
              body.append('url', args.url);
              if (args.url_title) {
                body.append('url_title', args.url_title);
              }
            }

            if (args.sound) {
              body.append('sound', args.sound);
            }

            log(`Sending notification: ${args.title}`);

            const response = await fetch(PUSHOVER_API_URL, {
              method: 'POST',
              body,
            });

            if (!response.ok) {
              const text = await response.text();
              log(`Notification API error: ${response.status} - ${text}`);
              return {
                content: [
                  {
                    type: 'text',
                    text: `Notification API error: ${response.status}`,
                  },
                ],
                isError: true,
              };
            }

            const result = await response.json();
            log(`Notification sent successfully: ${JSON.stringify(result)}`);

            return {
              content: [
                { type: 'text', text: `Notification sent: "${args.title}"` },
              ],
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log(`Failed to send notification: ${errorMsg}`);
            return {
              content: [{ type: 'text', text: `Error: ${errorMsg}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
