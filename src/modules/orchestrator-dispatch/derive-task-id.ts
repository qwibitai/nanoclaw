import { createHash } from 'crypto';

/**
 * Length-prefix canonicalization for both task_id and request_hash, per design S23.
 * Prevents colon-collision attacks where 'foo:bar' vs 'foo' + ':bar' would otherwise
 * hash identically. Matches RFC-8785 / AWS-SigV4 canonicalization guidance.
 *
 * Critical: idempotency_key is user-supplied (orchestrator agent chooses it). Without
 * length-prefix, a key containing ':' could collide with a different (parent_session_id,
 * idempotency_key) pair across orchestrators, causing wrong-task lookup in subsequent
 * applyDispatchComplete / applyDispatchCancel handlers.
 */
export function deriveDispatchTaskId(parentSessionId: string, idempotencyKey: string): string {
  const canonical = `${parentSessionId.length}:${parentSessionId}${idempotencyKey.length}:${idempotencyKey}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `dispatch-${hash}`;
}

export function computeRequestHash(targetGroup: string, content: string, deadline?: string | null): string {
  const d = deadline ?? '';
  const canonical =
    `${targetGroup.length}:${targetGroup}` +
    `${content.length}:${content}` +
    `${d.length}:${d}`;
  return createHash('sha256').update(canonical).digest('hex');
}
