import path from 'path';
import { logger } from '../logger.js';
import { getDb } from '../db.js';
import { readEnvValue } from '../env.js';
import { shouldSkip } from './prefilter.js';
import { classifyWithLlm } from './classifier.js';
import { emitTrace } from './traces.js';
import { reserveAndEnforceCostCap, estimateCostUsd } from './cost-cap.js';
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

  // Reserve a pessimistic cost upfront (assume worst case: escalation through
  // all three tiers). This prevents a burst of concurrent fire-and-forget
  // classifier calls from collectively blowing the cap before any of them
  // have written a trace line.
  const pessimisticEstimate =
    estimateCostUsd(1, 12_000, 500, 10_000) +
    estimateCostUsd(2, 12_000, 500, 10_000) +
    estimateCostUsd(3, 12_000, 500, 10_000);
  let reservation: ReturnType<typeof reserveAndEnforceCostCap>;
  try {
    reservation = reserveAndEnforceCostCap(
      TRIAGE_DEFAULTS.dailyCostCapUsd,
      pessimisticEstimate,
    );
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
    reservation.settle(0);
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
  // Trace is authoritative for persisted cost; release the reservation so
  // later calls don't count this one twice.
  reservation.settle(
    estimateCostUsd(
      result.tier,
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.cacheReadTokens,
    ),
  );
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
  // State transitions:
  //   queue='ignore'             -> resolved immediately (user never sees it)
  //   queue='attention'          -> left 'queued' here; push-side below
  //                                 marks 'pushed' on successful send
  //   queue='archive_candidate'  -> left 'queued' so it shows in archive queue
  //   queue='action'             -> left 'queued' (needs user action; surface
  //                                 in attention queue via the fallback)
  const shouldAutoResolve = result.decision.queue === 'ignore';
  getDb()
    .prepare(
      `UPDATE tracked_items SET
         confidence = ?,
         model_tier = ?,
         action_intent = ?,
         facts_extracted_json = ?,
         repo_candidates_json = ?,
         reasons_json = ?,
         queue = ?,
         state = CASE WHEN ? = 1 THEN 'resolved' ELSE state END,
         resolution_method = CASE WHEN ? = 1 THEN 'classifier:ignore' ELSE resolution_method END,
         resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END
       WHERE id = ?`,
    )
    .run(
      result.decision.confidence,
      result.tier,
      result.decision.action_intent ?? null,
      JSON.stringify(result.decision.facts_extracted),
      JSON.stringify(result.decision.repo_candidates),
      JSON.stringify(result.decision.reasons),
      result.decision.queue ?? null,
      shouldAutoResolve ? 1 : 0,
      shouldAutoResolve ? 1 : 0,
      shouldAutoResolve ? 1 : 0,
      Date.now(),
      input.trackedItemId,
    );

  if (!shadowMode && result.decision.facts_extracted.length > 0) {
    try {
      const { appendExtractedFacts } = await import('./knowledge-append.js');
      await appendExtractedFacts({
        groupsRoot: path.resolve(process.cwd(), 'groups'),
        groupName: 'email-intel',
        threadId: input.threadId,
        account: input.account,
        classificationId: input.trackedItemId,
        subject: input.subject,
        sender: input.sender,
        facts: result.decision.facts_extracted,
      });
    } catch (err) {
      logger.warn(
        { err: String(err), itemId: input.trackedItemId },
        'Triage: appendExtractedFacts failed',
      );
    }
  }

  if (!shadowMode && result.decision.queue === 'attention') {
    const chatId = readEnvValue('EMAIL_INTEL_TG_CHAT_ID');
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
        // Mark pushed so dashboards + invariants know this item was
        // surfaced to the user. Before, the state stayed 'queued' forever
        // even after a successful push, and attention-queue rows looked
        // indistinguishable from unpushed work.
        getDb()
          .prepare(
            `UPDATE tracked_items
             SET state = 'pushed', pushed_at = ?
             WHERE id = ? AND state = 'queued'`,
          )
          .run(Date.now(), input.trackedItemId);
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
