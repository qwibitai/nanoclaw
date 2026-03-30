// container/skills/x-integration/tools.ts
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import {
  postTweet,
  replyToTweet,
  quoteTweet,
  likeTweet,
  retweet,
  searchRecent,
  getHomeTimeline,
} from './actions.js';
import { XMonitor } from './monitor.js';
import { runMonitorCycle } from '../social-monitor/framework.js';
import type { MonitorContext, EngagementLogEntry } from '../social-monitor/interfaces.js';

const TASKS_DIR = '/workspace/ipc/tasks';
const IPC_DIR = '/workspace/ipc';
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const IS_MAIN = process.env.NANOCLAW_IS_MAIN === 'true';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function mainOnly(): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (!IS_MAIN) {
    return {
      content: [{ type: 'text', text: 'Only the main group can use X integration.' }],
      isError: true,
    };
  }
  return null;
}

export function createXTools(server: any) {
  server.tool(
    'x_post',
    'Post a tweet to X. Requires approval per policy.',
    { content: z.string().max(280).describe('Tweet text (max 280 chars)') },
    async (args: { content: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const result = await postTweet(args.content);
        return { content: [{ type: 'text' as const, text: result.url || 'Tweet posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_like',
    'Like a tweet on X.',
    { tweet_url: z.string().describe('Tweet URL or ID') },
    async (args: { tweet_url: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        await likeTweet(tweetId);
        return { content: [{ type: 'text' as const, text: `Liked tweet ${tweetId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_reply',
    'Reply to a tweet on X. Requires approval per policy.',
    {
      tweet_url: z.string().describe('Tweet URL or ID'),
      content: z.string().max(280).describe('Reply text (max 280 chars)'),
    },
    async (args: { tweet_url: string; content: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        const result = await replyToTweet(tweetId, args.content);
        return { content: [{ type: 'text' as const, text: result.url || 'Reply posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet on X.',
    { tweet_url: z.string().describe('Tweet URL or ID') },
    async (args: { tweet_url: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        await retweet(tweetId);
        return { content: [{ type: 'text' as const, text: `Retweeted ${tweetId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_quote',
    'Quote tweet on X with your own commentary. Requires approval per policy.',
    {
      tweet_url: z.string().describe('Tweet URL or ID'),
      comment: z.string().max(280).describe('Your commentary (max 280 chars)'),
    },
    async (args: { tweet_url: string; comment: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        const result = await quoteTweet(tweetId, args.comment);
        return { content: [{ type: 'text' as const, text: result.url || 'Quote posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_search',
    'Search recent tweets on X (last 7 days).',
    {
      query: z.string().describe('Search query'),
      max_results: z.number().min(10).max(100).default(10).optional(),
    },
    async (args: { query: string; max_results?: number }) => {
      try {
        const results = await searchRecent(args.query, args.max_results ?? 10);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_timeline',
    'Fetch your home timeline from X.',
    { max_results: z.number().min(10).max(100).default(50).optional() },
    async (args: { max_results?: number }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const results = await getHomeTimeline(args.max_results ?? 50);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_setup',
    'Bootstrap your X persona from account history. Analyzes recent tweets and likes to generate an x-persona.md draft for review.',
    {},
    async () => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const monitor = new XMonitor();
        const ctx: MonitorContext = {
          groupFolder: GROUP_FOLDER,
          personaPath: '/workspace/group/x-persona.md',
          approvalPolicyPath: '/workspace/group/approval-policy.json',
          dryRun: false,
        };
        const draft = await monitor.bootstrapPersona!(ctx);
        return {
          content: [{
            type: 'text' as const,
            text: `Persona bootstrap data collected. ${draft.sourceStats.postsAnalyzed} tweets and ${draft.sourceStats.likesAnalyzed} likes analyzed (${draft.sourceStats.dateRange.from} to ${draft.sourceStats.dateRange.to}).\n\nUse the analysis below to generate the x-persona.md file and save it to /workspace/group/x-persona.md. The user should review and edit it.\n\n${draft.content}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );
}

function extractTweetId(urlOrId: string): string {
  const match = urlOrId.match(/status\/(\d+)/);
  return match ? match[1] : urlOrId;
}
