#!/usr/bin/env npx tsx
/**
 * X Integration - Search Tweets (API-based)
 *
 * Uses @the-convocation/twitter-scraper searchTweets API.
 * Accepts a search query to find relevant tweets.
 *
 * Usage: echo '{"query":"AI","maxTweets":20}' | npx tsx search-tweets.ts
 */

import { createScraper, SearchMode } from '../lib/scraper.js';
import { readInput, writeResult, type ScriptResult } from '../lib/browser.js';

interface TimelineInput {
  query?: string;
  maxTweets?: number;
  searchMode?: 'top' | 'latest';
}

interface TimelineTweet {
  id: string;
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  url: string;
  isRetweet: boolean;
  retweetedBy?: string;
  hasMedia: boolean;
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  quotedTweet?: {
    author: string;
    content: string;
  };
}

async function scrapeTimeline(input: TimelineInput): Promise<ScriptResult> {
  const { query, maxTweets = 20, searchMode = 'top' } = input;

  if (!query || query.trim().length === 0) {
    return { success: false, message: 'Please provide a search query. Example: {"query":"AI","maxTweets":20}' };
  }

  const scraper = await createScraper();

  const mode = searchMode === 'latest' ? SearchMode.Latest : SearchMode.Top;
  const tweets: TimelineTweet[] = [];

  try {
    const generator = scraper.searchTweets(query, maxTweets, mode);

    for await (const tweet of generator) {
      if (tweets.length >= maxTweets) break;

      const isRetweet = tweet.isRetweet === true;
      const retweetedBy = isRetweet && tweet.retweetedStatus
        ? tweet.username || undefined
        : undefined;
      const actualTweet = isRetweet && tweet.retweetedStatus ? tweet.retweetedStatus : tweet;

      let quotedTweet: TimelineTweet['quotedTweet'] | undefined;
      if (actualTweet.quotedStatus) {
        quotedTweet = {
          author: actualTweet.quotedStatus.name || actualTweet.quotedStatus.username || '',
          content: actualTweet.quotedStatus.text || '',
        };
      }

      const hasMedia = (actualTweet.photos?.length ?? 0) > 0 || (actualTweet.videos?.length ?? 0) > 0;

      tweets.push({
        id: actualTweet.id || '',
        author: actualTweet.name || '',
        handle: actualTweet.username ? `@${actualTweet.username}` : '',
        content: actualTweet.text || '',
        timestamp: actualTweet.timeParsed?.toISOString() || '',
        url: actualTweet.permanentUrl || '',
        isRetweet,
        ...(retweetedBy ? { retweetedBy } : {}),
        hasMedia,
        likes: actualTweet.likes ?? 0,
        retweets: actualTweet.retweets ?? 0,
        replies: actualTweet.replies ?? 0,
        views: actualTweet.views ?? 0,
        ...(quotedTweet ? { quotedTweet } : {}),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (msg.includes('rate limit') || msg.includes('429')) {
      return { success: false, message: `Rate limited by X. Try again in a few minutes. Error: ${msg}` };
    }
    // Return error as result instead of crashing -- lets the agent handle
    // the failure gracefully (retry, skip, or use an alternative).
    return {
      success: false,
      message: `X API error during search: ${msg}${stack ? `\n${stack}` : ''}`,
    };
  }

  if (tweets.length === 0) {
    return { success: false, message: `No tweets found for query "${query}". Try a different search term.` };
  }

  return {
    success: true,
    message: formatTimelineOutput(query, tweets),
    data: tweets,
  };
}

function formatTimelineOutput(query: string, tweets: TimelineTweet[]): string {
  const lines: string[] = [];
  lines.push(`Search results for "${query}" (${tweets.length} tweets)`);
  lines.push('');

  for (const tweet of tweets) {
    const prefix = tweet.isRetweet && tweet.retweetedBy
      ? `[RT by @${tweet.retweetedBy}] `
      : '';
    const media = tweet.hasMedia ? ' [media]' : '';
    const metrics = `${tweet.likes}L ${tweet.retweets}RT ${tweet.views}V`;
    lines.push(`${prefix}${tweet.author} (${tweet.handle})${media} [${metrics}]`);
    lines.push(tweet.content);
    if (tweet.quotedTweet) {
      lines.push(`  > Quoting ${tweet.quotedTweet.author}: ${tweet.quotedTweet.content}`);
    }
    lines.push(`  ${tweet.timestamp} | ${tweet.url}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const input = await readInput<TimelineInput>();
    const result = await scrapeTimeline(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exitCode = 1;
  }
}

main();
