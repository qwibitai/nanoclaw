/**
 * X Integration — MCP Tool Definitions (Container Side)
 *
 * These tools run inside the container's MCP stdio server and communicate
 * with the host via WebSocket. The host-side handler is in host.ts.
 *
 * Integration: Add these tool registrations to container/agent-runner/src/ipc-mcp-stdio.ts
 * inside an `if (isMain) { ... }` block, with the helper function above it.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WsClient } from './ws-client.js';

/**
 * Helper that sends an X action request to the host and returns an MCP tool result.
 * Requires `ensureWs` and `wsClient` from the parent module scope.
 */
async function callXEndpoint(
  ensureWs: () => Promise<void>,
  wsClient: WsClient,
  method: string,
  params: Record<string, unknown>,
  label: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  try {
    await ensureWs();
    const result = await wsClient.request(method, params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `X ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Register X integration MCP tools on the given server.
 * Call inside `if (isMain) { ... }` in ipc-mcp-stdio.ts.
 */
export function registerXTools(
  server: McpServer,
  ensureWs: () => Promise<void>,
  wsClient: WsClient,
): void {
  const call = (method: string, params: Record<string, unknown>, label: string) =>
    callXEndpoint(ensureWs, wsClient, method, params, label);

  server.tool(
    'x_post',
    `Post a tweet to X (Twitter). Main group only.
Make sure the content is appropriate and within X's character limit (280 chars for text).`,
    {
      content: z
        .string()
        .max(280)
        .describe('The tweet content to post (max 280 characters)'),
    },
    (args) => call('x_post', { content: args.content }, 'post'),
  );

  server.tool(
    'x_like',
    'Like a tweet on X (Twitter). Provide the tweet URL or tweet ID.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
    },
    (args) => call('x_like', { tweetUrl: args.tweet_url }, 'like'),
  );

  server.tool(
    'x_reply',
    'Reply to a tweet on X (Twitter). Provide the tweet URL and your reply content.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
      content: z
        .string()
        .max(280)
        .describe('The reply content (max 280 characters)'),
    },
    (args) =>
      call('x_reply', { tweetUrl: args.tweet_url, content: args.content }, 'reply'),
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet on X (Twitter). Provide the tweet URL.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
    },
    (args) =>
      call('x_retweet', { tweetUrl: args.tweet_url }, 'retweet'),
  );

  server.tool(
    'x_quote',
    'Quote tweet on X (Twitter). Retweet with your own comment added.',
    {
      tweet_url: z
        .string()
        .describe(
          'The tweet URL (e.g., https://x.com/user/status/123) or tweet ID',
        ),
      comment: z
        .string()
        .max(280)
        .describe('Your comment for the quote tweet (max 280 characters)'),
    },
    (args) =>
      call('x_quote', { tweetUrl: args.tweet_url, comment: args.comment }, 'quote'),
  );
}
