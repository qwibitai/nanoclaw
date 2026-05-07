/**
 * LLM-based focused query extractor (Strategy C).
 * Reads MEMORY_RECALL_QUERY_EXTRACTOR_BACKEND env var.
 * Throws on failure — caller implements fallback tiers (see recall-injection.ts).
 */
import crypto from 'crypto';

const SYSTEM_PROMPT = `Extract a focused keyword query for memory recall from this conversation slice.
Output ONLY the query — keywords, named entities, technical terms.
No prose, no explanation, no quotes, max 80 chars.`;

const DEFAULT_BACKEND_STR = 'anthropic:haiku-4-5:default';
const DEFAULT_TIMEOUT_MS = 800;
const CACHE_MAX_SIZE = 500;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type ExtractorBackendFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

let _backendOverride: ExtractorBackendFn | null = null;

export function setQueryExtractorBackendForTest(fn: ExtractorBackendFn | null): void {
  _backendOverride = fn;
}

export function _resetQueryExtractorBackendForTest(): void {
  _backendOverride = null;
}

// Simple LRU-ish cache: Map preserves insertion order; evict oldest when over cap.
interface CacheEntry {
  value: string;
  expiresAt: number;
}
const _cache = new Map<string, CacheEntry>();

export function clearCacheForTest(): void {
  _cache.clear();
}

function cacheGet(key: string): string | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  // Evict oldest if at cap.
  if (_cache.size >= CACHE_MAX_SIZE) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Map short model alias → full Anthropic model id.
const MODEL_ALIAS_MAP: Record<string, string> = {
  'haiku-4-5': 'claude-haiku-4-5-20251001',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'opus-4-7': 'claude-opus-4-7',
};

async function callBackend(systemPrompt: string, userPrompt: string, signal: AbortSignal): Promise<string> {
  if (_backendOverride !== null) {
    return await Promise.race([
      _backendOverride(systemPrompt, userPrompt),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
  }

  // Real backend: direct Anthropic call for text extraction (not classifier JSON).
  const backendStr = process.env.MEMORY_RECALL_QUERY_EXTRACTOR_BACKEND ?? DEFAULT_BACKEND_STR;
  const { parseBackendConfig } = await import('../../memory-daemon/classifier-client.js');
  const cfg = parseBackendConfig(backendStr);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const modelId = MODEL_ALIAS_MAP[cfg.model] ?? cfg.model;
  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 128,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`query-extractor: Anthropic returned ${resp.status}`);
  }
  const data = (await resp.json()) as { content?: Array<{ type: string; text: string }> };
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  return text;
}

function postProcess(raw: string): string {
  let s = raw.trim();
  // Strip surrounding quotes ("..." or '...')
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Truncate to 80 chars.
  return s.slice(0, 80);
}

/**
 * Extract a focused keyword query from a conversation slice via LLM.
 * Cache key is sha256 of currentMessage (not rawSlice) so retries hit cache.
 * Throws on timeout or backend error — caller handles fallback.
 */
export async function extractFocusedQuery(
  currentMessage: string,
  rawSlice: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const cacheKey = sha256(currentMessage);
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = opts?.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;

  try {
    const sanitizedSlice = rawSlice.replace(/\0/g, '');
    const raw = await callBackend(SYSTEM_PROMPT, sanitizedSlice, signal);
    clearTimeout(timer);
    const result = postProcess(raw);
    cacheSet(cacheKey, result);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}
