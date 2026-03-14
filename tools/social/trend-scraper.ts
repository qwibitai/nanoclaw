#!/usr/bin/env npx tsx
/**
 * Trend Scraper Tool for NanoClaw
 *
 * Scrapes and analyzes trending social media content patterns relevant to
 * vending, coffee, and workplace amenities.
 *
 * Usage:
 *   npx tsx tools/social/trend-scraper.ts scan --platform linkedin [--query "office coffee"] [--limit 20]
 *   npx tsx tools/social/trend-scraper.ts scan --platform twitter [--query "vending machine"] [--limit 20]
 *   npx tsx tools/social/trend-scraper.ts scan --platform facebook --query "<page_id>" [--limit 10]
 *   npx tsx tools/social/trend-scraper.ts analyze
 *   npx tsx tools/social/trend-scraper.ts patterns
 *
 * Environment: TWITTER_BEARER_TOKEN (for Twitter/X scanning)
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────

type HookType = 'question' | 'stat-lead' | 'story' | 'controversial' | 'how-to' | 'list' | 'pov';
type FormatType = 'thread' | 'single' | 'poll' | 'carousel' | 'video-link';

interface TrendingContent {
  id: string;
  platform: string;
  author: string;
  content_text: string;
  url: string;
  likes: number;
  shares: number;
  comments: number;
  scraped_at: string;
  tags: string;
  hook_type: HookType;
  format_type: FormatType;
}

interface Args {
  action: string;
  platform?: string;
  query?: string;
  limit: number;
}

// ── Arg Parsing ────────────────────────────────────────────────────────

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0];

  if (!['scan', 'analyze', 'patterns'].includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: scan, analyze, patterns`,
      usage: [
        'npx tsx tools/social/trend-scraper.ts scan --platform linkedin [--query "office coffee"] [--limit 20]',
        'npx tsx tools/social/trend-scraper.ts scan --platform twitter [--query "vending machine"] [--limit 20]',
        'npx tsx tools/social/trend-scraper.ts analyze',
        'npx tsx tools/social/trend-scraper.ts patterns',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    platform: flags.platform,
    query: flags.query,
    limit: parseInt(flags.limit || '20', 10),
  };
}

// ── Database ───────────────────────────────────────────────────────────

function getDb(): Database.Database {
  const dbPath = path.join(process.cwd(), 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ status: 'error', error: 'Database not found. Run NanoClaw first.' }));
    process.exit(1);
  }
  const db = new Database(dbPath);
  initTable(db);
  return db;
}

function initTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trending_content (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      content_text TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      likes INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0,
      comments INTEGER NOT NULL DEFAULT 0,
      scraped_at TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      hook_type TEXT NOT NULL DEFAULT 'story',
      format_type TEXT NOT NULL DEFAULT 'single'
    )
  `);
}

// ── Classification Heuristics ──────────────────────────────────────────

function classifyHookType(text: string): HookType {
  const trimmed = text.trim();
  const firstSentence = trimmed.split(/[.!?\n]/)[0] || '';

  // Starts with a number or percentage → stat-lead
  if (/^\d/.test(trimmed) || /^\d+%/.test(trimmed)) return 'stat-lead';

  // Starts with "?" or first sentence contains "?"
  if (trimmed.startsWith('?') || firstSentence.includes('?')) return 'question';

  // POV or Imagine
  if (/^(POV:|Imagine:)/i.test(trimmed)) return 'pov';

  // Contains numbered list (1. 2. 3. or 1) 2) 3))
  if (/\n\s*[1-9][.)]\s/m.test(trimmed)) return 'list';

  // How to / How I
  if (/^How (to|I|we)/i.test(trimmed)) return 'how-to';

  // Controversial
  if (/unpopular opinion|hot take|controversial/i.test(trimmed)) return 'controversial';

  // Default
  return 'story';
}

function classifyFormatType(text: string, platform: string): FormatType {
  // Thread detection: numbered tweets or "thread" mention or 🧵
  if (/\bthread\b/i.test(text) || text.includes('\u{1F9F5}') || /\n\s*\d+[./)]\s/m.test(text)) return 'thread';

  // Poll detection
  if (/\bpoll\b/i.test(text) || /\bvote\b/i.test(text) || text.includes('\u2B07\uFE0F')) return 'poll';

  // Video link
  if (/youtu\.?be|vimeo|loom\.com|\.mp4/i.test(text)) return 'video-link';

  // Carousel detection (LinkedIn/Facebook typically)
  if (/\bcarousel\b/i.test(text) || /\bslide\b/i.test(text) || /swipe/i.test(text)) return 'carousel';

  return 'single';
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const hashtags = text.match(/#[a-zA-Z]\w*/g);
  if (hashtags) {
    tags.push(...hashtags.slice(0, 10).map((t) => t.toLowerCase()));
  }
  return tags;
}

// ── Twitter/X Scanning ────────────────────────────────────────────────

async function scanTwitter(query: string, limit: number): Promise<TrendingContent[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing TWITTER_BEARER_TOKEN env var.',
    }));
    process.exit(1);
  }

  const searchQuery = `${query} min_faves:50`;
  const maxResults = Math.min(Math.max(limit, 10), 100); // API requires 10-100
  const params = new URLSearchParams({
    query: searchQuery,
    'tweet.fields': 'public_metrics,created_at,author_id',
    max_results: maxResults.toString(),
  });

  const url = `https://api.twitter.com/2/tweets/search/recent?${params}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Twitter API ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      data?: Array<{
        id: string;
        text: string;
        author_id?: string;
        created_at?: string;
        public_metrics?: {
          like_count: number;
          retweet_count: number;
          reply_count: number;
          quote_count: number;
        };
      }>;
      meta?: { result_count: number };
    };

    if (!data.data || data.data.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    return data.data.map((tweet) => ({
      id: crypto.randomUUID(),
      platform: 'twitter',
      author: tweet.author_id || '',
      content_text: tweet.text,
      url: `https://twitter.com/i/status/${tweet.id}`,
      likes: tweet.public_metrics?.like_count || 0,
      shares: (tweet.public_metrics?.retweet_count || 0) + (tweet.public_metrics?.quote_count || 0),
      comments: tweet.public_metrics?.reply_count || 0,
      scraped_at: now,
      tags: extractTags(tweet.text).join(','),
      hook_type: classifyHookType(tweet.text),
      format_type: classifyFormatType(tweet.text, 'twitter'),
    }));
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── LinkedIn Scanning ─────────────────────────────────────────────────

async function scanLinkedIn(query: string, limit: number): Promise<TrendingContent[]> {
  // LinkedIn has no public search API. We scrape Google for LinkedIn posts.
  const searchUrl = `https://www.google.com/search?q=site:linkedin.com/posts+${encodeURIComponent(query)}&num=${Math.min(limit, 20)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(searchUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Google search returned ${res.status}`);
    }

    const html = await res.text();

    // Extract LinkedIn post URLs and snippets from Google results
    const results: TrendingContent[] = [];
    const now = new Date().toISOString();

    // Match Google result blocks — look for LinkedIn post URLs and nearby text
    const urlRegex = /https:\/\/www\.linkedin\.com\/posts\/[^"&\s<]+/g;
    const urls = Array.from(new Set(html.match(urlRegex) || []));

    // Extract snippets near each URL
    for (const postUrl of urls.slice(0, limit)) {
      // Try to find a snippet near this URL in the HTML
      const urlIndex = html.indexOf(postUrl);
      if (urlIndex === -1) continue;

      // Grab surrounding text and strip HTML tags for a rough snippet
      const contextWindow = html.slice(Math.max(0, urlIndex - 500), urlIndex + 1000);
      const snippetMatches = contextWindow.match(/<span[^>]*class="[^"]*"[^>]*>([^<]{20,300})<\/span>/g);
      let snippet = '';
      if (snippetMatches && snippetMatches.length > 0) {
        // Take the longest snippet as the content
        snippet = snippetMatches
          .map((s) => s.replace(/<[^>]+>/g, '').trim())
          .sort((a, b) => b.length - a.length)[0] || '';
      }

      if (!snippet) {
        // Fallback: strip all tags from the context window and take a chunk
        const plainText = contextWindow.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        snippet = plainText.slice(0, 200);
      }

      // Extract author from URL (linkedin.com/posts/author-name_...)
      const authorMatch = postUrl.match(/linkedin\.com\/posts\/([^_/]+)/);
      const author = authorMatch ? authorMatch[1].replace(/-/g, ' ') : '';

      results.push({
        id: crypto.randomUUID(),
        platform: 'linkedin',
        author,
        content_text: snippet,
        url: postUrl.split('?')[0], // clean tracking params
        likes: 0, // not available from Google results
        shares: 0,
        comments: 0,
        scraped_at: now,
        tags: extractTags(snippet).join(','),
        hook_type: classifyHookType(snippet),
        format_type: classifyFormatType(snippet, 'linkedin'),
      });
    }

    return results;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Facebook Page Scanning ───────────────────────────────────────────

async function scanFacebook(pageId: string, limit: number): Promise<TrendingContent[]> {
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!accessToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing FB_PAGE_ACCESS_TOKEN env var (needed to read public page posts).',
    }));
    process.exit(1);
  }

  const fields = 'message,shares,reactions.summary(true),comments.summary(true),created_time,permalink_url';
  const params = new URLSearchParams({
    fields,
    limit: Math.min(limit, 100).toString(),
    access_token: accessToken,
  });

  const url = `https://graph.facebook.com/v21.0/${pageId}/posts?${params}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Facebook API ${res.status}: ${body}`);
    }

    const data = await res.json() as {
      data?: Array<{
        id: string;
        message?: string;
        shares?: { count: number };
        reactions?: { summary: { total_count: number } };
        comments?: { summary: { total_count: number } };
        created_time?: string;
        permalink_url?: string;
      }>;
    };

    if (!data.data || data.data.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    return data.data
      .filter((post) => post.message) // skip posts without text
      .map((post) => ({
        id: crypto.randomUUID(),
        platform: 'facebook',
        author: pageId,
        content_text: post.message || '',
        url: post.permalink_url || `https://facebook.com/${post.id}`,
        likes: post.reactions?.summary?.total_count || 0,
        shares: post.shares?.count || 0,
        comments: post.comments?.summary?.total_count || 0,
        scraped_at: now,
        tags: extractTags(post.message || '').join(','),
        hook_type: classifyHookType(post.message || ''),
        format_type: classifyFormatType(post.message || '', 'facebook'),
      }));
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Scan Action ───────────────────────────────────────────────────────

async function scan(platform: string, query: string, limit: number): Promise<void> {
  let results: TrendingContent[];

  switch (platform) {
    case 'twitter':
    case 'x':
      results = await scanTwitter(query, limit);
      break;
    case 'linkedin':
      results = await scanLinkedIn(query, limit);
      break;
    case 'facebook':
    case 'fb':
      results = await scanFacebook(query, limit);
      break;
    default:
      console.error(JSON.stringify({
        status: 'error',
        error: `Unsupported platform "${platform}". Use: twitter, linkedin, facebook`,
      }));
      process.exit(1);
  }

  // Store results in DB
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO trending_content
      (id, platform, author, content_text, url, likes, shares, comments, scraped_at, tags, hook_type, format_type)
    VALUES
      (@id, @platform, @author, @content_text, @url, @likes, @shares, @comments, @scraped_at, @tags, @hook_type, @format_type)
  `);

  const insertMany = db.transaction((items: TrendingContent[]) => {
    for (const item of items) insert.run(item);
  });

  insertMany(results);
  db.close();

  console.log(JSON.stringify({
    status: 'success',
    action: 'scan',
    platform,
    query,
    found: results.length,
    hook_types: countBy(results as unknown as Array<Record<string, unknown>>, 'hook_type'),
    format_types: countBy(results as unknown as Array<Record<string, unknown>>, 'format_type'),
    sample: results.slice(0, 3).map((r) => ({
      author: r.author,
      hook_type: r.hook_type,
      format_type: r.format_type,
      snippet: r.content_text.slice(0, 120),
      url: r.url,
    })),
  }));
}

function countBy(items: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const val = String(item[key]);
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

// ── Analyze Action ────────────────────────────────────────────────────

function analyze(): void {
  const db = getDb();

  // Total content count
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM trending_content').get() as { cnt: number }).cnt;

  if (total === 0) {
    db.close();
    console.log(JSON.stringify({
      status: 'success',
      action: 'analyze',
      message: 'No trending content in database. Run scan first.',
    }));
    return;
  }

  // Top hook types by average engagement
  const hookStats = db.prepare(`
    SELECT hook_type,
           COUNT(*) as count,
           ROUND(AVG(likes + shares + comments), 1) as avg_engagement,
           ROUND(AVG(likes), 1) as avg_likes,
           ROUND(AVG(shares), 1) as avg_shares,
           ROUND(AVG(comments), 1) as avg_comments
    FROM trending_content
    GROUP BY hook_type
    ORDER BY avg_engagement DESC
  `).all();

  // Top format types by average engagement
  const formatStats = db.prepare(`
    SELECT format_type,
           COUNT(*) as count,
           ROUND(AVG(likes + shares + comments), 1) as avg_engagement,
           ROUND(AVG(likes), 1) as avg_likes,
           ROUND(AVG(shares), 1) as avg_shares
    FROM trending_content
    GROUP BY format_type
    ORDER BY avg_engagement DESC
  `).all();

  // Platform breakdown
  const platformStats = db.prepare(`
    SELECT platform,
           COUNT(*) as count,
           ROUND(AVG(likes + shares + comments), 1) as avg_engagement
    FROM trending_content
    GROUP BY platform
    ORDER BY avg_engagement DESC
  `).all();

  // Common tags in high-engagement posts (top quartile)
  const topPosts = db.prepare(`
    SELECT tags FROM trending_content
    WHERE (likes + shares + comments) > 0
    ORDER BY (likes + shares + comments) DESC
    LIMIT ?
  `).all(Math.max(Math.floor(total / 4), 5)) as Array<{ tags: string }>;

  const tagCounts: Record<string, number> = {};
  for (const row of topPosts) {
    if (!row.tags) continue;
    for (const tag of row.tags.split(',')) {
      const t = tag.trim();
      if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));

  // Best posting times (hour-of-day from scraped_at as proxy)
  const timeStats = db.prepare(`
    SELECT
      CAST(strftime('%H', scraped_at) AS INTEGER) as hour,
      ROUND(AVG(likes + shares + comments), 1) as avg_engagement,
      COUNT(*) as count
    FROM trending_content
    WHERE scraped_at IS NOT NULL
    GROUP BY hour
    HAVING count >= 2
    ORDER BY avg_engagement DESC
    LIMIT 5
  `).all();

  // Recent scan dates
  const lastScan = db.prepare(
    'SELECT scraped_at FROM trending_content ORDER BY scraped_at DESC LIMIT 1',
  ).get() as { scraped_at: string } | undefined;

  db.close();

  console.log(JSON.stringify({
    status: 'success',
    action: 'analyze',
    total_content: total,
    last_scan: lastScan?.scraped_at || null,
    hook_type_performance: hookStats,
    format_type_performance: formatStats,
    platform_breakdown: platformStats,
    top_tags_in_viral_content: topTags,
    best_posting_hours: timeStats,
  }, null, 2));
}

// ── Patterns Action ───────────────────────────────────────────────────

function patterns(): void {
  const patternsPath = path.join(process.cwd(), 'groups', 'main', 'viral-patterns.md');

  if (!fs.existsSync(patternsPath)) {
    // Create starter template
    const template = `# Viral Content Patterns — SNAK Group

Last updated: (auto-updated by Andy)

## Top Performing Hook Types
- **Stat-lead**: Posts that open with a surprising statistic consistently get 2-3x engagement
- **POV/Story**: First-person narratives about workplace experiences resonate well
- **How-to/List**: Practical tips in list format get high saves and shares

## Content Formats That Work
- **Before/After**: Breakroom transformation photos are highly shareable
- **Thread/Carousel**: Multi-part stories perform well on LinkedIn
- **Poll**: Simple workplace questions drive comments

## SNAK Group Content Angles
- Employee satisfaction and retention through amenities
- Cost savings vs. external coffee shops
- Technology in vending (app-based, cashless)
- Breakroom as a culture driver
- Health and wellness (fresh options, filtered ice)
- Sustainability (less single-use from outside vendors)

## Engagement Triggers
- Ask a question at the end of every post
- Use "This or That" comparisons
- Share specific numbers (not vague claims)
- Tag relevant locations/companies when appropriate

## Posting Best Practices
- LinkedIn: Post between 8-10 AM, Tuesday-Thursday
- Twitter/X: Post between 9 AM-12 PM and 5-6 PM
- Facebook: Post between 1-4 PM
- Use 3-5 hashtags on LinkedIn, 2-3 on Twitter
- Include images whenever possible — 2x engagement vs text-only

## Formats to Experiment With
- Time-lapse of machine installation
- "Day in the life" of a vending route
- Employee reaction videos
- Side-by-side cost comparison infographics
- "Guess the flavor" engagement posts
`;
    fs.mkdirSync(path.dirname(patternsPath), { recursive: true });
    fs.writeFileSync(patternsPath, template, 'utf-8');
    console.log(JSON.stringify({
      status: 'success',
      action: 'patterns',
      message: 'Created starter viral-patterns.md',
      path: patternsPath,
    }));
  } else {
    const content = fs.readFileSync(patternsPath, 'utf-8');
    console.log(JSON.stringify({
      status: 'success',
      action: 'patterns',
      path: patternsPath,
      content,
    }));
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  try {
    switch (args.action) {
      case 'scan':
        if (!args.platform) {
          console.error(JSON.stringify({ status: 'error', error: 'scan requires --platform (twitter, linkedin, facebook)' }));
          process.exit(1);
        }
        await scan(args.platform, args.query || 'vending machine', args.limit);
        break;

      case 'analyze':
        analyze();
        break;

      case 'patterns':
        patterns();
        break;
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
