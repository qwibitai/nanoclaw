#!/usr/bin/env npx tsx
/**
 * X Integration - Scrape User Profile (API-based)
 *
 * Uses @the-convocation/twitter-scraper API instead of Playwright.
 *
 * Usage: echo '{"username":"elonmusk","maxTweets":10}' | npx tsx scrape-profile.ts
 */

import { createScraper } from '../lib/scraper.js';
import { readInput, writeResult, type ScriptResult } from '../lib/browser.js';

interface ProfileInput {
  username: string;
  maxTweets?: number;
}

interface ProfileTweet {
  author: string;
  handle: string;
  content: string;
  timestamp: string;
  isRetweet: boolean;
  isPinned: boolean;
}

interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  followersCount: string;
  followingCount: string;
  tweets: ProfileTweet[];
}

async function scrapeProfile(input: ProfileInput): Promise<ScriptResult> {
  const { username, maxTweets = 10 } = input;

  if (!username) {
    return { success: false, message: 'Please provide a username' };
  }

  const cleanUsername = username.replace(/^@/, '');
  const scraper = await createScraper();

  // Fetch profile
  let profile;
  try {
    profile = await scraper.getProfile(cleanUsername);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('suspended') || msg.includes('404')) {
      return { success: false, message: `Profile @${cleanUsername} not found or suspended` };
    }
    return { success: false, message: `X API error fetching profile @${cleanUsername}: ${msg}` };
  }

  if (!profile || !profile.username) {
    return { success: false, message: `Profile @${cleanUsername} not found or suspended` };
  }

  // Fetch tweets
  const tweets: ProfileTweet[] = [];
  const pinnedIds = new Set(profile.pinnedTweetIds || []);

  try {
    const generator = scraper.getTweets(cleanUsername, maxTweets);
    for await (const tweet of generator) {
      if (tweets.length >= maxTweets) break;

      const isRetweet = tweet.isRetweet === true;
      const actualTweet = isRetweet && tweet.retweetedStatus ? tweet.retweetedStatus : tweet;

      tweets.push({
        author: actualTweet.name || '',
        handle: actualTweet.username ? `@${actualTweet.username}` : '',
        content: actualTweet.text || '',
        timestamp: actualTweet.timeParsed?.toISOString() || '',
        isRetweet,
        isPinned: pinnedIds.has(tweet.id || ''),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('rate limit') || msg.includes('429')) {
      // Return profile data even if tweets failed
      if (tweets.length === 0) {
        return { success: false, message: `Rate limited while fetching tweets for @${cleanUsername}. Try again later.` };
      }
    } else {
      return { success: false, message: `X API error fetching tweets for @${cleanUsername}: ${msg}` };
    }
  }

  const formatCount = (n: number | undefined): string => {
    if (n === undefined) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const profileData: ProfileData = {
    username: cleanUsername,
    displayName: profile.name || '',
    bio: profile.biography || '',
    followersCount: formatCount(profile.followersCount),
    followingCount: formatCount(profile.followingCount),
    tweets,
  };

  return {
    success: true,
    message: formatProfileOutput(profileData),
    data: profileData,
  };
}

function formatProfileOutput(profile: ProfileData): string {
  const lines: string[] = [];
  lines.push(`${profile.displayName} (@${profile.username})`);
  lines.push(profile.bio);
  lines.push(`Following: ${profile.followingCount} | Followers: ${profile.followersCount}`);
  lines.push('');

  for (const tweet of profile.tweets) {
    const prefix = tweet.isPinned ? '[Pinned] ' : tweet.isRetweet ? `[RT ${tweet.handle}] ` : '';
    lines.push(`${prefix}${tweet.content}`);
    lines.push(`  ${tweet.timestamp}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const input = await readInput<ProfileInput>();
    const result = await scrapeProfile(input);
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
