import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const ConfigSchema = z.object({
  qdrant: z.object({
    url: z.string().url(),
    collection: z.string(),
    vectorSize: z.number(),
    distance: z.enum(['Cosine', 'Euclid', 'Dot']),
  }),
  embeddings: z.object({
    provider: z.literal('openai'),
    model: z.string(),
    dimensions: z.number(),
  }),
  search: z.object({
    topK: z.number(),
    scoreThreshold: z.number(),
  }),
  server: z.object({
    port: z.number(),
    host: z.string(),
  }),
  ingestion: z.object({
    batchSize: z.number(),
    pollIntervalMs: z.number(),
    nanoclawDbPath: z.string(),
  }),
});

export type RAGConfig = z.infer<typeof ConfigSchema>;

let config: RAGConfig | null = null;

export function loadConfig(): RAGConfig {
  if (config) return config;

  const configPath = join(process.cwd(), 'config', 'rag-config.json');
  const configData = JSON.parse(readFileSync(configPath, 'utf-8'));

  config = ConfigSchema.parse(configData);
  return config;
}

export function getConfig(): RAGConfig {
  if (!config) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return config;
}
