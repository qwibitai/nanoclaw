import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { buildPrompt, type BuildPromptInput } from './prompt-builder.js';
import { TRIAGE_DEFAULTS } from './config.js';
import { validateTriageDecision, type TriageDecision } from './schema.js';

export interface ClassifierResult {
  decision: TriageDecision;
  tier: 1 | 2 | 3;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

// Lazy provider — constructed once at module load. API key read from
// process.env with a fallback to the repo's .env file. readEnvFile does
// not populate process.env (security), and launchd does not inject .env
// keys into the process environment, so without the bridge the classifier
// receives an empty apiKey and every call fails with "x-api-key required".
const anthropic = createAnthropic({
  apiKey:
    process.env.ANTHROPIC_API_KEY ??
    readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY ??
    '',
});

function modelForTier(tier: 1 | 2 | 3) {
  const modelId =
    tier === 1
      ? TRIAGE_DEFAULTS.models.tier1
      : tier === 2
        ? TRIAGE_DEFAULTS.models.tier2
        : TRIAGE_DEFAULTS.models.tier3;
  return anthropic(modelId);
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function callTier(
  tier: 1 | 2 | 3,
  input: BuildPromptInput,
  stricterInstruction?: string,
): Promise<{ raw: string; usage: ClassifierResult['usage'] }> {
  const built = buildPrompt(input);
  const userContent = stricterInstruction
    ? `${stricterInstruction}\n\n${built.userMessage}`
    : built.userMessage;

  // Anthropic prompt caching via Vercel AI SDK: the @ai-sdk/anthropic v3 shape
  // expects `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`.
  // For v1, we cache the full system string (one breakpoint) rather than
  // splitting per block. If cache hit rate is low in shadow mode, revisit
  // and move to per-message-part cacheControl with built.systemBlocks.
  const resp = await generateText({
    model: modelForTier(tier),
    system: built.system,
    messages: [{ role: 'user', content: userContent }],
    maxOutputTokens: 1024,
    providerOptions: {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    },
  });

  const raw = resp.text ?? '';

  // Vercel AI SDK v3+ usage shape: { inputTokens, outputTokens, cachedInputTokens }.
  // Older versions used `promptTokens`/`completionTokens` — handle both so
  // tests and older runtimes keep working.
  const u = resp.usage as
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        promptTokens?: number;
        completionTokens?: number;
      }
    | undefined;
  const usage = {
    inputTokens: u?.inputTokens ?? u?.promptTokens ?? 0,
    outputTokens: u?.outputTokens ?? u?.completionTokens ?? 0,
    cacheReadTokens: u?.cachedInputTokens ?? 0,
    cacheCreationTokens: 0, // not exposed uniformly; leave at 0
  };

  return { raw, usage };
}

async function tryTier(
  tier: 1 | 2 | 3,
  input: BuildPromptInput,
): Promise<
  ClassifierResult | { malformed: true; usage: ClassifierResult['usage'] }
> {
  const first = await callTier(tier, input);
  const json1 = extractJson(first.raw);
  const v1 = json1
    ? validateTriageDecision(json1)
    : { ok: false as const, error: 'not json' };
  if (v1.ok) {
    return { decision: v1.value, tier, usage: first.usage };
  }

  logger.warn(
    { tier, error: v1.error },
    'Triage classifier output invalid — retrying with stricter instruction',
  );

  const second = await callTier(
    tier,
    input,
    `Your previous output was invalid: ${v1.error}. Output ONLY valid JSON matching the schema. No prose, no markdown fences.`,
  );
  const json2 = extractJson(second.raw);
  const v2 = json2
    ? validateTriageDecision(json2)
    : { ok: false as const, error: 'not json' };

  const mergedUsage = {
    inputTokens: first.usage.inputTokens + second.usage.inputTokens,
    outputTokens: first.usage.outputTokens + second.usage.outputTokens,
    cacheReadTokens: first.usage.cacheReadTokens + second.usage.cacheReadTokens,
    cacheCreationTokens:
      first.usage.cacheCreationTokens + second.usage.cacheCreationTokens,
  };

  if (v2.ok) {
    return { decision: v2.value, tier, usage: mergedUsage };
  }

  return { malformed: true, usage: mergedUsage };
}

/**
 * Classify email through tier-routed, prompt-cached LLM calls.
 * Escalation rules:
 *   - Malformed output after retry at tier N → try tier N+1 (up to 3)
 *   - Valid output at tier 1 with confidence in (escalateLow, escalateHigh) → try tier 2
 *   - Valid output at tier 2 with confidence still in gap → try tier 3
 *   - Tier 3 result is final (malformed tier 3 → throw)
 */
export async function classifyWithLlm(
  input: BuildPromptInput,
): Promise<ClassifierResult> {
  const accUsage: ClassifierResult['usage'] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  for (const tier of [1, 2, 3] as const) {
    const r = await tryTier(tier, input);
    accUsage.inputTokens += r.usage.inputTokens;
    accUsage.outputTokens += r.usage.outputTokens;
    accUsage.cacheReadTokens += r.usage.cacheReadTokens;
    accUsage.cacheCreationTokens += r.usage.cacheCreationTokens;

    if ('malformed' in r) {
      if (tier === 3) {
        throw new Error('Triage classifier: malformed at tier 3');
      }
      continue;
    }

    const c = r.decision.confidence;
    const inGap =
      c >= TRIAGE_DEFAULTS.escalateLow && c <= TRIAGE_DEFAULTS.escalateHigh;
    if (inGap && tier < 3) {
      logger.info(
        { tier, confidence: c },
        'Triage classifier confidence in gap band — escalating',
      );
      continue;
    }

    return { ...r, usage: accUsage };
  }

  throw new Error('Triage classifier: exhausted all tiers');
}
