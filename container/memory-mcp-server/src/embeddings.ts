/**
 * Embedding generation using @xenova/transformers (local, no API key needed).
 * Uses all-MiniLM-L6-v2 for 384-dimensional sentence embeddings.
 */

let pipelineInstance: ((text: string) => Promise<{ data: ArrayLike<number> }>) | null = null;

async function getPipeline() {
  if (pipelineInstance) return pipelineInstance;

  const { pipeline } = await import('@xenova/transformers');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  pipelineInstance = async (text: string) => {
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    return { data: result.data as ArrayLike<number> };
  };

  return pipelineInstance;
}

export const EMBEDDING_DIM = 384;

/**
 * Generate an embedding vector for the given text.
 * Returns a Float32Array of length EMBEDDING_DIM.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const output = await pipe(text);
  const arr = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    arr[i] = Number(output.data[i]) || 0;
  }
  return arr;
}

/**
 * Compute cosine similarity between two vectors.
 * Assumes both are already normalized (which all-MiniLM-L6-v2 with normalize:true gives us),
 * so cosine similarity = dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
