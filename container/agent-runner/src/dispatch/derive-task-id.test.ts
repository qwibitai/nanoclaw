/**
 * Tests for container-side deriveSpawnTaskId.
 *
 * Contract: must produce identical output to the host's implementation
 * (src/modules/orchestrator-dispatch/derive-task-id.ts) for the same inputs.
 * Verified by comparing against the F2 fixture file at
 * tests/fixtures/spawn-task-id-vectors.json.
 */
import { describe, it, expect } from 'bun:test';
import { deriveSpawnTaskId, computeRequestHash } from './derive-task-id.js';
import vectors from '../../../../tests/fixtures/spawn-task-id-vectors.json';

describe('deriveSpawnTaskId', () => {
  it('test_returns_string_with_spawn_prefix', () => {
    const result = deriveSpawnTaskId('sess-abc', 'k-1');
    expect(result).toBeString();
    expect(result.startsWith('spawn-')).toBe(true);
  });

  it('test_returns_16_char_hex_suffix', () => {
    const result = deriveSpawnTaskId('sess-abc', 'k-1');
    const suffix = result.slice('spawn-'.length);
    expect(suffix).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(suffix)).toBe(true);
  });

  it('test_task_id_namespace_distinct: different parent_session_id → different task_id', () => {
    const a = deriveSpawnTaskId('sess-1', 'key');
    const b = deriveSpawnTaskId('sess-2', 'key');
    expect(a).not.toBe(b);
  });

  it('test_idempotency_distinct: same parent, different key → different task_id', () => {
    const a = deriveSpawnTaskId('sess-1', 'key-a');
    const b = deriveSpawnTaskId('sess-1', 'key-b');
    expect(a).not.toBe(b);
  });

  it('test_deterministic: same inputs → same output', () => {
    const a = deriveSpawnTaskId('sess-abc', 'my-key');
    const b = deriveSpawnTaskId('sess-abc', 'my-key');
    expect(a).toBe(b);
  });

  it('test_fixed_vector_matches_host: verify against pre-computed vectors (F2 contract)', () => {
    for (const v of vectors) {
      const result = deriveSpawnTaskId(v.parent_session_id, v.idempotency_key);
      expect(result).toBe(v.expected_task_id);
    }
  });
});

describe('computeRequestHash', () => {
  it('test_returns_64_char_hex', () => {
    const hash = computeRequestHash('some content');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('test_deterministic: same inputs → same hash', () => {
    const a = computeRequestHash('c', 'deadline');
    const b = computeRequestHash('c', 'deadline');
    expect(a).toBe(b);
  });

  it('test_deadline_optional: undefined and null produce same hash', () => {
    const a = computeRequestHash('c', undefined);
    const b = computeRequestHash('c', null);
    expect(a).toBe(b);
  });

  it('test_colon_collision_resistance: structurally different inputs → different hashes', () => {
    // Without length-prefixing, 'fo:obar' (1 part) and 'foobar' (concat) would collide.
    const a = computeRequestHash('fo:obar');
    const b = computeRequestHash('foobar');
    expect(a).not.toBe(b);
  });
});
