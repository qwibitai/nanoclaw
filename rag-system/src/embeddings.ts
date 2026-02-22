import OpenAI from 'openai';
import { getConfig } from './config.js';

let client: OpenAI | null = null;

export function initialize(): void {
  if (client) return;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  client = new OpenAI({ apiKey });
  console.log('OpenAI embedding client initialized');
}

function getClient(): OpenAI {
  if (!client) {
    throw new Error('Embedding client not initialized. Call initialize() first.');
  }
  return client;
}

export async function embed(text: string): Promise<number[]> {
  const config = getConfig();
  const response = await getClient().embeddings.create({
    model: config.embeddings.model,
    input: text,
    dimensions: config.embeddings.dimensions,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const config = getConfig();
  const response = await getClient().embeddings.create({
    model: config.embeddings.model,
    input: texts,
    dimensions: config.embeddings.dimensions,
  });

  // OpenAI returns embeddings in the same order as input
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
