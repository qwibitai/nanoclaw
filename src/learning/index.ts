import type { EventBus } from '../event-bus.js';
import { logger } from '../logger.js';
import { queryOutcomes } from '../memory/outcome-store.js';
import type { RegisteredGroup } from '../types.js';
import { buildRulesBlock } from './outcome-enricher.js';
import {
  addTrace,
  finalizeTrace,
  pruneOrphanedTraces,
  startTrace,
} from './procedure-recorder.js';
import {
  addRule,
  decayConfidence,
  initRulesStore,
  pruneStaleRules,
  queryRules,
} from './rules-engine.js';

export interface LearningDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  sendMessage: (jid: string, text: string) => Promise<void>;
  enqueueTask: (jid: string, taskId: string, fn: () => Promise<void>) => void;
}

const lastBotMessageTs: Record<string, number> = {};

export { addTrace, buildRulesBlock };

export function initLearningSystem(bus: EventBus, deps: LearningDeps): void {
  initRulesStore();
  logger.info('Learning system initialized');

  bus.on('task.started', (event) => {
    const groupId = event.groupId ?? event.payload.groupJid;
    const taskId = event.payload.taskId;
    startTrace(groupId, taskId);
  });

  bus.on('task.complete', (event) => {
    const groupId = event.groupId ?? event.payload.groupJid;
    const taskId = event.payload.taskId;
    const success = event.payload.status === 'success';

    finalizeTrace(groupId, taskId, success);

    if (success) {
      analyzeOutcomePatterns(groupId);
    }
  });

  // Feedback capture: relies on IPC learn_feedback path since message.inbound
  // payload doesn't carry raw message text. Event bus subscription omitted.

  bus.on('message.outbound', (event) => {
    const groupId = event.groupId ?? event.payload.chatJid;
    lastBotMessageTs[groupId] = Date.now();
  });

  setInterval(
    () => {
      const pruned = pruneStaleRules();
      const decayed = decayConfidence();
      if (pruned > 0 || decayed > 0) {
        logger.info({ pruned, decayed }, 'Learning maintenance run');
      }
    },
    24 * 60 * 60 * 1000,
  );

  // Prune orphaned trace buffers every 15 minutes
  setInterval(
    () => {
      const pruned = pruneOrphanedTraces();
      if (pruned > 0) {
        logger.debug({ pruned }, 'Pruned orphaned traces');
      }
    },
    15 * 60 * 1000,
  );
}

function analyzeOutcomePatterns(groupId: string): void {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const outcomes = queryOutcomes({
    groupId,
    since: sevenDaysAgo,
    limit: 100,
  });

  const failuresByClass: Record<string, { errors: string[]; count: number }> =
    {};
  for (const o of outcomes) {
    if (o.result === 'failure' && o.error) {
      if (!failuresByClass[o.action_class]) {
        failuresByClass[o.action_class] = { errors: [], count: 0 };
      }
      failuresByClass[o.action_class].errors.push(o.error);
      failuresByClass[o.action_class].count++;
    }
  }

  for (const [actionClass, data] of Object.entries(failuresByClass)) {
    if (data.count < 2) continue;

    const existing = queryRules([actionClass], groupId, 10);
    const hasExisting = existing.some(
      (r) => r.source === 'outcome_pattern' && r.rule.includes(actionClass),
    );
    if (hasExisting) continue;

    const topError = data.errors[0].slice(0, 120);
    const rule = `Recurring failure in ${actionClass}: ${topError}`;
    const confidence = Math.min(0.8, 0.5 + (data.count - 2) * 0.1);

    addRule({
      rule,
      source: 'outcome_pattern',
      actionClasses: [actionClass],
      groupId,
      confidence,
      evidenceCount: data.count,
    });

    logger.debug(
      { actionClass, count: data.count, groupId },
      'Outcome pattern rule created',
    );
  }
}
