/**
 * X Integration - MCP Tool Definitions (Agent/Container Side)
 *
 * These tools run inside the container and communicate with the host via JSON-RPC.
 * The host-side implementation is in host.ts.
 *
 * Note: This file is compiled in the container, not on the host.
 * The @ts-ignore is needed because the SDK is only available in the container.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { JsonRpcTransport } from '../../jsonrpc-transport.js';

export interface SkillToolsContext {
  groupFolder: string;
  isMain: boolean;
}

/**
 * Create X integration MCP tools
 */
const X_REQUEST_TIMEOUT_MS = 60_000;

function sendWithTimeout(transport: JsonRpcTransport, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`X tool '${method}' timed out after ${X_REQUEST_TIMEOUT_MS / 1000}s`)),
      X_REQUEST_TIMEOUT_MS
    );
    Promise.resolve(transport.sendRequest(method, params)).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

export function createXTools(ctx: SkillToolsContext, transport: JsonRpcTransport) {
  const { isMain } = ctx;

  return [
    tool(
      'x_post',
      `Post a tweet to X (Twitter). Main group only.

The host machine will execute the browser automation to post the tweet.
Make sure the content is appropriate and within X's character limit (280 chars for text).`,
      {
        content: z.string().max(280).describe('The tweet content to post (max 280 characters)')
      },
      async (args: { content: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can post tweets.' }],
            isError: true
          };
        }

        if (args.content.length > 280) {
          return {
            content: [{ type: 'text', text: `Tweet exceeds 280 character limit (current: ${args.content.length})` }],
            isError: true
          };
        }

        try {
          const result = await sendWithTimeout(transport, 'x_post', { content: args.content }) as { success: boolean; message: string };
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `X post failed: ${err.message}` }],
            isError: true
          };
        }
      }
    ),

    tool(
      'x_like',
      `Like a tweet on X (Twitter). Main group only.

Provide the tweet URL or tweet ID to like.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        try {
          const result = await sendWithTimeout(transport, 'x_like', { tweetUrl: args.tweet_url }) as { success: boolean; message: string };
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `X like failed: ${err.message}` }],
            isError: true
          };
        }
      }
    ),

    tool(
      'x_reply',
      `Reply to a tweet on X (Twitter). Main group only.

Provide the tweet URL and your reply content.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
        content: z.string().max(280).describe('The reply content (max 280 characters)')
      },
      async (args: { tweet_url: string; content: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        try {
          const result = await sendWithTimeout(transport, 'x_reply', { tweetUrl: args.tweet_url, content: args.content }) as { success: boolean; message: string };
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `X reply failed: ${err.message}` }],
            isError: true
          };
        }
      }
    ),

    tool(
      'x_retweet',
      `Retweet a tweet on X (Twitter). Main group only.

Provide the tweet URL to retweet.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID')
      },
      async (args: { tweet_url: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        try {
          const result = await sendWithTimeout(transport, 'x_retweet', { tweetUrl: args.tweet_url }) as { success: boolean; message: string };
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `X retweet failed: ${err.message}` }],
            isError: true
          };
        }
      }
    ),

    tool(
      'x_quote',
      `Quote tweet on X (Twitter). Main group only.

Retweet with your own comment added.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
        comment: z.string().max(280).describe('Your comment for the quote tweet (max 280 characters)')
      },
      async (args: { tweet_url: string; comment: string }) => {
        if (!isMain) {
          return {
            content: [{ type: 'text', text: 'Only the main group can interact with X.' }],
            isError: true
          };
        }

        try {
          const result = await sendWithTimeout(transport, 'x_quote', { tweetUrl: args.tweet_url, comment: args.comment }) as { success: boolean; message: string };
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: `X quote failed: ${err.message}` }],
            isError: true
          };
        }
      }
    )
  ];
}
