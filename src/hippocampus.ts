import {
  HIPPOCAMPUS_API_URL,
  HIPPOCAMPUS_BUDGET_TOKENS,
  HIPPOCAMPUS_ENABLED,
  HIPPOCAMPUS_TOP_K,
} from './config.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

const REQUEST_TIMEOUT_MS = 1500;
const TOKEN_TO_CHAR_ESTIMATE = 4;
const MIN_QUERY_TOKEN_LENGTH = 3;
const MAX_QUERY_TERMS = 32;
const WARN_THROTTLE_MS = 60_000;

const RECALL_ENDPOINTS = ['/recall', '/api/recall', '/v1/recall'];
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

interface RecallRequest {
  query: string;
  chatJid: string;
  groupFolder: string;
  sessionId?: string;
  messages: Array<{ sender: string; content: string; timestamp: string }>;
}

export function extractQueryTerms(messages: NewMessage[]): string {
  const context = selectRecallContext(messages);
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
    '<RECALL>',
    '## RECALL',
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

    const entry = [
      `### Memory ${i + 1}${headingScore}`,
      truncate(memory.text, 800),
      memory.source ? `Source: ${memory.source}` : '',
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

  if (out.length + '</RECALL>'.length + 1 > maxChars) {
    out = truncate(out, maxChars - '</RECALL>'.length - 1);
  }

  return `${out}</RECALL>`;
}

export async function injectRecallBlock(
  args: RecallInjectionArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!HIPPOCAMPUS_ENABLED) return args.prompt;

  const query = extractQueryTerms(args.messages);
  if (!query) return args.prompt;

  try {
    const recallRequest: RecallRequest = {
      query,
      chatJid: args.chatJid,
      groupFolder: args.groupFolder,
      sessionId: args.sessionId,
      messages: selectRecallContext(args.messages).map((m) => ({
        sender: m.sender_name,
        content: truncate(m.content, 1200),
        timestamp: m.timestamp,
      })),
    };

    const response = await postWithEndpointFallback(
      HIPPOCAMPUS_API_URL,
      RECALL_ENDPOINTS,
      {
        query,
        topK: HIPPOCAMPUS_TOP_K,
        top_k: HIPPOCAMPUS_TOP_K,
        budgetTokens: HIPPOCAMPUS_BUDGET_TOKENS,
        budget_tokens: HIPPOCAMPUS_BUDGET_TOKENS,
        context: recallRequest,
      },
      fetchImpl,
    );

    const memories = normalizeMemories(response).slice(0, HIPPOCAMPUS_TOP_K);
    if (memories.length === 0) return args.prompt;

    const recallBlock = buildRecallBlock(
      query,
      memories,
      HIPPOCAMPUS_BUDGET_TOKENS,
    );

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
    (obj.metadata && typeof obj.metadata === 'object'
      ? pickString(obj.metadata as Record<string, unknown>, [
          'source',
          'origin',
        ])
      : undefined);

  const createdAt = pickString(obj, [
    'createdAt',
    'created_at',
    'timestamp',
    'time',
    'updatedAt',
  ]);

  return {
    text: trimmed,
    score,
    source,
    createdAt,
    metadata:
      obj.metadata && typeof obj.metadata === 'object'
        ? (obj.metadata as Record<string, unknown>)
        : undefined,
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
