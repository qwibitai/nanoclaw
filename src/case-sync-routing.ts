import type { Case } from './cases.js';
import type { CaseSyncEventType } from './case-backend.js';

/** Fields that change frequently but don't warrant a cloud sync. */
const NOISE_FIELDS = new Set([
  'last_message',
  'last_activity_at',
  'total_cost_usd',
  'time_spent_ms',
  'github_issue',
  'github_issue_url',
]);

/**
 * Classify a case mutation event into the appropriate sync event type.
 * Returns null if the mutation is noise (frequent updates that shouldn't trigger sync).
 */
export function classifyCaseMutation(
  event: 'inserted' | 'updated',
  _c: Case,
  changes?: Partial<Case>,
): CaseSyncEventType | null {
  if (event === 'inserted') return 'created';

  if (changes?.status === 'done') return 'done';
  if (changes?.status) return 'status_changed';

  if (changes && Object.keys(changes).some((k) => !NOISE_FIELDS.has(k))) {
    return 'updated';
  }

  return null;
}
