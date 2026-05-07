/**
 * Host-side Ollama embedding client for cheap cosine similarity signals.
 * Used only at recall time to populate embedding_sim in recall_outcomes.
 * Returns empty Map on ANY failure — never blocks the recall path.
 */

export interface FactInput {
  id: string;
  content: string;
}

// Parse HOST_OLLAMA_ENDPOINT once at module load — throw loud on bad URL (C14).
const RAW_ENDPOINT = process.env.HOST_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
// Validates the URL is parseable; throws at module load on invalid input.
const OLLAMA_URL = new URL(RAW_ENDPOINT);
if (!OLLAMA_URL.hostname) {
  throw new Error(`HOST_OLLAMA_ENDPOINT is not a valid URL: "${RAW_ENDPOINT}"`);
}
const EMBED_ENDPOINT = `${RAW_ENDPOINT.replace(/\/$/, '')}/api/embed`;
const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_TIMEOUT_MS = 800;

type EmbedderFn = (texts: string[]) => Promise<number[][]>;

let _embedderOverride: EmbedderFn | null = null;

export function setEmbedderForTest(fn: EmbedderFn | null): void {
  _embedderOverride = fn;
}

export function _resetEmbedderForTest(): void {
  _embedderOverride = null;
}

async function callEmbedder(texts: string[], signal: AbortSignal): Promise<number[][]> {
  if (_embedderOverride !== null) {
    // Race the override against abort so timeouts propagate in tests.
    return await Promise.race([
      _embedderOverride(texts),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
  }
  const model = process.env.HOST_OLLAMA_EMBED_MODEL ?? DEFAULT_MODEL;
  const resp = await fetch(EMBED_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`Ollama embed returned ${resp.status}`);
  }
  const data = (await resp.json()) as { embeddings?: number[][] };
  if (!Array.isArray(data.embeddings)) {
    throw new Error('Ollama embed: unexpected response shape');
  }
  return data.embeddings;
}

function norm(vec: number[]): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const raw = dot / (na * nb);
  // Clip to [0, 1]: Ollama embeddings are directional so negative cosines
  // indicate no semantic overlap — treat as zero for scoring purposes.
  return Math.max(0, Math.min(1, raw));
}

/**
 * Compute cosine similarity between query and each fact using a single
 * batched Ollama embed call. Returns Map<fact_id, similarity in [0,1]>.
 * Returns empty Map on any failure. Never throws.
 */
export async function computeQueryFactCosines(
  query: string,
  facts: FactInput[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Map<string, number>> {
  if (facts.length === 0) return new Map();

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = opts?.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;

  try {
    const texts = [query, ...facts.map((f) => f.content)];
    const embeddings = await callEmbedder(texts, signal);
    clearTimeout(timer);

    if (embeddings.length !== texts.length) return new Map();

    const queryVec = embeddings[0];
    const result = new Map<string, number>();
    for (let i = 0; i < facts.length; i++) {
      result.set(facts[i].id, cosine(queryVec, embeddings[i + 1]));
    }
    return result;
  } catch {
    clearTimeout(timer);
    return new Map();
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
