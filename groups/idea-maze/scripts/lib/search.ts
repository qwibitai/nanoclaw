import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { upsertSourceItem, type SourceItemRow, type UpsertSourceItem } from "./queries.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";
const TAVILY_SEARCH_API = "https://api.tavily.com/search";
const MAX_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 5;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "was", "are",
  "be", "has", "have", "had", "not", "they", "we", "you", "he", "she",
  "its", "my", "our", "your", "their", "can", "will", "just", "than",
  "then", "also", "into", "been", "being", "some", "what", "when",
  "where", "which", "who", "how", "all", "each", "every", "both",
  "few", "more", "most", "other", "like", "about", "would", "could",
  "there", "these", "those", "over", "such",
]);

export interface OpportunityResearchTarget {
  title: string;
  cluster_key: string;
}

export interface SearchEvidenceItem {
  id: number;
  title: string;
  text: string;
  canonical_url: string | null;
  query: string;
  rank: number;
}

export interface SearchEnrichment {
  provider: "tavily";
  queries: string[];
  answers: string[];
  item_ids: number[];
  items: SearchEvidenceItem[];
}

interface TavilyResult {
  title?: string;
  content?: string;
  url?: string;
  site_name?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKeyword(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && token.length > 4 && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function keywordCounts(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
    for (const token of tokens) {
      const normalized = normalizeKeyword(token);
      if (!STOP_WORDS.has(normalized)) {
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function isSearchConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}

// Fixed query budget keeps enrichment comparable and easy to review.
export function buildSearchQueries(
  target: OpportunityResearchTarget,
  sourceItems: Array<Pick<SourceItemRow, "title" | "text">>,
  limit = MAX_QUERIES,
): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    const query = normalizeWhitespace(value);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  add(target.title);

  const titleLower = target.title.toLowerCase();
  const evidenceKeywords = [...keywordCounts(sourceItems.map((item) => `${item.title ?? ""} ${item.text}`)).entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word)
    .filter((token) => !titleLower.includes(token))
    .slice(0, 2);

  if (evidenceKeywords.length) {
    add(`${target.title} ${evidenceKeywords.join(" ")}`);
  }

  if (queries.length < limit) {
    add(`${target.cluster_key.replace(/-/g, " ")} alternatives pricing complaints`);
  }

  if (queries.length < limit) {
    add(`${target.title} market size competitors`);
  }

  return queries.slice(0, limit);
}

export function rawPathForSearch(runId: number, query: string, timestamp: Date): string {
  const slug = hashText(query).slice(0, 12);
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return resolve(GROUP_DIR, "data", "raw", "search", String(y), m, d, `${runId}_${slug}.json`);
}

export function toSearchSourceItem(args: {
  runId: number;
  query: string;
  rank: number;
  timestamp: Date;
  rawPath: string;
  result: TavilyResult;
}): UpsertSourceItem {
  const title = normalizeWhitespace(args.result.title ?? "") || args.query;
  const text = normalizeWhitespace(args.result.content ?? "") || title;
  const url = args.result.url?.trim() || null;

  return {
    source: "search",
    external_id: hashText(url || `${args.query}:${args.rank}`),
    thread_ref: String(args.runId),
    author: args.result.site_name?.trim() || null,
    title,
    text,
    canonical_url: url,
    channel_or_label: "tavily",
    timestamp_utc: args.timestamp.toISOString(),
    raw_path: args.rawPath,
    content_hash: hashText(`${title}\n${text}`),
    metadata_json: {
      provider: "tavily",
      query: args.query,
      rank: args.rank,
      score: Number.isFinite(Number(args.result.score)) ? Number(args.result.score) : null,
      run_id: args.runId,
    },
  };
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRateLimit = err instanceof Error && /4(29|32)/.test(err.message);
      if (!isRateLimit || attempt === maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function tavilySearch(query: string, depth: "basic" | "advanced" = "advanced"): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  return withRetry(async () => {
    const res = await fetch(TAVILY_SEARCH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        topic: "general",
        search_depth: depth,
        max_results: MAX_RESULTS_PER_QUERY,
        include_answer: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Tavily API ${res.status}: ${body}`);
    }

    return res.json() as Promise<TavilyResponse>;
  });
}

export async function enrichOpportunityWithSearch(
  target: OpportunityResearchTarget,
  sourceItems: Array<Pick<SourceItemRow, "title" | "text">>,
  runId: number,
): Promise<SearchEnrichment> {
  if (!isSearchConfigured()) {
    throw new Error("TAVILY_API_KEY not set");
  }

  const queries = buildSearchQueries(target, sourceItems);
  const items: SearchEvidenceItem[] = [];
  const answers: string[] = [];

  for (const [queryIndex, query] of queries.entries()) {
    // Use basic depth for fallback queries to save API credits
    const depth = queryIndex === 0 ? "advanced" : "basic";
    const timestamp = new Date();
    const payload = await tavilySearch(query, depth);
    const rawPath = rawPathForSearch(runId, query, timestamp);
    writeJson(rawPath, payload);

    if (payload.answer) {
      answers.push(payload.answer);
    }

    for (const [index, result] of (payload.results ?? []).entries()) {
      const sourceItem = toSearchSourceItem({
        runId,
        query,
        rank: index + 1,
        timestamp,
        rawPath,
        result,
      });
      const { id } = upsertSourceItem(sourceItem);
      items.push({
        id,
        title: sourceItem.title ?? query,
        text: sourceItem.text,
        canonical_url: sourceItem.canonical_url ?? null,
        query,
        rank: index + 1,
      });
    }
  }

  return {
    provider: "tavily",
    queries,
    answers,
    item_ids: [...new Set(items.map((item) => item.id))],
    items,
  };
}
