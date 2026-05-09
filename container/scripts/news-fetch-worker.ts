/**
 * Pre-task news fetcher worker.
 *
 * Fetches RSS/Atom feeds in parallel, filters to a recency window, and
 * prints a single JSON line to stdout (task-script.ts last-line protocol).
 *
 * Runs inside the agent container via `bun /app/scripts/news-fetch-worker.ts`.
 */
import { existsSync, readFileSync } from 'fs';

const CONFIG_PATH = process.env.NEWS_SOURCES_PATH ?? '/workspace/agent/news-sources.json';
const DEFAULT_MAX_ITEMS_PER_SOURCE = 15;
const DEFAULT_TOTAL_BUDGET = 30000;
const DEFAULT_WINDOW_HOURS = 24;
const FETCH_TIMEOUT_MS = 8000;
const MAX_SUMMARY_CHARS = 400;

interface Source {
  url: string;
  label?: string;
}

interface Config {
  sources: Source[];
  maxItemsPerSource: number;
  totalBudget: number;
  windowHours: number;
}

interface Item {
  title: string;
  link?: string;
  pubDate: string;
  summary?: string;
}

interface SourceResult {
  label: string;
  url: string;
  items?: Item[];
  itemCount?: number;
  error?: string;
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return {
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      maxItemsPerSource: raw.maxItemsPerSource || DEFAULT_MAX_ITEMS_PER_SOURCE,
      totalBudget: raw.totalBudget || DEFAULT_TOTAL_BUDGET,
      windowHours: raw.windowHours || DEFAULT_WINDOW_HOURS,
    };
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : undefined;
}

function parseFeed(text: string): Item[] | null {
  if (!/<rss\b|<feed\b/i.test(text.slice(0, 500))) return null;

  const items: Item[] = [];
  const itemRegex = /<(item|entry)\b[\s\S]*?<\/\1>/gi;

  for (const match of text.matchAll(itemRegex)) {
    const block = match[0];
    const titleRaw = extractTag(block, 'title');
    if (!titleRaw) continue;

    let link = extractTag(block, 'link');
    if (!link) {
      const atomLink = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      link = atomLink?.[1];
    }

    const dateStr =
      extractTag(block, 'pubDate') ??
      extractTag(block, 'published') ??
      extractTag(block, 'updated') ??
      extractTag(block, 'dc:date');
    let pubDate = '';
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) pubDate = d.toISOString();
    }

    const desc =
      extractTag(block, 'description') ??
      extractTag(block, 'summary') ??
      extractTag(block, 'content');
    const summary = desc ? stripHtml(desc).slice(0, MAX_SUMMARY_CHARS) : undefined;

    items.push({
      title: stripHtml(titleRaw),
      link: link ? stripHtml(link) : undefined,
      pubDate,
      summary,
    });
  }

  return items;
}

async function fetchSource(
  source: Source,
  windowHours: number,
  maxItems: number,
): Promise<SourceResult> {
  const label = source.label || source.url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'NanoClaw-NewsFetcher/2.0' },
    });
    clearTimeout(timer);

    if (!res.ok) return { label, url: source.url, error: `HTTP ${res.status}` };

    const text = await res.text();
    const parsed = parseFeed(text);
    if (!parsed) return { label, url: source.url, error: 'not RSS/Atom' };

    const cutoff = Date.now() - windowHours * 3600 * 1000;
    const recent = parsed
      .filter((i) => i.pubDate && new Date(i.pubDate).getTime() >= cutoff)
      .slice(0, maxItems);

    return { label, url: source.url, items: recent, itemCount: recent.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label, url: source.url, error: msg.slice(0, 100) };
  }
}

async function main() {
  const config = loadConfig();
  if (!config || config.sources.length === 0) {
    const note = !config
      ? 'no news-sources.json found — use normal web search'
      : 'no sources configured';
    process.stdout.write(JSON.stringify({ wakeAgent: true, data: { sources: [], note } }));
    return;
  }

  const results = await Promise.all(
    config.sources.map((s) => fetchSource(s, config.windowHours, config.maxItemsPerSource)),
  );

  // Total-budget enforcement — drop trailing items once we exceed the cap.
  let totalChars = 0;
  const trimmed: SourceResult[] = [];
  for (const r of results) {
    if (!r.items || r.items.length === 0) {
      trimmed.push(r);
      totalChars += JSON.stringify(r).length;
      continue;
    }
    const kept: Item[] = [];
    for (const item of r.items) {
      const cost = JSON.stringify(item).length;
      if (totalChars + cost > config.totalBudget) break;
      kept.push(item);
      totalChars += cost;
    }
    trimmed.push({ ...r, items: kept, itemCount: kept.length });
  }

  process.stdout.write(
    JSON.stringify({
      wakeAgent: true,
      data: {
        fetchedAt: new Date().toISOString(),
        windowHours: config.windowHours,
        totalChars,
        sources: trimmed,
      },
    }),
  );
}

main().catch((e) => {
  process.stderr.write(`[news-fetch] fatal: ${e}\n`);
  process.exit(1);
});
