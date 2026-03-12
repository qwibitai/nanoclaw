#!/usr/bin/env npx tsx
/**
 * Read Facebook Post Insights Tool for NanoClaw
 * Usage: npx tsx tools/social/read-facebook-insights.ts --post-ids "id1,id2,id3"
 *
 * Fetches engagement metrics for published Facebook posts.
 * Uses Facebook Graph API v21.0
 * Environment: FB_PAGE_ACCESS_TOKEN
 */

import https from 'https';

interface InsightsArgs {
  'post-ids': string;
}

interface PostMetrics {
  post_id: string;
  reactions: number;
  comments: number;
  shares: number;
  reach?: number;
  impressions?: number;
  engaged_users?: number;
  clicks?: number;
  error?: string;
}

function parseArgs(): InsightsArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  if (!result['post-ids']) {
    console.error('Usage: read-facebook-insights --post-ids "id1,id2,id3"');
    process.exit(1);
  }

  return result as unknown as InsightsArgs;
}

function httpsGet(url: string): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, data }));
    }).on('error', reject);
  });
}

async function fetchPostMetrics(postId: string, accessToken: string): Promise<PostMetrics> {
  const metrics: PostMetrics = {
    post_id: postId,
    reactions: 0,
    comments: 0,
    shares: 0,
  };

  // Fetch object-level engagement (works with pages_read_engagement permission)
  try {
    const fields = 'shares,comments.summary(true),reactions.summary(true)';
    const url = `https://graph.facebook.com/v21.0/${postId}?fields=${encodeURIComponent(fields)}&access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(url);

    if (statusCode === 200) {
      const parsed = JSON.parse(data);
      metrics.reactions = parsed.reactions?.summary?.total_count || 0;
      metrics.comments = parsed.comments?.summary?.total_count || 0;
      metrics.shares = parsed.shares?.count || 0;
    } else {
      const parsed = JSON.parse(data);
      metrics.error = parsed.error?.message || `HTTP ${statusCode}`;
      return metrics;
    }
  } catch (err) {
    metrics.error = err instanceof Error ? err.message : String(err);
    return metrics;
  }

  // Try to fetch page-level insights (requires read_insights permission — may fail gracefully)
  try {
    const insightMetrics = 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks';
    const url = `https://graph.facebook.com/v21.0/${postId}/insights?metric=${encodeURIComponent(insightMetrics)}&access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(url);

    if (statusCode === 200) {
      const parsed = JSON.parse(data);
      for (const entry of parsed.data || []) {
        const value = entry.values?.[0]?.value || 0;
        switch (entry.name) {
          case 'post_impressions':
            metrics.impressions = value;
            break;
          case 'post_impressions_unique':
            metrics.reach = value;
            break;
          case 'post_engaged_users':
            metrics.engaged_users = value;
            break;
          case 'post_clicks':
            metrics.clicks = value;
            break;
        }
      }
    }
    // If insights fail (no permission), we still have object-level metrics — that's fine
  } catch {
    // Graceful degradation — object-level metrics are sufficient
  }

  return metrics;
}

async function readInsights(args: InsightsArgs): Promise<void> {
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!accessToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing FB_PAGE_ACCESS_TOKEN environment variable.',
    }));
    process.exit(1);
  }

  const postIds = args['post-ids'].split(',').map(id => id.trim()).filter(Boolean);

  if (postIds.length === 0) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'No valid post IDs provided.',
    }));
    process.exit(1);
  }

  const posts: PostMetrics[] = [];
  for (const postId of postIds) {
    const metrics = await fetchPostMetrics(postId, accessToken);
    posts.push(metrics);
  }

  console.log(JSON.stringify({ status: 'success', posts }, null, 2));
}

readInsights(parseArgs());
