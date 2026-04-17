import type { LanguageModel } from 'ai';
import { generateText, embed } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { readEnvFile } from '../env.js';

type ProviderFactory = ReturnType<
  typeof createOpenAI | typeof createGoogleGenerativeAI | typeof createAnthropic
>;

/**
 * Read an API key from process.env, falling back to the project .env file.
 * The host process does not auto-load .env into process.env (see env.ts), so
 * host-side utility LLM calls need this explicit lookup.
 */
function readKey(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const fromFile = readEnvFile([name])[name];
  return fromFile || undefined;
}

export function isEmbeddingAvailable(): boolean {
  return Boolean(readKey('OPENAI_API_KEY'));
}

export function resolveUtilityModel(explicit?: string): LanguageModel {
  const spec = explicit ?? readKey('UTILITY_LLM_MODEL');
  if (spec) {
    const [providerName, ...modelParts] = spec.split(':');
    const modelId = modelParts.join(':');
    const factory = getFactory(providerName);
    return factory(modelId);
  }

  const openaiKey = readKey('OPENAI_API_KEY');
  if (openaiKey) {
    return createOpenAI({ apiKey: openaiKey })('gpt-4o-mini');
  }
  const googleKey = readKey('GOOGLE_GENERATIVE_AI_API_KEY');
  if (googleKey) {
    return createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.0-flash');
  }
  const anthropicKey = readKey('ANTHROPIC_API_KEY');
  if (anthropicKey) {
    return createAnthropic({
      apiKey: anthropicKey,
      baseURL: readKey('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1',
    })('claude-haiku-4-5-20251001');
  }

  // No API key found — attempt openai as default (will fail at runtime if no key;
  // useful in test environments where providers are mocked).
  return createOpenAI({ apiKey: '' })('gpt-4o-mini');
}

function getFactory(providerName: string): ProviderFactory {
  switch (providerName) {
    case 'openai':
      return createOpenAI({ apiKey: readKey('OPENAI_API_KEY') });
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: readKey('GOOGLE_GENERATIVE_AI_API_KEY'),
      });
    case 'anthropic':
      return createAnthropic({ apiKey: readKey('ANTHROPIC_API_KEY'), baseURL: readKey('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com/v1' });
    default:
      throw new Error(`Unknown utility provider: ${providerName}`);
  }
}

export async function classify(
  text: string,
  categories: string[],
  options?: { model?: string },
): Promise<string> {
  const model = resolveUtilityModel(options?.model);

  const result = await generateText({
    model,
    system: `You are a classifier. Respond with exactly one of these categories: ${categories.join(', ')}. No explanation, just the category.`,
    messages: [{ role: 'user', content: text }],
    maxOutputTokens: 50,
  });

  const output = result.text.trim().toLowerCase();
  const match = categories.find((c) => c.toLowerCase() === output);
  return match ?? categories[0];
}

export async function generateShort(
  prompt: string,
  options?: { model?: string; maxOutputTokens?: number },
): Promise<string> {
  const model = resolveUtilityModel(options?.model);

  const result = await generateText({
    model,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: options?.maxOutputTokens ?? 200,
  });

  return result.text;
}

export async function embedText(
  text: string,
  options?: { model?: string },
): Promise<number[] | null> {
  if (!isEmbeddingAvailable()) {
    return null;
  }
  const spec = options?.model ?? 'openai:text-embedding-3-small';
  const [providerName, ...modelParts] = spec.split(':');
  const modelId = modelParts.join(':');

  const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });
  if (providerName !== 'openai') {
    throw new Error(
      `Embedding only supported for openai, got: ${providerName}`,
    );
  }
  const embeddingModel = provider.textEmbeddingModel(modelId);

  const result = await embed({
    model: embeddingModel,
    value: text,
  });

  return result.embedding;
}
