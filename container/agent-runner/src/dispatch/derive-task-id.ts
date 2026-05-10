/**
 * Container-side spawn task ID derivation.
 *
 * IDENTICAL algorithm to host's src/modules/orchestrator-dispatch/derive-task-id.ts.
 * Must NOT import from host — host is Node, container is Bun (separate package trees).
 * Synchronization is via F2 contract test against tests/fixtures/spawn-task-id-vectors.json.
 *
 * Length-prefix canonicalization (per design S23) prevents colon-collision attacks
 * where 'foo:bar' vs 'foo' + ':bar' would otherwise hash identically. Idempotency
 * keys are user-supplied (orchestrator agent chooses them) and may legitimately
 * contain ':' — without length-prefix, a key like 'X:Y' could collide with another
 * orchestrator's parent_session_id ending in 'X' + key 'Y'.
 */
import { createHash } from 'crypto';

export function deriveSpawnTaskId(parentSessionId: string, idempotencyKey: string): string {
  const canonical = `${parentSessionId.length}:${parentSessionId}${idempotencyKey.length}:${idempotencyKey}`;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `spawn-${hash}`;
}

export function computeRequestHash(content: string, deadline?: string | null): string {
  const d = deadline ?? '';
  const canonical = `${content.length}:${content}` + `${d.length}:${d}`;
  return createHash('sha256').update(canonical).digest('hex');
}
