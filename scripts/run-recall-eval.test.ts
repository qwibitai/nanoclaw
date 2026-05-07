/**
 * Tests for run-recall-eval.ts (E2).
 * TDD: write tests before implementation (RED → GREEN).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { EvalEntry } from './regenerate-recall-eval.js';
import { runEvalForStrategy, setMnemonRecallForTest, _resetMnemonRecallForTest } from './run-recall-eval.js';

function makeEntry(factId: string, query: string, content: string): EvalEntry {
  return {
    fact_id: factId,
    agent_group_id: 'g1',
    expected_query: query,
    expected_fact_content: content,
    source: 'synthesized',
  };
}

beforeEach(() => {
  _resetMnemonRecallForTest();
});

describe('runEvalForStrategy — recall@K and MRR', () => {
  it('computes recall@5 and recall@10 correctly', async () => {
    // entry1 found at rank 2 (index 1), entry2 at rank 8 (index 7), entry3 not found
    const entries = [
      makeEntry('f1', 'query1', 'content1'),
      makeEntry('f2', 'query2', 'content2'),
      makeEntry('f3', 'query3', 'content3'),
    ];

    setMnemonRecallForTest(async (agentGroupId, query) => {
      if (query === 'query1' || query.includes('content1') || query.includes('query1')) {
        // f1 at rank 2 (index 1)
        return [
          { id: 'other1', content: 'other content 1' },
          { id: 'f1', content: 'content1' },
          { id: 'other2', content: 'other content 2' },
        ];
      }
      if (query === 'query2' || query.includes('content2') || query.includes('query2')) {
        // f2 at rank 8 (index 7) — build a list of 10 with f2 at position 7
        return [
          { id: 'o1', content: 'x' },
          { id: 'o2', content: 'x' },
          { id: 'o3', content: 'x' },
          { id: 'o4', content: 'x' },
          { id: 'o5', content: 'x' },
          { id: 'o6', content: 'x' },
          { id: 'o7', content: 'x' },
          { id: 'f2', content: 'content2' },
          { id: 'o8', content: 'x' },
          { id: 'o9', content: 'x' },
        ];
      }
      // entry3: not found
      return [];
    });

    const result = await runEvalForStrategy(entries, 'raw');
    // recall@5: only f1 is in top-5 → 1/3
    expect(result.recall_at_5).toBeCloseTo(1 / 3, 5);
    // recall@10: f1 (rank 2) + f2 (rank 8) → 2/3
    expect(result.recall_at_10).toBeCloseTo(2 / 3, 5);
    expect(result.total_entries).toBe(3);
  });

  it('computes MRR correctly', async () => {
    const entries = [
      makeEntry('f1', 'query1', 'content1'),
      makeEntry('f2', 'query2', 'content2'),
      makeEntry('f3', 'query3', 'content3'),
    ];

    setMnemonRecallForTest(async (agentGroupId, query) => {
      if (query.includes('query1')) {
        // f1 at rank 1
        return [{ id: 'f1', content: 'content1' }];
      }
      if (query.includes('query2')) {
        // f2 at rank 4
        return [
          { id: 'o1', content: 'x' },
          { id: 'o2', content: 'x' },
          { id: 'o3', content: 'x' },
          { id: 'f2', content: 'content2' },
        ];
      }
      // f3 not found
      return [];
    });

    const result = await runEvalForStrategy(entries, 'raw');
    // MRR = (1/1 + 1/4 + 0) / 3 ≈ 0.4167
    expect(result.mrr).toBeCloseTo((1 + 0.25 + 0) / 3, 4);
  });

  it('records per_entry found_at_rank correctly', async () => {
    const entries = [
      makeEntry('f1', 'q1', 'content1'),
      makeEntry('f2', 'q2', 'content2'),
    ];

    setMnemonRecallForTest(async (agentGroupId, query) => {
      if (query.includes('q1')) {
        return [{ id: 'f1', content: 'content1' }]; // rank 1
      }
      return []; // f2 not found
    });

    const result = await runEvalForStrategy(entries, 'raw');
    const f1Entry = result.per_entry.find((e) => e.fact_id === 'f1');
    const f2Entry = result.per_entry.find((e) => e.fact_id === 'f2');
    expect(f1Entry?.found_at_rank).toBe(1);
    expect(f2Entry?.found_at_rank).toBeNull();
  });

  it('handles empty eval set gracefully', async () => {
    setMnemonRecallForTest(async () => []);
    const result = await runEvalForStrategy([], 'raw');
    expect(result.recall_at_5).toBe(0);
    expect(result.recall_at_10).toBe(0);
    expect(result.mrr).toBe(0);
    expect(result.total_entries).toBe(0);
    expect(result.per_entry).toHaveLength(0);
  });

  it('looks up fact by fact_id in returned results', async () => {
    const entries = [makeEntry('target-fact', 'find target', 'target content here')];

    setMnemonRecallForTest(async () => [
      { id: 'other', content: 'something else' },
      { id: 'target-fact', content: 'target content here' },
    ]);

    const result = await runEvalForStrategy(entries, 'raw');
    const entry = result.per_entry[0];
    expect(entry.found_at_rank).toBe(2); // 1-indexed rank
    expect(result.recall_at_5).toBeCloseTo(1, 5);
  });
});

describe('EvalResult shape', () => {
  it('returns all required fields', async () => {
    setMnemonRecallForTest(async () => []);
    const result = await runEvalForStrategy([makeEntry('f1', 'q', 'c')], 'heuristic');
    expect(result).toHaveProperty('strategy', 'heuristic');
    expect(result).toHaveProperty('recall_at_5');
    expect(result).toHaveProperty('recall_at_10');
    expect(result).toHaveProperty('mrr');
    expect(result).toHaveProperty('total_entries');
    expect(result).toHaveProperty('per_entry');
  });
});
