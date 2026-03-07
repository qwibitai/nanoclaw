import {
  HIPPOCAMPUS_API_URL,
  HIPPOCAMPUS_BUDGET_TOKENS,
  HIPPOCAMPUS_ENABLED,
  HIPPOCAMPUS_MIN_SCORE,
  HIPPOCAMPUS_TOP_K,
} from './config.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

const REQUEST_TIMEOUT_MS = 1500;
const TOKEN_TO_CHAR_ESTIMATE = 4;
const MIN_QUERY_TOKEN_LENGTH = 3;
const MAX_QUERY_TERMS = 32;
const WARN_THROTTLE_MS = 60_000;
const RECALL_CACHE_TTL_MS = 30_000;
const RECALL_CACHE_MAX_ENTRIES = 256;

const RECALL_ENDPOINT = '/api/recall';
const EPISODE_ENDPOINTS = [
  '/episodes/extract',
  '/api/episodes/extract',
  '/v1/episodes/extract',
];

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
  'you',
  'your',
  'this',
  'they',
  'them',
  'their',
  'about',
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
]);

let lastWarningAt = 0;

export interface RecalledMemory {
  text: string;
  score?: number;
  source?: string;
  from?: number;
  to?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallInjectionArgs {
  prompt: string;
  messages: NewMessage[];
  chatJid: string;
  groupFolder: string;
  sessionId?: string;
}

export interface EpisodeExtractionArgs {
  chatJid: string;
  groupFolder: string;
  boundary: 'idle_timeout' | 'session_end';
  sessionId?: string;
  messages?: NewMessage[];
}

interface RecallCacheEntry {
  recallBlock: string;
  expiresAt: number;
}

const recallTurnCache = new Map<string, RecallCacheEntry>();

export function extractQueryTerms(messages: NewMessage[]): string {
  const context = selectUserRecallContext(messages);
  if (context.length === 0) return '';

  const scores = new Map<string, number>();

  for (let i = 0; i < context.length; i++) {
    const msg = context[i];
    const weight = i === context.length - 1 ? 3 : 1;
    const normalized = msg.content
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9_\-\s']/g, ' ');

    for (const token of normalized.split(/\s+/)) {
      if (
        token.length < MIN_QUERY_TOKEN_LENGTH ||
        STOPWORDS.has(token) ||
        /^\d+$/.test(token)
      ) {
        continue;
      }
      scores.set(token, (scores.get(token) || 0) + weight);
    }
  }

  const terms = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_QUERY_TERMS)
    .map(([term]) => term);

  if (terms.length > 0) return terms.join(' ');

  return context
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 512);
}

export function buildRecallBlock(
  query: string,
  memories: RecalledMemory[],
  budgetTokens: number = HIPPOCAMPUS_BUDGET_TOKENS,
): string {
  if (memories.length === 0) return '';

  const maxChars = Math.max(1024, budgetTokens * TOKEN_TO_CHAR_ESTIMATE);
  const lines = [
    '## RECALL.md',
    `Generated: ${new Date().toISOString()}`,
    `Query: ${query}`,
    'Use these memories as context hints. Prefer current conversation details when conflict exists.',
    '',
  ];

  let out = lines.join('\n');

  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    const headingScore =
      typeof memory.score === 'number'
        ? ` (score ${memory.score.toFixed(3)})`
        : '';
    const sourceRef = formatSourceReference(memory);

    const entry = [
      `### Memory ${i + 1}${headingScore}`,
      truncate(memory.text, 800),
      sourceRef ? `Source: ${sourceRef}` : '',
      memory.createdAt ? `Timestamp: ${memory.createdAt}` : '',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    if (out.length + entry.length + 10 > maxChars) {
      const room = maxChars - out.length - 15;
      if (room > 120) {
        out += `${truncate(entry, room)}\n`;
      }
      break;
    }

    out += `${entry}\n`;
  }

  return truncate(out.trimEnd(), maxChars);
}

export async function injectRecallBlock(
  args: RecallInjectionArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!HIPPOCAMPUS_ENABLED) return args.prompt;

  const query = extractQueryTerms(args.messages);
  if (!query) return args.prompt;

  const cacheKey = buildRecallCacheKey(args, query);
  const cachedRecall = readRecallFromCache(cacheKey);
  if (cachedRecall !== undefined) {
    return cachedRecall ? `${cachedRecall}\n\n${args.prompt}` : args.prompt;
  }

  try {
    const response = await postJson(
      toUrl(HIPPOCAMPUS_API_URL, RECALL_ENDPOINT),
      {
        query,
        topK: HIPPOCAMPUS_TOP_K,
        minScore: HIPPOCAMPUS_MIN_SCORE,
      },
      fetchImpl,
    );

    const memories = normalizeMemories(response).slice(0, HIPPOCAMPUS_TOP_K);
    if (memories.length === 0) {
      writeRecallToCache(cacheKey, '');
      return args.prompt;
    }

    const recallBlock = buildRecallBlock(
      query,
      memories,
      HIPPOCAMPUS_BUDGET_TOKENS,
    );

    writeRecallToCache(cacheKey, recallBlock);
    if (!recallBlock) return args.prompt;
    return `${recallBlock}\n\n${args.prompt}`;
  } catch (err) {
    warnThrottled(
      { err, chatJid: args.chatJid, groupFolder: args.groupFolder },
      'Hippocampus recall unavailable, continuing without memory injection',
    );
    return args.prompt;
  }
}

export async function extractEpisodeAtBoundary(
  args: EpisodeExtractionArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!HIPPOCAMPUS_ENABLED) return;

  const messages = selectRecallContext(args.messages || []).map((m) => ({
    sender: m.sender_name,
    content: truncate(m.content, 1200),
    timestamp: m.timestamp,
  }));

  try {
    await postWithEndpointFallback(
      HIPPOCAMPUS_API_URL,
      EPISODE_ENDPOINTS,
      {
        boundary: args.boundary,
        chatJid: args.chatJid,
        chat_jid: args.chatJid,
        groupFolder: args.groupFolder,
        group_folder: args.groupFolder,
        sessionId: args.sessionId,
        session_id: args.sessionId,
        timestamp: new Date().toISOString(),
        messages,
      },
      fetchImpl,
    );
  } catch (err) {
    warnThrottled(
      {
        err,
        boundary: args.boundary,
        chatJid: args.chatJid,
        groupFolder: args.groupFolder,
      },
      'Hippocampus episode extraction failed',
    );
  }
}

function selectUserRecallContext(messages: NewMessage[]): NewMessage[] {
  const nonEmpty = messages.filter(
    (m) => m.content && m.content.trim().length > 0,
  );
  if (nonEmpty.length === 0) return [];

  const userMessages = nonEmpty.filter(
    (m) => m.is_from_me !== true && m.is_bot_message !== true,
  );
  const source = userMessages.length > 0 ? userMessages : nonEmpty;

  const last = source[source.length - 1];
  const prior = source.slice(Math.max(0, source.length - 4), source.length - 1);
  return [...prior, last];
}

function selectRecallContext(messages: NewMessage[]): NewMessage[] {
  const nonEmpty = messages.filter(
    (m) => m.content && m.content.trim().length > 0,
  );
  if (nonEmpty.length === 0) return [];

  const last = nonEmpty[nonEmpty.length - 1];
  const prior = nonEmpty.slice(
    Math.max(0, nonEmpty.length - 4),
    nonEmpty.length - 1,
  );
  return [...prior, last];
}

function buildRecallCacheKey(args: RecallInjectionArgs, query: string): string {
  const context = selectUserRecallContext(args.messages);
  const contextIds = context
    .map((m) => `${m.id}:${m.timestamp}`)
    .join('|')
    .slice(0, 512);

  return [
    args.chatJid,
    args.groupFolder,
    args.sessionId || '',
    query,
    contextIds,
  ].join('::');
}

function readRecallFromCache(cacheKey: string): string | undefined {
  const entry = recallTurnCache.get(cacheKey);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    recallTurnCache.delete(cacheKey);
    return undefined;
  }

  return entry.recallBlock;
}

function writeRecallToCache(cacheKey: string, recallBlock: string): void {
  pruneRecallCache();
  recallTurnCache.set(cacheKey, {
    recallBlock,
    expiresAt: Date.now() + RECALL_CACHE_TTL_MS,
  });

  if (recallTurnCache.size <= RECALL_CACHE_MAX_ENTRIES) return;
  const oldestKey = recallTurnCache.keys().next().value as string | undefined;
  if (oldestKey) recallTurnCache.delete(oldestKey);
}

function pruneRecallCache(): void {
  if (recallTurnCache.size === 0) return;

  const now = Date.now();
  for (const [key, value] of recallTurnCache.entries()) {
    if (value.expiresAt <= now) {
      recallTurnCache.delete(key);
    }
  }
}

async function postJson(
  url: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Hippocampus API error ${response.status} (${url})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return { results: [] };
  }

  return response.json();
}

async function postWithEndpointFallback(
  apiBaseUrl: string,
  endpoints: string[],
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let lastErr: unknown;

  for (const endpoint of endpoints) {
    const url = toUrl(apiBaseUrl, endpoint);

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 404) {
      lastErr = new Error(`404 from ${url}`);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Hippocampus API error ${response.status} (${url})`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return { memories: [] };
    }

    return response.json();
  }

  throw lastErr || new Error('No Hippocampus endpoint available');
}

function normalizeMemories(response: unknown): RecalledMemory[] {
  const raw = getMemoryArray(response);
  const normalized = raw
    .map((item) => normalizeMemory(item))
    .filter((m): m is RecalledMemory => !!m && !!m.text);

  return normalized.sort((a, b) => {
    const as = typeof a.score === 'number' ? a.score : -Infinity;
    const bs = typeof b.score === 'number' ? b.score : -Infinity;
    return bs - as;
  });
}

function getMemoryArray(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];

  const obj = response as Record<string, unknown>;
  if (Array.isArray(obj.memories)) return obj.memories;
  if (Array.isArray(obj.results)) return obj.results;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.data)) return obj.data;

  return [];
}

function normalizeMemory(value: unknown): RecalledMemory | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { text } : null;
  }

  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const metadata =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, unknown>)
      : undefined;

  const text =
    pickString(obj, [
      'content',
      'text',
      'memory',
      'summary',
      'body',
      'snippet',
    ]) || '';
  const trimmed = text.trim();
  if (!trimmed) return null;

  const score = pickNumber(obj, [
    'score',
    'similarity',
    'rank',
    'retrievalScore',
    'retrieval_score',
  ]);

  const source =
    pickString(obj, ['source', 'origin']) ||
    (metadata ? pickString(metadata, ['source', 'origin']) : undefined);

  const createdAt = pickString(obj, [
    'createdAt',
    'created_at',
    'timestamp',
    'time',
    'updatedAt',
  ]);
  const from = toLineNumber(
    pickNumber(obj, ['from', 'fromLine', 'lineStart', 'start']) ||
      (metadata
        ? pickNumber(metadata, ['from', 'fromLine', 'lineStart', 'start'])
        : undefined),
  );
  const to = toLineNumber(
    pickNumber(obj, ['to', 'toLine', 'lineEnd', 'end']) ||
      (metadata
        ? pickNumber(metadata, ['to', 'toLine', 'lineEnd', 'end'])
        : undefined),
  );

  return {
    text: trimmed,
    score,
    source,
    from,
    to,
    createdAt,
    metadata,
  };
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function toLineNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : undefined;
}

function formatSourceReference(memory: RecalledMemory): string | undefined {
  if (!memory.source) return undefined;

  if (typeof memory.from === 'number' && typeof memory.to === 'number') {
    const maxTo = Math.max(memory.from, memory.to);
    return `${memory.source}:${memory.from}-${maxTo}`;
  }
  if (typeof memory.from === 'number') return `${memory.source}:${memory.from}`;
  if (typeof memory.to === 'number') return `${memory.source}:${memory.to}`;
  return memory.source;
}

function toUrl(baseUrl: string, endpoint: string): string {
  const withSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const cleanEndpoint = endpoint.replace(/^\//, '');
  return new URL(cleanEndpoint, withSlash).toString();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function warnThrottled(
  bindings: Record<string, unknown>,
  message: string,
): void {
  const now = Date.now();
  if (now - lastWarningAt < WARN_THROTTLE_MS) return;
  lastWarningAt = now;
  logger.warn(bindings, message);
}
