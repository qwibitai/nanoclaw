import type { LanguageModel } from 'ai';
import { generateText, embed } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';

type ProviderFactory = ReturnType<
  typeof createOpenAI | typeof createGoogleGenerativeAI | typeof createAnthropic
>;

export function resolveUtilityModel(explicit?: string): LanguageModel {
  const spec = explicit ?? process.env.UTILITY_LLM_MODEL;
  if (spec) {
    const [providerName, ...modelParts] = spec.split(':');
    const modelId = modelParts.join(':');
    const factory = getFactory(providerName);
    return factory(modelId);
  }

  if (process.env.OPENAI_API_KEY) {
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })('gpt-4o-mini');
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    })('gemini-2.0-flash');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
      'claude-haiku-4-5-20251001',
    );
  }

  // No API key found — attempt openai as default (will fail at runtime if no key;
  // useful in test environments where providers are mocked).
  return createOpenAI({ apiKey: '' })('gpt-4o-mini');
}

function getFactory(providerName: string): ProviderFactory {
  switch (providerName) {
    case 'openai':
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    case 'google':
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      });
    case 'anthropic':
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
): Promise<number[]> {
  const spec = options?.model ?? 'openai:text-embedding-3-small';
  const [providerName, ...modelParts] = spec.split(':');
  const modelId = modelParts.join(':');

  const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });
  if (providerName !== 'openai') {
    throw new Error(`Embedding only supported for openai, got: ${providerName}`);
  }
  const embeddingModel = provider.textEmbeddingModel(modelId);

  const result = await embed({
    model: embeddingModel,
    value: text,
  });

  return result.embedding;
}
