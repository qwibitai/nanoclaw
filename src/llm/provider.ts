import type { LlmConfig } from '../types.js';

export type { LlmConfig };

export interface ResolvedModel {
  provider: string;
  model: string | null;
  providerBaseUrl: string | null;
}

export function resolveModel(
  config: { llm?: LlmConfig },
  override?: { provider?: string; model?: string },
): ResolvedModel {
  const llm = config.llm ?? {};
  return {
    provider: override?.provider ?? llm.provider ?? 'anthropic',
    model: override?.model ?? llm.model ?? null,
    providerBaseUrl: llm.providerBaseUrl ?? null,
  };
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
};

const ESCALATION_MODELS: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
};

export function getDefaultModel(provider: string): string | null {
  return DEFAULT_MODELS[provider] ?? null;
}

export function getEscalationModel(provider: string): string | null {
  return ESCALATION_MODELS[provider] ?? null;
}
