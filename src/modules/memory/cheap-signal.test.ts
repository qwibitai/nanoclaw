import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeQueryFactCosines, setEmbedderForTest, _resetEmbedderForTest } from './cheap-signal.js';

function approxEqual(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

describe('computeQueryFactCosines', () => {
  beforeEach(() => {
    _resetEmbedderForTest();
  });

  afterEach(() => {
    _resetEmbedderForTest();
  });

  it('test_returns_empty_map_on_empty_facts', async () => {
    let embedderCalled = false;
    setEmbedderForTest(async () => {
      embedderCalled = true;
      throw new Error('should not be called');
    });
    const result = await computeQueryFactCosines('query', []);
    expect(result.size).toBe(0);
    expect(embedderCalled).toBe(false);
  });

  it('test_returns_cosines_for_facts', async () => {
    // query=[1,0,0], fact1=[0.5,0.5,0] (not normalized), fact2=[0,1,0]
    // normalized: query=[1,0,0], fact1=[1/sqrt(2), 1/sqrt(2), 0], fact2=[0,1,0]
    // cos(query, fact1_norm) = 1/sqrt(2) ≈ 0.7071
    // cos(query, fact2_norm) = 0
    // clip to [0,1] (already in range): 0.7071 and 0.0
    setEmbedderForTest(async (_texts: string[]) => {
      return [
        [1, 0, 0],
        [0.5, 0.5, 0],
        [0, 1, 0],
      ];
    });
    const result = await computeQueryFactCosines('q', [
      { id: 'f1', content: 'c1' },
      { id: 'f2', content: 'c2' },
    ]);
    expect(result.size).toBe(2);
    expect(approxEqual(result.get('f1')!, 0.7071)).toBe(true);
    expect(approxEqual(result.get('f2')!, 0.0)).toBe(true);
  });

  it('test_returns_empty_on_embedder_failure', async () => {
    setEmbedderForTest(async () => {
      throw new Error('embedder error');
    });
    const result = await computeQueryFactCosines('q', [{ id: 'f1', content: 'c1' }]);
    expect(result.size).toBe(0);
  });

  it('test_returns_empty_on_timeout', async () => {
    setEmbedderForTest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return [
        [1, 0],
        [0, 1],
      ];
    });
    const start = Date.now();
    const result = await computeQueryFactCosines('q', [{ id: 'f1', content: 'c1' }], { timeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(result.size).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });
});
