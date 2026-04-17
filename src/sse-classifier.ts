import { classify } from './classification.js';
import { eventBus } from './event-bus.js';
import { logger } from './logger.js';
import {
  getTrackedItemBySourceId,
  insertTrackedItem,
  updateDigestState,
  getDigestState,
} from './tracked-items.js';
import type { ItemClassifiedEvent } from './events.js';
import { triageEmail } from './triage/worker.js';
import { TRIAGE_DEFAULTS } from './triage/config.js';

export interface SSEEmail {
  thread_id: string;
  account: string;
  subject?: string;
  sender?: string;
  superpilot_label?: string;
}

export interface ClassifyResult {
  itemId: string;
  threadId: string;
  decision: 'push' | 'digest' | 'resolved';
  subject: string;
  sender: string;
}

export function classifyFromSSE(
  emails: SSEEmail[],
  groupName: string = 'main',
): ClassifyResult[] {
  const results: ClassifyResult[] = [];

  for (const email of emails) {
    const sourceId = `gmail:${email.thread_id}`;
    const existing = getTrackedItemBySourceId('gmail', sourceId);
    if (existing) {
      logger.debug(
        { threadId: email.thread_id },
        'SSE: already tracked, skipping',
      );
      continue;
    }

    const subject = email.subject || '(no subject)';
    const sender = email.sender || 'unknown';

    const result = classify({
      source: 'gmail',
      sourceId,
      superpilotLabel: email.superpilot_label ?? null,
      trustTier: null,
      senderPattern: sender,
      title: subject,
      summary: null,
      userActed: false,
      metadata: { account: email.account, threadId: email.thread_id },
    });

    const itemId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    insertTrackedItem({
      id: itemId,
      source: 'gmail',
      source_id: sourceId,
      group_name: groupName,
      state: result.decision === 'push' ? 'pending' : 'queued',
      classification: result.decision,
      superpilot_label: email.superpilot_label ?? null,
      trust_tier: null,
      title: subject,
      summary: null,
      thread_id: email.thread_id,
      detected_at: now,
      pushed_at: result.decision === 'push' ? now : null,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: result.reason,
      metadata: { account: email.account, sender },
      confidence: null,
      model_tier: null,
      action_intent: null,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    });

    if (result.decision === 'digest') {
      const state = getDigestState(groupName);
      updateDigestState(groupName, { queued_count: state.queued_count + 1 });
    }

    const event: ItemClassifiedEvent = {
      type: 'item.classified',
      source: 'sse-classifier',
      timestamp: now,
      payload: {
        itemId,
        decision: result.decision,
        source: 'gmail',
        reason: result.reason as unknown as Record<string, unknown>,
      },
    };
    eventBus.emit('item.classified', event);

    if (TRIAGE_DEFAULTS.enabled) {
      // Fire-and-forget. Errors are logged inside triageEmail; this catch is a
      // belt-and-suspenders guard so triage failures never crash the classifier.
      void triageEmail({
        trackedItemId: itemId,
        emailBody: email.subject || '',
        sender,
        subject,
        superpilotLabel: email.superpilot_label ?? null,
        threadId: email.thread_id,
        account: email.account,
      }).catch((err) => {
        logger.warn(
          { err: String(err), itemId },
          'Triage worker error (async)',
        );
      });
    }

    results.push({
      itemId,
      threadId: email.thread_id,
      decision: result.decision,
      subject,
      sender,
    });

    logger.info(
      { threadId: email.thread_id, decision: result.decision, itemId },
      'SSE email classified inline',
    );
  }

  return results;
}
