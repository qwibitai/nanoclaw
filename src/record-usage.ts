import type { UsageData, UsageRecord } from './types.js';

export interface RecordUsageDeps {
  getGroupUsageCategory: (groupFolder: string) => string;
  detectAuthMode: () => string;
  insertUsageRecord: (record: UsageRecord) => void;
  addCaseCost: (caseId: string, costUsd: number) => void;
  addCaseTime: (caseId: string, durationMs: number) => void;
}

/**
 * Record API usage from a container result.
 * Stores one row per model used, or a single aggregate row if no model breakdown.
 */
export function recordUsage(
  deps: RecordUsageDeps,
  usage: UsageData,
  groupFolder: string,
  source: string,
  sessionId?: string,
  caseId?: string,
): void {
  const category = deps.getGroupUsageCategory(groupFolder);
  const authMode = deps.detectAuthMode();

  const models = Object.keys(usage.modelUsage);
  if (models.length === 1) {
    const model = models[0];
    const mu = usage.modelUsage[model];
    deps.insertUsageRecord({
      group_folder: groupFolder,
      category,
      source,
      auth_mode: authMode,
      model,
      input_tokens: mu.inputTokens,
      output_tokens: mu.outputTokens,
      cache_read_tokens: mu.cacheReadInputTokens,
      cache_create_tokens: mu.cacheCreationInputTokens,
      cost_usd: usage.totalCostUsd,
      duration_ms: usage.durationMs ?? null,
      duration_api_ms: usage.durationApiMs ?? null,
      num_turns: usage.numTurns ?? null,
      session_id: sessionId ?? null,
      case_id: caseId ?? null,
    });
  } else {
    // Aggregate row (zero or multiple models)
    deps.insertUsageRecord({
      group_folder: groupFolder,
      category,
      source,
      auth_mode: authMode,
      model: models.length > 0 ? models.join(',') : null,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_create_tokens: usage.cacheCreateTokens,
      cost_usd: usage.totalCostUsd,
      duration_ms: usage.durationMs ?? null,
      duration_api_ms: usage.durationApiMs ?? null,
      num_turns: usage.numTurns ?? null,
      session_id: sessionId ?? null,
      case_id: caseId ?? null,
    });
  }

  // Update case cost/time when running in case context
  if (caseId) {
    if (usage.totalCostUsd > 0) {
      deps.addCaseCost(caseId, usage.totalCostUsd);
    }
    if (usage.durationMs) {
      deps.addCaseTime(caseId, usage.durationMs);
    }
  }
}
