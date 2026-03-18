/**
 * Escalation mutation hook — registers with the case mutation system
 * to dispatch notifications when cases with escalation data are created.
 *
 * This module is designed to work with the registerCaseMutationHook system
 * from PR #89 (case-sync). It provides a secondary notification path:
 * the IPC handler computes priority and dispatches initial notifications,
 * and this hook can handle post-insertion side effects.
 *
 * Wiring (in index.ts):
 *   import { registerEscalationHook } from './escalation-hook.js';
 *   registerEscalationHook(deps);
 */

import type { Case } from './cases.js';
import { logger } from './logger.js';

/**
 * Called after a case is inserted or updated.
 * Logs escalation-relevant mutations for observability.
 * Primary notification dispatch happens in the IPC handler (synchronous with case creation).
 */
export function onCaseEscalationEvent(
  event: 'inserted' | 'updated',
  c: Case,
  changes?: Partial<Case>,
): void {
  // Log when a case is created with escalation data
  if (event === 'inserted' && c.priority && c.gap_type) {
    logger.info(
      {
        caseId: c.id,
        name: c.name,
        priority: c.priority,
        gapType: c.gap_type,
        status: c.status,
      },
      'Case with escalation data inserted',
    );
  }

  // Log when priority changes on an existing case
  if (event === 'updated' && changes?.priority) {
    logger.info(
      {
        caseId: c.id,
        name: c.name,
        newPriority: changes.priority,
        oldPriority: c.priority,
      },
      'Case escalation priority updated',
    );
  }
}
