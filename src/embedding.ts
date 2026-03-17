import { readEnvFile } from './env.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const FETCH_TIMEOUT_MS = 5000;

let apiKey: string | null | undefined; // undefined = not yet loaded; null = not configured

function getApiKey(): string | null {
  if (apiKey !== undefined) return apiKey;
  const env = readEnvFile(['OPENAI_API_KEY']);
  apiKey = env['OPENAI_API_KEY'] ?? null;
  return apiKey;
}

export async function generateEmbedding(
  text: string,
): Promise<Float32Array | null> {
  const key = getApiKey();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: text, model: EMBEDDING_MODEL }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embeddings ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return new Float32Array(data.data[0].embedding);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
