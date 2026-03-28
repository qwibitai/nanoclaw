import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import {
  parseMemoryFile,
  serializeMemoryFile,
  computeMemoryFitness,
  pruneMemories,
  touchMemory,
  scoreAllMemories,
  MemoryBlock,
  MemoryFile,
} from './memory-ecology.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(overrides: Partial<MemoryBlock> = {}): MemoryBlock {
  return {
    id: overrides.id ?? 'block-1',
    content: overrides.content ?? 'Some memory content.',
    fitness: overrides.fitness ?? 0.5,
    recency: overrides.recency ?? 1,
    frequency: overrides.frequency ?? 3,
    tags: overrides.tags ?? ['test'],
    created_at: overrides.created_at ?? '2024-01-01T00:00:00.000Z',
    last_accessed_at:
      overrides.last_accessed_at ?? '2024-01-10T00:00:00.000Z',
    contradicts: overrides.contradicts,
  };
}

function makeMemoryFile(blocks: MemoryBlock[] = [], prose = ''): MemoryFile {
  return {
    blocks,
    prose,
    metadata: { last_scored_at: new Date().toISOString(), format_version: 1 },
  };
}

const SAMPLE_CLAUDE_MD = `# My Group

Some prose here.

<!-- memory-start: pref-1 -->
fitness: 0.8
recency: 2
frequency: 5
tags: [preferences, user]
created_at: "2024-01-01T00:00:00.000Z"
last_accessed_at: "2024-01-10T00:00:00.000Z"
---
User prefers dark mode.
<!-- memory-end: pref-1 -->

<!-- memory-start: note-2 -->
fitness: 0.6
recency: 5
frequency: 2
tags: [notes]
created_at: "2024-01-02T00:00:00.000Z"
last_accessed_at: "2024-01-08T00:00:00.000Z"
---
User mentioned they dislike loud music.
<!-- memory-end: note-2 -->
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('memory-ecology', () => {
  beforeEach(() => _initTestDatabase());

  it('parseMemoryFile returns empty blocks for plain CLAUDE.md with no markers', () => {
    const plain = '# Hello\n\nThis is a plain CLAUDE.md without any markers.\n';
    const result = parseMemoryFile(plain);
    expect(result.blocks).toHaveLength(0);
    expect(result.prose).toBe(plain);
    expect(result.metadata.format_version).toBe(1);
  });

  it('parseMemoryFile correctly parses a file with two valid YAML memory blocks', () => {
    const result = parseMemoryFile(SAMPLE_CLAUDE_MD);
    expect(result.blocks).toHaveLength(2);

    const pref = result.blocks.find((b) => b.id === 'pref-1');
    expect(pref).toBeDefined();
    expect(pref!.fitness).toBe(0.8);
    expect(pref!.recency).toBe(2);
    expect(pref!.frequency).toBe(5);
    expect(pref!.tags).toEqual(['preferences', 'user']);
    expect(pref!.content).toContain('dark mode');

    const note = result.blocks.find((b) => b.id === 'note-2');
    expect(note).toBeDefined();
    expect(note!.tags).toEqual(['notes']);
    expect(note!.content).toContain('loud music');

    // Prose should not contain memory block markers
    expect(result.prose).not.toContain('<!-- memory-start');
    expect(result.prose).toContain('Some prose here');
  });

  it('serializeMemoryFile round-trips: parse then serialize produces structurally equivalent output', () => {
    const parsed = parseMemoryFile(SAMPLE_CLAUDE_MD);
    const serialized = serializeMemoryFile(parsed);

    // Re-parse the serialized output
    const reParsed = parseMemoryFile(serialized);

    expect(reParsed.blocks).toHaveLength(parsed.blocks.length);
    for (const original of parsed.blocks) {
      const reBlock = reParsed.blocks.find((b) => b.id === original.id);
      expect(reBlock).toBeDefined();
      expect(reBlock!.fitness).toBe(original.fitness);
      expect(reBlock!.recency).toBe(original.recency);
      expect(reBlock!.frequency).toBe(original.frequency);
      expect(reBlock!.tags).toEqual(original.tags);
      expect(reBlock!.content).toBe(original.content);
    }
  });

  it('computeMemoryFitness returns value in [0,1] for typical inputs', () => {
    const fitness = computeMemoryFitness({ recency: 2, frequency: 5 });
    expect(fitness).toBeGreaterThanOrEqual(0);
    expect(fitness).toBeLessThanOrEqual(1);
  });

  it('computeMemoryFitness reduces fitness when contradicts array is non-empty', () => {
    const withoutContradictions = computeMemoryFitness({
      recency: 2,
      frequency: 5,
    });
    const withContradictions = computeMemoryFitness({
      recency: 2,
      frequency: 5,
      contradicts: ['other-block'],
    });
    expect(withContradictions).toBeLessThan(withoutContradictions);
  });

  it('pruneMemories removes blocks below default threshold 0.1', () => {
    const lowBlock = makeBlock({ id: 'low', fitness: 0.05 });
    const highBlock = makeBlock({ id: 'high', fitness: 0.8 });
    const mf = makeMemoryFile([lowBlock, highBlock]);

    const { pruned, kept } = pruneMemories(mf);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].id).toBe('low');
    expect(kept.blocks).toHaveLength(1);
    expect(kept.blocks[0].id).toBe('high');
  });

  it('pruneMemories enforces maxBlocks=2 by removing lowest-fitness blocks first', () => {
    const blocks = [
      makeBlock({ id: 'a', fitness: 0.9 }),
      makeBlock({ id: 'b', fitness: 0.7 }),
      makeBlock({ id: 'c', fitness: 0.5 }),
      makeBlock({ id: 'd', fitness: 0.3 }),
    ];
    const mf = makeMemoryFile(blocks);

    const { pruned, kept } = pruneMemories(mf, { maxBlocks: 2 });
    expect(kept.blocks).toHaveLength(2);
    expect(pruned).toHaveLength(2);
    // Lowest fitness blocks should be pruned
    const keptIds = kept.blocks.map((b) => b.id);
    expect(keptIds).toContain('a');
    expect(keptIds).toContain('b');
    const prunedIds = pruned.map((b) => b.id);
    expect(prunedIds).toContain('c');
    expect(prunedIds).toContain('d');
  });

  it('touchMemory increments frequency by 1', () => {
    const block = makeBlock({ id: 'mem-1', frequency: 4 });
    const mf = makeMemoryFile([block]);
    const updated = touchMemory(mf, 'mem-1');
    const updatedBlock = updated.blocks.find((b) => b.id === 'mem-1')!;
    expect(updatedBlock.frequency).toBe(5);
  });

  it('scoreAllMemories updates fitness for all blocks', () => {
    // Use a very old last_accessed_at so recency will be large (>0)
    const block1 = makeBlock({
      id: 'b1',
      fitness: 0,
      last_accessed_at: '2020-01-01T00:00:00.000Z',
      frequency: 3,
    });
    const block2 = makeBlock({
      id: 'b2',
      fitness: 0,
      last_accessed_at: '2020-06-01T00:00:00.000Z',
      frequency: 8,
    });
    const mf = makeMemoryFile([block1, block2]);

    const now = new Date('2026-03-27T00:00:00.000Z');
    const scored = scoreAllMemories(mf, now);

    for (const block of scored.blocks) {
      // Fitness should now be a computed value, not the zeroed placeholder
      expect(block.fitness).toBeGreaterThanOrEqual(0);
      expect(block.fitness).toBeLessThanOrEqual(1);
    }
    // metadata should be updated
    expect(scored.metadata.last_scored_at).toBe(now.toISOString());
  });

  it('pruneMemories returns empty pruned array when all blocks above threshold', () => {
    const blocks = [
      makeBlock({ id: 'x', fitness: 0.5 }),
      makeBlock({ id: 'y', fitness: 0.9 }),
    ];
    const mf = makeMemoryFile(blocks);
    const { pruned, kept } = pruneMemories(mf, { fitnessThreshold: 0.1 });
    expect(pruned).toHaveLength(0);
    expect(kept.blocks).toHaveLength(2);
  });
});
