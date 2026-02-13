/**
 * X Integration - MCP Tool Definitions (Container Side)
 *
 * This file is STANDALONE - no dependencies on the skill directory.
 * It gets copied to container/plugins/ during installation.
 *
 * These tools run inside the container and communicate with the host via IPC.
 * The host-side implementation handles the actual browser automation.
 */

// @ts-ignore SDK only available in container environment
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// ============================================================================
// Constants
// ============================================================================

const SKILL_NAME = 'x-integration';
const TWEET_MAX_LENGTH = 280;
const MAX_IMAGES = 4;

const POLL_CONFIG = {
  maxWaitMs: 60000,
  intervalMs: 1000,
};

// ============================================================================
// Types
// ============================================================================

/** Matches IpcMcpContext from ipc-mcp.ts */
export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export interface XToolsDeps {
  ctx: IpcMcpContext;
  dirs: {
    tasks: string;
    ipc: string;
  };
  writeIpcFile: (dir: string, data: object) => string;
}

// ============================================================================
// Response Handling (X-specific: needs to wait for host response)
// ============================================================================

interface HostResponse {
  success: boolean;
  message: string;
}

async function waitForHostResponse(resultsDir: string, requestId: string): Promise<HostResponse> {
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  let elapsed = 0;

  while (elapsed < POLL_CONFIG.maxWaitMs) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_CONFIG.intervalMs));
    elapsed += POLL_CONFIG.intervalMs;
  }

  return { success: false, message: 'Request timed out' };
}

// ============================================================================
// MCP Result Helpers
// ============================================================================

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function mcpError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toMcpResult(response: HostResponse): McpToolResult {
  return {
    content: [{ type: 'text', text: response.message }],
    isError: !response.success,
  };
}

// ============================================================================
// MCP Tool Registration
// ============================================================================

const NOT_MAIN_GROUP_ERROR = 'Only the main group can interact with X.';

/**
 * Create X integration MCP tools
 */
export function createXTools(deps: XToolsDeps) {
  const { ctx, dirs, writeIpcFile } = deps;
  const { groupFolder, isMain } = ctx;

  const resultsDir = path.join(dirs.ipc, `${SKILL_NAME}_results`);

  const requireMainGroup = () => (!isMain ? mcpError(NOT_MAIN_GROUP_ERROR) : null);

  const invokeHost = async (action: string, params: Record<string, unknown>): Promise<McpToolResult> => {
    const toolName = `${SKILL_NAME}_${action}`;
    const requestId = `${SKILL_NAME}-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(dirs.tasks, {
      type: toolName,
      requestId,
      ...params,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const response = await waitForHostResponse(resultsDir, requestId);
    return toMcpResult(response);
  };

  return [
    tool(
      `${SKILL_NAME}_post`,
      `Post a tweet to X (Twitter). Main group only.

The host machine will execute the browser automation to post the tweet.
Make sure the content is appropriate and within X's character limit (${TWEET_MAX_LENGTH} chars for text).
Optionally attach up to ${MAX_IMAGES} images from the container filesystem.`,
      {
        content: z.string().max(TWEET_MAX_LENGTH).describe(`The tweet content to post (max ${TWEET_MAX_LENGTH} characters)`),
        image_paths: z.array(z.string()).max(MAX_IMAGES).optional()
          .describe('Container image file paths array, max 4, e.g. ["/workspace/group/media/photo1.jpg"]'),
      },
      async (args: { content: string; image_paths?: string[] }) => {
        const guard = requireMainGroup();
        if (guard) return guard;

        if (args.content.length > TWEET_MAX_LENGTH) {
          return mcpError(`Tweet exceeds ${TWEET_MAX_LENGTH} character limit (current: ${args.content.length})`);
        }

        return invokeHost('post', {
          content: args.content,
          ...(args.image_paths ? { imagePaths: args.image_paths } : {}),
        });
      }
    ),

    tool(
      `${SKILL_NAME}_like`,
      `Like a tweet on X (Twitter). Main group only.

Provide the tweet URL or tweet ID to like.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
      },
      async (args: { tweet_url: string }) => {
        const guard = requireMainGroup();
        if (guard) return guard;

        return invokeHost('like', { tweetUrl: args.tweet_url });
      }
    ),

    tool(
      `${SKILL_NAME}_reply`,
      `Reply to a tweet on X (Twitter). Main group only.

Provide the tweet URL and your reply content. Optionally attach images.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
        content: z.string().max(TWEET_MAX_LENGTH).describe(`The reply content (max ${TWEET_MAX_LENGTH} characters)`),
        image_paths: z.array(z.string()).max(MAX_IMAGES).optional()
          .describe('Container image file paths array, max 4, e.g. ["/workspace/group/media/photo1.jpg"]'),
      },
      async (args: { tweet_url: string; content: string; image_paths?: string[] }) => {
        const guard = requireMainGroup();
        if (guard) return guard;

        return invokeHost('reply', {
          tweetUrl: args.tweet_url,
          content: args.content,
          ...(args.image_paths ? { imagePaths: args.image_paths } : {}),
        });
      }
    ),

    tool(
      `${SKILL_NAME}_retweet`,
      `Retweet a tweet on X (Twitter). Main group only.

Provide the tweet URL to retweet.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
      },
      async (args: { tweet_url: string }) => {
        const guard = requireMainGroup();
        if (guard) return guard;

        return invokeHost('retweet', { tweetUrl: args.tweet_url });
      }
    ),

    tool(
      `${SKILL_NAME}_quote`,
      `Quote tweet on X (Twitter). Main group only.

Retweet with your own comment added. Optionally attach images.`,
      {
        tweet_url: z.string().describe('The tweet URL (e.g., https://x.com/user/status/123) or tweet ID'),
        comment: z.string().max(TWEET_MAX_LENGTH).describe(`Your comment for the quote tweet (max ${TWEET_MAX_LENGTH} characters)`),
        image_paths: z.array(z.string()).max(MAX_IMAGES).optional()
          .describe('Container image file paths array, max 4, e.g. ["/workspace/group/media/photo1.jpg"]'),
      },
      async (args: { tweet_url: string; comment: string; image_paths?: string[] }) => {
        const guard = requireMainGroup();
        if (guard) return guard;

        return invokeHost('quote', {
          tweetUrl: args.tweet_url,
          comment: args.comment,
          ...(args.image_paths ? { imagePaths: args.image_paths } : {}),
        });
      }
    ),
  ];
}
