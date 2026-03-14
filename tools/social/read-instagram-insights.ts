#!/usr/bin/env npx tsx
/**
 * Read Instagram Insights Tool for NanoClaw
 * Usage:
 *   npx tsx tools/social/read-instagram-insights.ts --post-ids "id1,id2,id3"
 *   npx tsx tools/social/read-instagram-insights.ts --account-summary true
 *   npx tsx tools/social/read-instagram-insights.ts --account-summary true --days 14
 *
 * Fetches engagement metrics for Instagram posts and account-level insights.
 * Uses Instagram Graph API via Facebook Graph API v21.0
 * Environment: IG_ACCESS_TOKEN or FB_PAGE_ACCESS_TOKEN, IG_ACCOUNT_ID (optional)
 */

import https from 'https';

interface InsightsArgs {
  'post-ids'?: string;
  'account-summary'?: string;
  'days'?: string;
}

interface PostMetrics {
  id: string;
  impressions?: number;
  reach?: number;
  engagement?: number;
  saved?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  error?: string;
}

interface AccountMetrics {
  period_days: number;
  impressions?: number;
  reach?: number;
  profile_views?: number;
  follower_count?: number;
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

  if (!result['post-ids'] && !result['account-summary']) {
    console.error('Usage: read-instagram-insights --post-ids "id1,id2,id3"');
    console.error('       read-instagram-insights --account-summary true [--days 7]');
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

function getAccessToken(): string {
  const token = process.env.IG_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing IG_ACCESS_TOKEN or FB_PAGE_ACCESS_TOKEN environment variable.',
    }));
    process.exit(1);
  }
  return token;
}

async function lookupAccountId(accessToken: string): Promise<string | null> {
  try {
    // Get pages the token has access to, then get the IG account linked to the first page
    const pagesUrl = `https://graph.facebook.com/v21.0/me/accounts?access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(pagesUrl);

    if (statusCode !== 200) return null;

    const parsed = JSON.parse(data);
    const pageId = parsed.data?.[0]?.id;
    if (!pageId) return null;

    const igUrl = `https://graph.facebook.com/v21.0/${pageId}?fields=instagram_business_account&access_token=${accessToken}`;
    const igRes = await httpsGet(igUrl);

    if (igRes.statusCode !== 200) return null;

    const igParsed = JSON.parse(igRes.data);
    return igParsed.instagram_business_account?.id || null;
  } catch {
    return null;
  }
}

async function fetchPostMetrics(mediaId: string, accessToken: string): Promise<PostMetrics> {
  const metrics: PostMetrics = { id: mediaId };

  // Fetch media insights
  try {
    const insightMetrics = 'impressions,reach,engagement,saved,likes,comments,shares';
    const url = `https://graph.facebook.com/v21.0/${mediaId}/insights?metric=${encodeURIComponent(insightMetrics)}&access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(url);

    if (statusCode === 200) {
      const parsed = JSON.parse(data);
      for (const entry of parsed.data || []) {
        const value = entry.values?.[0]?.value ?? entry.value ?? 0;
        switch (entry.name) {
          case 'impressions':
            metrics.impressions = value;
            break;
          case 'reach':
            metrics.reach = value;
            break;
          case 'engagement':
            metrics.engagement = value;
            break;
          case 'saved':
            metrics.saved = value;
            break;
          case 'likes':
            metrics.likes = value;
            break;
          case 'comments':
            metrics.comments = value;
            break;
          case 'shares':
            metrics.shares = value;
            break;
        }
      }
    } else {
      const parsed = JSON.parse(data);
      // Some metrics may not be available for all media types — try a reduced set
      if (parsed.error?.code === 100 || parsed.error?.error_subcode === 2108006) {
        return await fetchPostMetricsFallback(mediaId, accessToken, metrics);
      }
      metrics.error = parsed.error?.message || `HTTP ${statusCode}`;
      return metrics;
    }
  } catch (err) {
    metrics.error = err instanceof Error ? err.message : String(err);
    return metrics;
  }

  return metrics;
}

async function fetchPostMetricsFallback(mediaId: string, accessToken: string, metrics: PostMetrics): Promise<PostMetrics> {
  // Fallback: try only the universally available metrics
  try {
    const fallbackMetrics = 'impressions,reach';
    const url = `https://graph.facebook.com/v21.0/${mediaId}/insights?metric=${encodeURIComponent(fallbackMetrics)}&access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(url);

    if (statusCode === 200) {
      const parsed = JSON.parse(data);
      for (const entry of parsed.data || []) {
        const value = entry.values?.[0]?.value ?? entry.value ?? 0;
        if (entry.name === 'impressions') metrics.impressions = value;
        if (entry.name === 'reach') metrics.reach = value;
      }
    }
  } catch {
    // Graceful degradation — return whatever we have
  }

  // Also try to get basic engagement from the media object itself
  try {
    const url = `https://graph.facebook.com/v21.0/${mediaId}?fields=like_count,comments_count&access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(url);

    if (statusCode === 200) {
      const parsed = JSON.parse(data);
      if (parsed.like_count !== undefined) metrics.likes = parsed.like_count;
      if (parsed.comments_count !== undefined) metrics.comments = parsed.comments_count;
    }
  } catch {
    // Graceful degradation
  }

  return metrics;
}

async function fetchAccountInsights(accountId: string, accessToken: string, days: number): Promise<AccountMetrics> {
  const metrics: AccountMetrics = { period_days: days };

  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 86400);

  try {
    const insightMetrics = 'impressions,reach,profile_views,follower_count';
    const url = `https://graph.facebook.com/v21.0/${accountId}/insights?metric=${encodeURIComponent(insightMetrics)}&period=day&since=${since}&until=${now}&access_token=${accessToken}`;
    const { statusCode, data } = await httpsGet(url);

    if (statusCode === 200) {
      const parsed = JSON.parse(data);
      for (const entry of parsed.data || []) {
        // Sum daily values across the period
        const values = entry.values || [];
        const total = values.reduce((sum: number, v: { value: number }) => sum + (v.value || 0), 0);

        switch (entry.name) {
          case 'impressions':
            metrics.impressions = total;
            break;
          case 'reach':
            metrics.reach = total;
            break;
          case 'profile_views':
            metrics.profile_views = total;
            break;
          case 'follower_count':
            // follower_count is a snapshot, use the latest value
            metrics.follower_count = values.length > 0 ? values[values.length - 1].value : 0;
            break;
        }
      }
    } else {
      const parsed = JSON.parse(data);
      // Try reduced metric set if some aren't available
      if (parsed.error) {
        return await fetchAccountInsightsFallback(accountId, accessToken, days, metrics);
      }
      metrics.error = parsed.error?.message || `HTTP ${statusCode}`;
    }
  } catch (err) {
    metrics.error = err instanceof Error ? err.message : String(err);
  }

  return metrics;
}

async function fetchAccountInsightsFallback(accountId: string, accessToken: string, days: number, metrics: AccountMetrics): Promise<AccountMetrics> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - (days * 86400);

  // Try metrics one at a time to see which are available
  const metricNames = ['impressions', 'reach', 'profile_views', 'follower_count'];

  for (const metric of metricNames) {
    try {
      const url = `https://graph.facebook.com/v21.0/${accountId}/insights?metric=${metric}&period=day&since=${since}&until=${now}&access_token=${accessToken}`;
      const { statusCode, data } = await httpsGet(url);

      if (statusCode === 200) {
        const parsed = JSON.parse(data);
        const entry = parsed.data?.[0];
        if (entry) {
          const values = entry.values || [];
          if (metric === 'follower_count') {
            metrics.follower_count = values.length > 0 ? values[values.length - 1].value : 0;
          } else {
            const total = values.reduce((sum: number, v: { value: number }) => sum + (v.value || 0), 0);
            (metrics as Record<string, unknown>)[metric] = total;
          }
        }
      }
    } catch {
      // Skip unavailable metrics
    }
  }

  return metrics;
}

async function readInsights(args: InsightsArgs): Promise<void> {
  const accessToken = getAccessToken();

  if (args['post-ids']) {
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

  if (args['account-summary']) {
    const days = parseInt(args['days'] || '7', 10);

    let accountId = process.env.IG_ACCOUNT_ID;
    if (!accountId) {
      accountId = await lookupAccountId(accessToken) || undefined;
      if (!accountId) {
        console.error(JSON.stringify({
          status: 'error',
          error: 'Could not determine Instagram account ID. Set IG_ACCOUNT_ID environment variable.',
        }));
        process.exit(1);
      }
    }

    const account = await fetchAccountInsights(accountId, accessToken, days);
    console.log(JSON.stringify({ status: 'success', account }, null, 2));
  }
}

readInsights(parseArgs());
