/**
 * X API v2 - Shared utilities for reading tweets
 */

const X_API_BASE = 'https://api.x.com/2';

/** Fields to request for each tweet */
const TWEET_FIELDS = 'created_at,public_metrics,author_id,entities';
const USER_FIELDS = 'name,username,public_metrics';
const EXPANSIONS = 'author_id';

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    impression_count: number;
  };
}

export interface User {
  id: string;
  name: string;
  username: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
}

export interface SearchResponse {
  data?: Tweet[];
  includes?: { users?: User[] };
  meta?: { result_count: number; next_token?: string };
}

export interface UserLookupResponse {
  data?: { id: string; name: string; username: string };
  errors?: Array<{ title: string; detail: string }>;
}

export interface TimelineResponse {
  data?: Tweet[];
  meta?: { result_count: number; next_token?: string };
}

/**
 * Read input from stdin
 */
export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Write result to stdout (last line is parsed by host)
 */
export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

/**
 * Make an authenticated GET request to the X API v2
 */
export async function xApiGet<T>(endpoint: string, params: Record<string, string>, bearerToken: string): Promise<T> {
  const url = new URL(`${X_API_BASE}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`X API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Format a tweet for display
 */
export function formatTweet(tweet: Tweet, author?: User): string {
  const parts: string[] = [];

  const name = author ? `@${author.username} (${author.name})` : `user:${tweet.author_id}`;
  parts.push(`${name}`);

  if (tweet.created_at) {
    parts.push(`  ${new Date(tweet.created_at).toLocaleString()}`);
  }

  parts.push(`  ${tweet.text}`);

  if (tweet.public_metrics) {
    const m = tweet.public_metrics;
    const metrics = [];
    if (m.like_count > 0) metrics.push(`${m.like_count} likes`);
    if (m.retweet_count > 0) metrics.push(`${m.retweet_count} retweets`);
    if (m.reply_count > 0) metrics.push(`${m.reply_count} replies`);
    if (m.quote_count > 0) metrics.push(`${m.quote_count} quotes`);
    if (metrics.length > 0) parts.push(`  [${metrics.join(', ')}]`);
  }

  parts.push(`  https://x.com/i/status/${tweet.id}`);

  return parts.join('\n');
}

/**
 * Format a list of tweets with author resolution
 */
export function formatTweets(tweets: Tweet[], users?: User[]): string {
  const userMap = new Map<string, User>();
  if (users) {
    for (const user of users) {
      userMap.set(user.id, user);
    }
  }

  return tweets
    .map(tweet => formatTweet(tweet, tweet.author_id ? userMap.get(tweet.author_id) : undefined))
    .join('\n\n---\n\n');
}

/**
 * Common tweet fields query params
 */
export function tweetQueryParams(maxResults: number): Record<string, string> {
  return {
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    'expansions': EXPANSIONS,
    'max_results': String(Math.min(Math.max(maxResults, 10), 100)),
  };
}
