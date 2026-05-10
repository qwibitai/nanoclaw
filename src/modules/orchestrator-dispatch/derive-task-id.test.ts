import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { computeRequestHash, deriveDispatchTaskId } from './derive-task-id.js';

describe('deriveDispatchTaskId', () => {
  it('test_task_id_deterministic: returns same value on repeated calls', () => {
    const r1 = deriveDispatchTaskId('s1', 'k1');
    const r2 = deriveDispatchTaskId('s1', 'k1');
    const r3 = deriveDispatchTaskId('s1', 'k1');
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('starts with dispatch- prefix and has total length 25', () => {
    const id = deriveDispatchTaskId('s1', 'k1');
    expect(id.startsWith('dispatch-')).toBe(true);
    // 'dispatch-' (9) + 16 hex chars = 25
    expect(id.length).toBe(25);
  });

  it('test_task_id_namespace_distinct: different parent_session_id → different task_id', () => {
    const id1 = deriveDispatchTaskId('s1', 'k');
    const id2 = deriveDispatchTaskId('s2', 'k');
    expect(id1).not.toBe(id2);
  });

  it('produces expected sha256-based value (length-prefix canonicalization)', () => {
    // Length-prefix canonicalization: sha256(`${parentSessionId.length}:${parentSessionId}${idempotencyKey.length}:${idempotencyKey}`)
    // — see derive-task-id.ts (length-prefix prevents colon-collision attacks)
    const canonical = `${'s1'.length}:s1${'k1'.length}:k1`;
    const expected = 'dispatch-' + createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    expect(deriveDispatchTaskId('s1', 'k1')).toBe(expected);
  });

  it('test_id_colon_collision_resistance: parentSessionId="A:B"+key="C" differs from parentSessionId="A"+key="B:C"', () => {
    // Without length-prefix, both inputs would hash 'A:B:C' identically. With
    // length-prefix, they hash distinctly. Critical for security: idempotency_key
    // is user-supplied and may legitimately contain ':'.
    const id1 = deriveDispatchTaskId('A:B', 'C');
    const id2 = deriveDispatchTaskId('A', 'B:C');
    expect(id1).not.toBe(id2);
  });
});

describe('computeRequestHash', () => {
  it('test_request_hash_length_prefix_no_collide: A/B:C, A/B/C:, A:B/C all distinct', () => {
    const h1 = computeRequestHash('A', 'B:C', '');
    const h2 = computeRequestHash('A', 'B', 'C:');
    const h3 = computeRequestHash('A:B', 'C', '');
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });

  it('test_request_hash_deadline_null_vs_empty: null and empty string produce same hash', () => {
    const hNull = computeRequestHash('A', 'B', null);
    const hEmpty = computeRequestHash('A', 'B', '');
    expect(hNull).toBe(hEmpty);
  });

  it('undefined deadline treated as empty string', () => {
    const hUndef = computeRequestHash('A', 'B');
    const hEmpty = computeRequestHash('A', 'B', '');
    expect(hUndef).toBe(hEmpty);
  });

  it('is deterministic', () => {
    const h1 = computeRequestHash('target', 'do something', '2026-05-10T00:00:00Z');
    const h2 = computeRequestHash('target', 'do something', '2026-05-10T00:00:00Z');
    expect(h1).toBe(h2);
  });
});

describe('F2 fixture generation', () => {
  it('writes dispatch-task-id-vectors.json fixture for cross-runtime F2 contract test', () => {
    const vectors = [
      { parent_session_id: 's1', idempotency_key: 'k1', expected_task_id: deriveDispatchTaskId('s1', 'k1') },
      { parent_session_id: 's2', idempotency_key: 'k1', expected_task_id: deriveDispatchTaskId('s2', 'k1') },
      {
        parent_session_id: 'session-abc-123',
        idempotency_key: 'my-unique-key',
        expected_task_id: deriveDispatchTaskId('session-abc-123', 'my-unique-key'),
      },
      {
        parent_session_id: 'session-abc-123',
        idempotency_key: 'key:with:colons',
        expected_task_id: deriveDispatchTaskId('session-abc-123', 'key:with:colons'),
      },
    ];

    writeFileSync('tests/fixtures/dispatch-task-id-vectors.json', JSON.stringify(vectors, null, 2) + '\n');

    // Verify each vector matches
    for (const v of vectors) {
      expect(deriveDispatchTaskId(v.parent_session_id, v.idempotency_key)).toBe(v.expected_task_id);
      expect(v.expected_task_id.startsWith('dispatch-')).toBe(true);
      expect(v.expected_task_id.length).toBe(25);
    }
  });
});
