import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { computeRequestHash, deriveSpawnTaskId } from './derive-task-id.js';

describe('deriveSpawnTaskId', () => {
  it('test_task_id_deterministic: returns same value on repeated calls', () => {
    const r1 = deriveSpawnTaskId('s1', 'k1');
    const r2 = deriveSpawnTaskId('s1', 'k1');
    const r3 = deriveSpawnTaskId('s1', 'k1');
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('starts with spawn- prefix and has total length 22', () => {
    const id = deriveSpawnTaskId('s1', 'k1');
    expect(id.startsWith('spawn-')).toBe(true);
    // 'spawn-' (6) + 16 hex chars = 22
    expect(id.length).toBe(22);
  });

  it('test_task_id_namespace_distinct: different parent_session_id → different task_id', () => {
    const id1 = deriveSpawnTaskId('s1', 'k');
    const id2 = deriveSpawnTaskId('s2', 'k');
    expect(id1).not.toBe(id2);
  });

  it('produces expected sha256-based value (length-prefix canonicalization)', () => {
    // Length-prefix canonicalization: sha256(`${parentSessionId.length}:${parentSessionId}${idempotencyKey.length}:${idempotencyKey}`)
    // — see derive-task-id.ts (length-prefix prevents colon-collision attacks)
    const canonical = `${'s1'.length}:s1${'k1'.length}:k1`;
    const expected = 'spawn-' + createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    expect(deriveSpawnTaskId('s1', 'k1')).toBe(expected);
  });

  it('test_id_colon_collision_resistance: parentSessionId="A:B"+key="C" differs from parentSessionId="A"+key="B:C"', () => {
    // Without length-prefix, both inputs would hash 'A:B:C' identically. With
    // length-prefix, they hash distinctly. Critical for security: idempotency_key
    // is user-supplied and may legitimately contain ':'.
    const id1 = deriveSpawnTaskId('A:B', 'C');
    const id2 = deriveSpawnTaskId('A', 'B:C');
    expect(id1).not.toBe(id2);
  });
});

describe('computeRequestHash', () => {
  it('test_request_hash_length_prefix_no_collide: B/C, B-empty/C, B:C-empty all distinct', () => {
    const h1 = computeRequestHash('B:C', '');
    const h2 = computeRequestHash('B', 'C:');
    const h3 = computeRequestHash('BC', '');
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });

  it('test_request_hash_deadline_null_vs_empty: null and empty string produce same hash', () => {
    const hNull = computeRequestHash('B', null);
    const hEmpty = computeRequestHash('B', '');
    expect(hNull).toBe(hEmpty);
  });

  it('undefined deadline treated as empty string', () => {
    const hUndef = computeRequestHash('B');
    const hEmpty = computeRequestHash('B', '');
    expect(hUndef).toBe(hEmpty);
  });

  it('is deterministic', () => {
    const h1 = computeRequestHash('do something', '2026-05-10T00:00:00Z');
    const h2 = computeRequestHash('do something', '2026-05-10T00:00:00Z');
    expect(h1).toBe(h2);
  });
});

describe('F2 fixture generation', () => {
  it('writes spawn-task-id-vectors.json fixture for cross-runtime F2 contract test', () => {
    const vectors = [
      { parent_session_id: 's1', idempotency_key: 'k1', expected_task_id: deriveSpawnTaskId('s1', 'k1') },
      { parent_session_id: 's2', idempotency_key: 'k1', expected_task_id: deriveSpawnTaskId('s2', 'k1') },
      {
        parent_session_id: 'session-abc-123',
        idempotency_key: 'my-unique-key',
        expected_task_id: deriveSpawnTaskId('session-abc-123', 'my-unique-key'),
      },
      {
        parent_session_id: 'session-abc-123',
        idempotency_key: 'key:with:colons',
        expected_task_id: deriveSpawnTaskId('session-abc-123', 'key:with:colons'),
      },
    ];

    writeFileSync('tests/fixtures/spawn-task-id-vectors.json', JSON.stringify(vectors, null, 2) + '\n');

    // Verify each vector matches
    for (const v of vectors) {
      expect(deriveSpawnTaskId(v.parent_session_id, v.idempotency_key)).toBe(v.expected_task_id);
      expect(v.expected_task_id.startsWith('spawn-')).toBe(true);
      expect(v.expected_task_id.length).toBe(22);
    }
  });
});
