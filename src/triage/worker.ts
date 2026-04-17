import { logger } from '../logger.js';
import { getDb } from '../db.js';
import { shouldSkip } from './prefilter.js';
import { classifyWithLlm } from './classifier.js';
import { emitTrace } from './traces.js';
import { enforceCostCap } from './cost-cap.js';
import { TRIAGE_DEFAULTS } from './config.js';
import type { TriageDecision } from './schema.js';

export interface TriageWorkerInput {
  trackedItemId: string;
  emailBody: string;
  sender: string;
  subject: string;
  superpilotLabel: string | null;
  threadId: string;
  account: string;
  shadowMode?: boolean;
}

export type TriageOutcome =
  | { outcome: 'skipped'; reason: string }
  | {
      outcome: 'classified';
      decision: TriageDecision;
      tier: 1 | 2 | 3;
      shadowMode: boolean;
    }
  | { outcome: 'error'; reason: string };

export async function triageEmail(
  input: TriageWorkerInput,
): Promise<TriageOutcome> {
  const shadowMode = input.shadowMode ?? TRIAGE_DEFAULTS.shadowMode;

  const pre = shouldSkip({
    superpilotLabel: input.superpilotLabel,
    sender: input.sender,
  });
  if (pre.skip) {
    logger.info(
      { trackedItemId: input.trackedItemId, reason: pre.reason },
      'Triage worker: prefilter skip',
    );
    return { outcome: 'skipped', reason: pre.reason };
  }

  try {
    enforceCostCap(TRIAGE_DEFAULTS.dailyCostCapUsd);
  } catch (err) {
    logger.error({ err: String(err) }, 'Triage worker: cost cap hit');
    return { outcome: 'error', reason: String(err) };
  }

  const start = Date.now();
  let result: Awaited<ReturnType<typeof classifyWithLlm>>;
  try {
    result = await classifyWithLlm({
      emailBody: input.emailBody,
      sender: input.sender,
      subject: input.subject,
      superpilotLabel: input.superpilotLabel,
      threadId: input.threadId,
      account: input.account,
    });
  } catch (err) {
    logger.error(
      { trackedItemId: input.trackedItemId, err: String(err) },
      'Triage worker: classifier failed',
    );
    emitTrace({
      trackedItemId: input.trackedItemId,
      tier: 1,
      latencyMs: Date.now() - start,
      queue: 'error',
      confidence: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      error: String(err),
      shadowMode,
    });
    return { outcome: 'error', reason: String(err) };
  }

  const latencyMs = Date.now() - start;
  emitTrace({
    trackedItemId: input.trackedItemId,
    tier: result.tier,
    latencyMs,
    queue: result.decision.queue,
    confidence: result.decision.confidence,
    cacheReadTokens: result.usage.cacheReadTokens,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    shadowMode,
  });

  // Persist triage decision to tracked_items (shadow-safe: DB writes are fine).
  getDb()
    .prepare(
      `UPDATE tracked_items SET
         confidence = ?,
         model_tier = ?,
         action_intent = ?,
         facts_extracted_json = ?,
         repo_candidates_json = ?,
         reasons_json = ?
       WHERE id = ?`,
    )
    .run(
      result.decision.confidence,
      result.tier,
      result.decision.action_intent ?? null,
      JSON.stringify(result.decision.facts_extracted),
      JSON.stringify(result.decision.repo_candidates),
      JSON.stringify(result.decision.reasons),
      input.trackedItemId,
    );

  if (!shadowMode && result.decision.queue === 'attention') {
    const chatId = process.env.EMAIL_INTEL_TG_CHAT_ID;
    if (chatId) {
      try {
        const { pushAttentionItem } = await import('./push-attention.js');
        await pushAttentionItem({
          chatId,
          itemId: input.trackedItemId,
          title: input.subject || '(no subject)',
          reason:
            result.decision.attention_reason ??
            result.decision.reasons[0] ??
            '(no reason)',
          sender: input.sender,
        });
        const { renderAttentionDashboard } = await import('./dashboards.js');
        const { getOpenAttentionItems } = await import('../tracked-items.js');
        const open = getOpenAttentionItems('main');
        await renderAttentionDashboard({
          chatId,
          items: open.map((it) => ({
            id: it.id,
            title: it.title,
            reason: (it.reasons && it.reasons[0]) ?? '(no reason)',
            ageMins: Math.round((Date.now() - it.detected_at) / 60_000),
          })),
        });
      } catch (err) {
        logger.warn(
          { err: String(err), itemId: input.trackedItemId },
          'Triage: failed to push+render attention',
        );
      }
    }
  }

  return {
    outcome: 'classified',
    decision: result.decision,
    tier: result.tier,
    shadowMode,
  };
}
