import { describe, expect, it } from 'vitest';

import { fuseSearchResults } from './memory-retrieval.js';

const RECENT_AT = new Date().toISOString();

describe('fuseSearchResults', () => {
  it('fuses lexical and vector ranks and keeps shared results first', () => {
    const lexical = [
      {
        id: 'a',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'alpha',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'b',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'beta',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.7,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const vector = [
      {
        id: 'b',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'beta',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0,
        vector_score: 0.9,
        fused_score: 0,
      },
      {
        id: 'c',
        source_type: 'conversation',
        source_path: 'c3',
        text: 'gamma',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0,
        vector_score: 0.88,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, vector, 3);
    expect(fused).toHaveLength(3);
    expect(fused[0]?.id).toBe('b');
    expect(fused.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('supports tuning lexical/vector channel weights', () => {
    const lexical = [
      {
        id: 'a',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'alpha',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
    ];
    const vector = [
      {
        id: 'b',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'beta',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0,
        vector_score: 0.9,
        fused_score: 0,
      },
    ];

    const lexicalOnly = fuseSearchResults(lexical, vector, 2, {
      lexicalWeight: 1,
      vectorWeight: 0,
    });
    expect(lexicalOnly.map((x) => x.id)).toEqual(['a', 'b']);

    const vectorOnly = fuseSearchResults(lexical, vector, 2, {
      lexicalWeight: 0,
      vectorWeight: 1,
    });
    expect(vectorOnly.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('filters low fused scores using minScore cutoff', () => {
    const lexical = [
      {
        id: 'a',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'alpha',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'b',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'beta',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.7,
        vector_score: 0,
        fused_score: 0,
      },
    ];
    const vector = [
      {
        id: 'a',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'alpha',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0,
        vector_score: 0.9,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, vector, 3, { minScore: 0.02 });
    expect(fused.map((x) => x.id)).toEqual(['a']);
  });

  it('applies source-type boosts after fusion', () => {
    const lexical = [
      {
        id: 'conversation-result',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'chat log',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'claude-result',
        source_type: 'claude_md',
        source_path: 'CLAUDE.md',
        text: 'assistant profile',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.7,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 2);
    expect(fused.map((x) => x.id)).toEqual([
      'claude-result',
      'conversation-result',
    ]);
  });

  it('applies temporal decay using created_at and halfLifeDays', () => {
    const oldAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const freshAt = new Date().toISOString();

    const lexical = [
      {
        id: 'older',
        source_type: 'conversation',
        source_path: 'c-old',
        text: 'older item',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: oldAt,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'fresh',
        source_type: 'conversation',
        source_path: 'c-new',
        text: 'fresh item',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: freshAt,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 2, { halfLifeDays: 45 });
    expect(fused.map((x) => x.id)).toEqual(['fresh', 'older']);
  });

  it('applies MMR reranking to reduce near-duplicate snippets', () => {
    const lexical = [
      {
        id: 'dup-1',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'deploy checklist release canary health check',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'dup-2',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'deploy checklist release canary health checks',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.89,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'diverse',
        source_type: 'conversation',
        source_path: 'c3',
        text: 'weekend hiking plan and weather prep list',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.88,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 3, { mmrLambda: 0.7 });
    expect(fused.map((x) => x.id)).toEqual(['dup-1', 'diverse', 'dup-2']);
  });

  it('handles MMR with limit <= 1 (early return)', () => {
    const lexical = [
      {
        id: 'only-1',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'alpha content',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'only-2',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'beta content',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // With limit=1, applyMmr should return early via ranked.slice(0, 1)
    const fused = fuseSearchResults(lexical, [], 1, { mmrLambda: 0.7 });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.id).toBe('only-1');
  });

  it('handles MMR with ranked.length <= 1 (early return)', () => {
    const lexical = [
      {
        id: 'solo',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'only item',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 5, { mmrLambda: 0.7 });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.id).toBe('solo');
  });

  it('handles MMR tie-breaking when mmrScores are equal (line 121-122)', () => {
    // To trigger the tie-breaking branch: mmrScore === bestScore && relevance > bestRelevance
    // We need two candidates with the same mmrScore but different relevance.
    // mmrScore = lambda * relevance - (1-lambda) * maxSimilarity
    // If both candidates have identical text (same jaccard=1 with each other and the selected item),
    // but different fused_scores, then:
    //   candidate A: relevance=rA, maxSimilarity=sA
    //   candidate B: relevance=rB, maxSimilarity=sB
    // We need lambda*rA - (1-lambda)*sA = lambda*rB - (1-lambda)*sB
    //
    // Simpler approach: use lambda=0 so mmrScore = -(1-0)*maxSimilarity = -maxSimilarity
    // If both candidates have the same maxSimilarity with the selected items,
    // their mmrScores are equal, and we tie-break on relevance.
    const lexical = [
      {
        id: 'high-rel',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'deploy checklist canary',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.95,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'tie-a',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'unique alpha bravo charlie',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'tie-b',
        source_type: 'conversation',
        source_path: 'c3',
        text: 'unique delta echo foxtrot',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.7,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // With lambda=0, mmrScore = -maxSimilarity for each candidate
    // If tie-a and tie-b have no overlap with high-rel, both have maxSimilarity=0
    // So mmrScore for both is 0, triggering tie-break on relevance.
    // tie-a has higher fused_score -> higher relevance -> selected first.
    const fused = fuseSearchResults(lexical, [], 3, { mmrLambda: 0 });
    expect(fused).toHaveLength(3);
    expect(fused[0]!.id).toBe('high-rel');
    // tie-a should come before tie-b due to higher relevance in tie-break
    expect(fused[1]!.id).toBe('tie-a');
    expect(fused[2]!.id).toBe('tie-b');
  });

  it('handles items with no alphanumeric text (getTokenSet returns empty set)', () => {
    // When text has no alphanumeric characters, match() returns null,
    // triggering the `|| []` branch in getTokenSet.
    // Also tests jaccardSimilarity with empty sets (line 153: a.size === 0).
    const lexical = [
      {
        id: 'normal',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'deploy checklist release health',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.95,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'symbols-only',
        source_type: 'conversation',
        source_path: 'c2',
        text: '!@#$%^&*()_+-=[]{}|;:,.<>?',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'also-symbols',
        source_type: 'conversation',
        source_path: 'c3',
        text: '---...~~~!!!',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.85,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // MMR with lambda=0.5 — the symbol-only items have empty token sets
    const fused = fuseSearchResults(lexical, [], 3, { mmrLambda: 0.5 });
    expect(fused).toHaveLength(3);
    // All items should be returned without errors
    expect(fused.map((x) => x.id)).toContain('symbols-only');
  });

  it('uses cached token sets on repeated MMR comparisons', () => {
    // The getTokenSet function caches results. When the same item is compared
    // against multiple selected items, the cache hit branch fires (line 141).
    const lexical = [
      {
        id: 'first',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'first item content',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.95,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'second',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'second item different',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'third',
        source_type: 'conversation',
        source_path: 'c3',
        text: 'third item unique',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.85,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'fourth',
        source_type: 'conversation',
        source_path: 'c4',
        text: 'fourth item distinct',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // With 4 items and limit=4, the MMR loop runs multiple iterations.
    // After selecting first and second, when evaluating third and fourth,
    // the token sets for first and second are already cached.
    const fused = fuseSearchResults(lexical, [], 4, { mmrLambda: 0.7 });
    expect(fused).toHaveLength(4);
  });

  it('handles computeTemporalDecay with non-finite halfLifeDays', () => {
    // When halfLifeDays is Infinity, computeTemporalDecay returns 1 (no decay)
    const lexical = [
      {
        id: 'old-nodecay',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'old item without decay',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // Default halfLifeDays is Infinity (no decay)
    const fused = fuseSearchResults(lexical, [], 1);
    expect(fused).toHaveLength(1);
    expect(fused[0]!.fused_score).toBeGreaterThan(0);
  });

  it('handles computeTemporalDecay with invalid created_at', () => {
    // When createdAt is invalid, Date.parse returns NaN, decay returns 1
    const lexical = [
      {
        id: 'bad-date',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'item with invalid date',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: 'not-a-date',
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 1, { halfLifeDays: 30 });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.fused_score).toBeGreaterThan(0);
  });

  it('returns empty array when all items fall below minScore', () => {
    const lexical = [
      {
        id: 'low',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'low scoring item',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.1,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 5, { minScore: 1.0 });
    expect(fused).toHaveLength(0);
  });

  it('uses default boost of 1 for unknown source types (line 54 ?? branch)', () => {
    const lexical = [
      {
        id: 'unknown-type',
        source_type: 'completely_unknown_source',
        source_path: 'custom.md',
        text: 'item with unknown source type',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    const fused = fuseSearchResults(lexical, [], 1);
    expect(fused).toHaveLength(1);
    // With default boost of 1.0 and no decay, the fused_score should equal the base RRF score
    expect(fused[0]!.fused_score).toBeGreaterThan(0);
  });

  it('handles source type with negative boost via custom sourceTypeBoosts', () => {
    const lexical = [
      {
        id: 'neg-boost',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'negative boost item',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // Provide a negative boost for 'conversation' — Math.max(0, -5) = 0
    const fused = fuseSearchResults(lexical, [], 1, {
      sourceTypeBoosts: { conversation: -5 },
    });
    // With boost=0, the fused score becomes 0 regardless of RRF score
    expect(fused).toHaveLength(1);
    expect(fused[0]!.fused_score).toBe(0);
  });

  it('handles MMR with items that have zero fused_score (line 95 || branch)', () => {
    // When items have 0 fused_score, the || 0 branch is taken in maxFusedScore calculation.
    // We achieve this by providing sourceTypeBoosts that zero out the scores.
    const lexical = [
      {
        id: 'zero-fused-a',
        source_type: 'zerotype',
        source_path: 'c1',
        text: 'alpha content zero',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'zero-fused-b',
        source_type: 'zerotype',
        source_path: 'c2',
        text: 'beta content zero',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.8,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // Set boost for 'zerotype' to 0, making all fused_scores 0
    const fused = fuseSearchResults(lexical, [], 2, {
      mmrLambda: 0.5,
      sourceTypeBoosts: { zerotype: 0 },
      minScore: 0,
    });
    expect(fused).toHaveLength(2);
  });

  it('applies MMR with lambda=1 (pure relevance, no diversity penalty)', () => {
    const lexical = [
      {
        id: 'dup-x',
        source_type: 'conversation',
        source_path: 'c1',
        text: 'identical words identical words',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.95,
        vector_score: 0,
        fused_score: 0,
      },
      {
        id: 'dup-y',
        source_type: 'conversation',
        source_path: 'c2',
        text: 'identical words identical words',
        scope: 'group' as const,
        group_folder: 'g1',
        created_at: RECENT_AT,
        lexical_score: 0.9,
        vector_score: 0,
        fused_score: 0,
      },
    ];

    // lambda=1 means only relevance matters, no diversity penalty
    const fused = fuseSearchResults(lexical, [], 2, { mmrLambda: 1 });
    expect(fused).toHaveLength(2);
    // Should be in original relevance order
    expect(fused[0]!.id).toBe('dup-x');
    expect(fused[1]!.id).toBe('dup-y');
  });
});
