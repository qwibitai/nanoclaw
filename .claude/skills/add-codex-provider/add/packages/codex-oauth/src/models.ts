/**
 * Codex Model Definitions
 */

import type { CodexModel, ReasoningEffort } from './types.js';

export const CODEX_MODELS: CodexModel[] = [
  // GPT-5.3 Codex
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Most capable agentic coding model', baseModel: 'gpt-5.3-codex', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-codex-low', name: 'GPT-5.3 Codex (Low)', baseModel: 'gpt-5.3-codex', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-codex-high', name: 'GPT-5.3 Codex (High)', baseModel: 'gpt-5.3-codex', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-codex-xhigh', name: 'GPT-5.3 Codex (XHigh)', baseModel: 'gpt-5.3-codex', reasoning: 'xhigh', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.3 Codex Spark
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', description: 'Real-time coding, 1000+ tok/s', baseModel: 'gpt-5.3-codex-spark', reasoning: 'medium', contextWindow: 128000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-codex-spark-high', name: 'GPT-5.3 Codex Spark (High)', baseModel: 'gpt-5.3-codex-spark', reasoning: 'high', contextWindow: 128000, maxOutputTokens: 128000 },

  // GPT-5.3 General
  { id: 'gpt-5.3', name: 'GPT-5.3', description: 'General purpose model', baseModel: 'gpt-5.3', reasoning: 'none', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-low', name: 'GPT-5.3 (Low)', baseModel: 'gpt-5.3', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-medium', name: 'GPT-5.3 (Medium)', baseModel: 'gpt-5.3', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-high', name: 'GPT-5.3 (High)', baseModel: 'gpt-5.3', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-xhigh', name: 'GPT-5.3 (XHigh)', baseModel: 'gpt-5.3', reasoning: 'xhigh', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.3-none', name: 'GPT-5.3 (No Reasoning)', baseModel: 'gpt-5.3', reasoning: 'none', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.2 General
  { id: 'gpt-5.2', name: 'GPT-5.2', description: 'General purpose model', baseModel: 'gpt-5.2', reasoning: 'none', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-low', name: 'GPT-5.2 (Low)', baseModel: 'gpt-5.2', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-medium', name: 'GPT-5.2 (Medium)', baseModel: 'gpt-5.2', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-high', name: 'GPT-5.2 (High)', baseModel: 'gpt-5.2', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-xhigh', name: 'GPT-5.2 (XHigh)', baseModel: 'gpt-5.2', reasoning: 'xhigh', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.2 Codex
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: 'Advanced agentic coding model', baseModel: 'gpt-5.2-codex', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-codex-low', name: 'GPT-5.2 Codex (Low)', baseModel: 'gpt-5.2-codex', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-codex-high', name: 'GPT-5.2 Codex (High)', baseModel: 'gpt-5.2-codex', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.2-codex-xhigh', name: 'GPT-5.2 Codex (XHigh)', baseModel: 'gpt-5.2-codex', reasoning: 'xhigh', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.1 Codex Max
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'Long-running with compaction', baseModel: 'gpt-5.1-codex-max', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-codex-max-low', name: 'GPT-5.1 Codex Max (Low)', baseModel: 'gpt-5.1-codex-max', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-codex-max-medium', name: 'GPT-5.1 Codex Max (Medium)', baseModel: 'gpt-5.1-codex-max', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-codex-max-xhigh', name: 'GPT-5.1 Codex Max (XHigh)', baseModel: 'gpt-5.1-codex-max', reasoning: 'xhigh', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.1 Codex
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', description: 'Balanced coding model', baseModel: 'gpt-5.1-codex', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-codex-low', name: 'GPT-5.1 Codex (Low)', baseModel: 'gpt-5.1-codex', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-codex-high', name: 'GPT-5.1 Codex (High)', baseModel: 'gpt-5.1-codex', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.1 Codex Mini
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: 'Fast and efficient', baseModel: 'gpt-5.1-codex-mini', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-codex-mini-high', name: 'GPT-5.1 Codex Mini (High)', baseModel: 'gpt-5.1-codex-mini', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5.1 General
  { id: 'gpt-5.1', name: 'GPT-5.1', description: 'General purpose model', baseModel: 'gpt-5.1', reasoning: 'none', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-low', name: 'GPT-5.1 (Low)', baseModel: 'gpt-5.1', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-medium', name: 'GPT-5.1 (Medium)', baseModel: 'gpt-5.1', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5.1-high', name: 'GPT-5.1 (High)', baseModel: 'gpt-5.1', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5 Codex
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', description: 'Original coding model', baseModel: 'gpt-5-codex', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-codex-low', name: 'GPT-5 Codex (Low)', baseModel: 'gpt-5-codex', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-codex-high', name: 'GPT-5 Codex (High)', baseModel: 'gpt-5-codex', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-codex-xhigh', name: 'GPT-5 Codex (XHigh)', baseModel: 'gpt-5-codex', reasoning: 'xhigh', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5 Codex Mini
  { id: 'gpt-5-codex-mini', name: 'GPT-5 Codex Mini', description: 'Lightweight coding model', baseModel: 'gpt-5-codex-mini', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-codex-mini-high', name: 'GPT-5 Codex Mini (High)', baseModel: 'gpt-5-codex-mini', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },

  // GPT-5 General
  { id: 'gpt-5', name: 'GPT-5', description: 'General purpose model', baseModel: 'gpt-5', reasoning: 'none', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-low', name: 'GPT-5 (Low)', baseModel: 'gpt-5', reasoning: 'low', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-medium', name: 'GPT-5 (Medium)', baseModel: 'gpt-5', reasoning: 'medium', contextWindow: 400000, maxOutputTokens: 128000 },
  { id: 'gpt-5-high', name: 'GPT-5 (High)', baseModel: 'gpt-5', reasoning: 'high', contextWindow: 400000, maxOutputTokens: 128000 },
];

/** Get model info by ID */
export function getModelInfo(modelId: string): CodexModel | undefined {
  return CODEX_MODELS.find((m) => m.id === modelId);
}

/** Get the base model ID for API calls (strips reasoning suffix) */
export function getBaseModelId(modelId: string): string {
  const model = getModelInfo(modelId);
  return model?.baseModel ?? modelId;
}

/** Get the reasoning effort for a model */
export function getReasoningEffort(modelId: string): ReasoningEffort {
  const model = getModelInfo(modelId);
  return model?.reasoning ?? 'medium';
}
