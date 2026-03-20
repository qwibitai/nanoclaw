#!/usr/bin/env npx tsx
/**
 * X Integration - Scrape Tweet (API-based)
 *
 * Uses @the-convocation/twitter-scraper API instead of Playwright.
 *
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx tsx scrape-tweet.ts
 */

import { createScraper } from '../lib/scraper.js';
import { readInput, writeResult, extractTweetId, type ScriptResult } from '../lib/browser.js';

interface ScrapeInput {
  tweetUrl: string;
  includeReplies?: boolean;
  maxReplies?: number;
}

interface TweetData {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  metrics: {
    replies: string;
    reposts: string;
    likes: string;
    views: string;
    bookmarks: string;
  };
  replies: Array<{
    author: string;
    handle: string;
    content: string;
  }>;
  quotedTweet?: {
    author: string;
    content: string;
  };
}

async function scrapeTweet(input: ScrapeInput): Promise<ScriptResult> {
  const { tweetUrl, includeReplies = false, maxReplies = 10 } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return { success: false, message: `Invalid tweet URL or ID: ${tweetUrl}` };
  }

  const scraper = await createScraper();

  let tweet;
  try {
    tweet = await scraper.getTweet(tweetId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `X API error fetching tweet ${tweetId}: ${msg}` };
  }

  if (!tweet) {
    return { success: false, message: 'Tweet not found. It may have been deleted or the URL is invalid.' };
  }

  // Extract quoted tweet
  let quotedTweet: TweetData['quotedTweet'] | undefined;
  if (tweet.quotedStatus) {
    quotedTweet = {
      author: tweet.quotedStatus.name || tweet.quotedStatus.username || '',
      content: tweet.quotedStatus.text || '',
    };
  }

  // Extract replies from the tweet thread if requested
  const replies: TweetData['replies'] = [];
  if (includeReplies && tweet.thread.length > 0) {
    for (const reply of tweet.thread.slice(0, maxReplies)) {
      replies.push({
        author: reply.name || '',
        handle: reply.username ? `@${reply.username}` : '',
        content: reply.text || '',
      });
    }
  }

  const formatMetric = (n: number | undefined): string => {
    if (n === undefined) return '0';
    return String(n);
  };

  const tweetData: TweetData = {
    author: tweet.name || '',
    handle: tweet.username ? `@${tweet.username}` : '',
    content: tweet.text || '',
    timestamp: tweet.timeParsed?.toISOString() || '',
    metrics: {
      replies: formatMetric(tweet.replies),
      reposts: formatMetric(tweet.retweets),
      likes: formatMetric(tweet.likes),
      views: formatMetric(tweet.views),
      bookmarks: formatMetric(tweet.bookmarkCount),
    },
    replies,
    ...(quotedTweet ? { quotedTweet } : {}),
  };

  return {
    success: true,
    message: formatTweetOutput(tweetData),
    data: tweetData,
  };
}

function formatTweetOutput(tweet: TweetData): string {
  const lines: string[] = [];
  lines.push(`${tweet.author} (${tweet.handle})`);
  lines.push(tweet.content);
  lines.push(`Time: ${tweet.timestamp}`);
  lines.push(`Replies: ${tweet.metrics.replies} | Reposts: ${tweet.metrics.reposts} | Likes: ${tweet.metrics.likes} | Views: ${tweet.metrics.views}`);

  if (tweet.quotedTweet) {
    lines.push(`\nQuoting ${tweet.quotedTweet.author}:`);
    lines.push(tweet.quotedTweet.content);
  }

  if (tweet.replies.length > 0) {
    lines.push(`\n--- Replies (${tweet.replies.length}) ---`);
    for (const reply of tweet.replies) {
      lines.push(`\n${reply.author} (${reply.handle}):`);
      lines.push(reply.content);
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const input = await readInput<ScrapeInput>();
    const result = await scrapeTweet(input);
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
