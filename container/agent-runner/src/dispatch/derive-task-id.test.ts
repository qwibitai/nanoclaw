/**
 * Tests for container-side deriveDispatchTaskId.
 *
 * Contract: must produce identical output to the host's implementation
 * (src/modules/orchestrator-dispatch/derive-task-id.ts) for the same inputs.
 * Verified by comparing against the F2 fixture file at
 * tests/fixtures/dispatch-task-id-vectors.json.
 */
import { describe, it, expect } from 'bun:test';
import { deriveDispatchTaskId, computeRequestHash } from './derive-task-id.js';
import vectors from '../../../../tests/fixtures/dispatch-task-id-vectors.json';

describe('deriveDispatchTaskId', () => {
  it('test_returns_string_with_dispatch_prefix', () => {
    const result = deriveDispatchTaskId('sess-abc', 'k-1');
    expect(result).toBeString();
    expect(result.startsWith('dispatch-')).toBe(true);
  });

  it('test_returns_16_char_hex_suffix', () => {
    const result = deriveDispatchTaskId('sess-abc', 'k-1');
    const suffix = result.slice('dispatch-'.length);
    expect(suffix).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(suffix)).toBe(true);
  });

  it('test_task_id_namespace_distinct: different parent_session_id → different task_id', () => {
    const a = deriveDispatchTaskId('sess-1', 'key');
    const b = deriveDispatchTaskId('sess-2', 'key');
    expect(a).not.toBe(b);
  });

  it('test_idempotency_distinct: same parent, different key → different task_id', () => {
    const a = deriveDispatchTaskId('sess-1', 'key-a');
    const b = deriveDispatchTaskId('sess-1', 'key-b');
    expect(a).not.toBe(b);
  });

  it('test_deterministic: same inputs → same output', () => {
    const a = deriveDispatchTaskId('sess-abc', 'my-key');
    const b = deriveDispatchTaskId('sess-abc', 'my-key');
    expect(a).toBe(b);
  });

  it('test_fixed_vector_matches_host: verify against B1 pre-computed vectors (F2 contract)', () => {
    for (const v of vectors) {
      const result = deriveDispatchTaskId(v.parent_session_id, v.idempotency_key);
      expect(result).toBe(v.expected_task_id);
    }
  });
});

describe('computeRequestHash', () => {
  it('test_returns_64_char_hex', () => {
    const hash = computeRequestHash('group-1', 'some content');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('test_deterministic: same inputs → same hash', () => {
    const a = computeRequestHash('g', 'c', 'deadline');
    const b = computeRequestHash('g', 'c', 'deadline');
    expect(a).toBe(b);
  });

  it('test_deadline_optional: undefined and null produce same hash', () => {
    const a = computeRequestHash('g', 'c', undefined);
    const b = computeRequestHash('g', 'c', null);
    expect(a).toBe(b);
  });

  it('test_colon_collision_resistance: structurally different inputs → different hashes', () => {
    // Without length-prefixing, 'fo:obar' and 'foo' + ':bar' would collide.
    const a = computeRequestHash('fo', 'obar');
    const b = computeRequestHash('foo', 'bar');
    expect(a).not.toBe(b);
  });
});
