/**
 * F2 — Cross-process deriveSpawnTaskId contract test.
 *
 * Verifies that the container-side implementation produces bit-identical output
 * to the host-side implementation for all vectors in the shared fixture file.
 * This is the primary guard against host/container hash divergence.
 *
 * Test runner: bun:test
 * Run: cd container/agent-runner && bun test src/dispatch/derive-task-id-contract.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deriveSpawnTaskId, computeRequestHash } from './derive-task-id.js';

interface TaskIdVector {
  parent_session_id: string;
  idempotency_key: string;
  expected_task_id: string;
}

// Path from container/agent-runner/src/dispatch/ → repo root tests/fixtures/
const FIXTURE_PATH = resolve(__dirname, '../../../../tests/fixtures/spawn-task-id-vectors.json');

function loadVectors(): TaskIdVector[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw) as TaskIdVector[];
}

describe('F2: cross-process deriveSpawnTaskId contract', () => {
  it('test_contract_matches_host_vectors: container output matches all fixture vectors', () => {
    const vectors = loadVectors();

    expect(vectors.length).toBeGreaterThanOrEqual(4);

    for (const v of vectors) {
      const result = deriveSpawnTaskId(v.parent_session_id, v.idempotency_key);
      expect(result).toBe(v.expected_task_id);
    }
  });

  it('test_fixture_format_valid: all vectors have required fields and expected_task_id format', () => {
    const vectors = loadVectors();

    for (const v of vectors) {
      expect(typeof v.parent_session_id).toBe('string');
      expect(typeof v.idempotency_key).toBe('string');
      expect(typeof v.expected_task_id).toBe('string');
      expect(v.expected_task_id.startsWith('spawn-')).toBe(true);
      // 'spawn-' (6) + 16 hex chars = 22
      expect(v.expected_task_id.length).toBe(22);
    }
  });
});

describe('F2: computeRequestHash collision resistance contract', () => {
  it('test_request_hash_collision_vectors: length-prefix prevents colon-split collisions', () => {
    // These three inputs are structurally different but would collide without length-prefixing:
    //   ('B:C', '')  → "3:B:C0:"
    //   ('B', 'C:')  → "1:B2:C:"
    //   ('BC', '')   → "2:BC0:"
    // All three canonical strings are distinct, so the hashes must differ.
    const h1 = computeRequestHash('B:C', '');
    const h2 = computeRequestHash('B', 'C:');
    const h3 = computeRequestHash('BC', '');

    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });

  it('test_request_hash_null_empty_equivalent: null and empty deadline produce same hash', () => {
    const hNull = computeRequestHash('content-y', null);
    const hEmpty = computeRequestHash('content-y', '');
    expect(hNull).toBe(hEmpty);
  });

  it('test_request_hash_undefined_deadline: undefined treated as empty string', () => {
    const hUndef = computeRequestHash('content-y', undefined);
    const hEmpty = computeRequestHash('content-y', '');
    expect(hUndef).toBe(hEmpty);
  });

  it('test_request_hash_deterministic: same inputs produce same hash across calls', () => {
    const h1 = computeRequestHash('do something', '2026-05-10T00:00:00Z');
    const h2 = computeRequestHash('do something', '2026-05-10T00:00:00Z');
    expect(h1).toBe(h2);
  });

  it('test_request_hash_64_char_hex: output is a full SHA-256 hex string', () => {
    const hash = computeRequestHash('content');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });
});
