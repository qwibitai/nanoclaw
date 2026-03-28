import * as yaml from 'yaml';
import { logger } from './logger.js';

export interface MemoryBlock {
  id: string;
  content: string;
  fitness: number;
  recency: number;
  frequency: number;
  tags: string[];
  created_at: string;
  last_accessed_at: string;
  contradicts?: string[];
}

export interface MemoryFile {
  blocks: MemoryBlock[];
  prose: string; // non-memory content preserved as-is
  metadata: {
    last_scored_at: string;
    format_version: number;
  };
}

// Matches <!-- memory-start: block-id --> ... <!-- memory-end: block-id -->
// The block-id may contain word chars, hyphens, and dots.
const MEMORY_BLOCK_REGEX =
  /<!-- memory-start: ([\w\-.]+) -->\n([\s\S]*?)<!-- memory-end: \1 -->/g;

/**
 * Parses a CLAUDE.md file that may contain zero or more embedded memory blocks.
 *
 * Each block has the format:
 *   <!-- memory-start: id -->
 *   <yaml frontmatter>
 *   ---
 *   <content text>
 *   <!-- memory-end: id -->
 */
export function parseMemoryFile(claudeMdContent: string): MemoryFile {
  const blocks: MemoryBlock[] = [];

  let prose = claudeMdContent;

  let match: RegExpExecArray | null;
  // Reset lastIndex in case the regex is reused
  MEMORY_BLOCK_REGEX.lastIndex = 0;

  const blockMatches: Array<{ full: string; id: string; body: string }> = [];

  // Collect all matches first so we can strip them from prose
  const regex = new RegExp(
    /<!-- memory-start: ([\w\-.]+) -->\n([\s\S]*?)<!-- memory-end: \1 -->/g,
  );
  while ((match = regex.exec(claudeMdContent)) !== null) {
    blockMatches.push({ full: match[0], id: match[1], body: match[2] });
  }

  if (blockMatches.length === 0) {
    return {
      blocks: [],
      prose: claudeMdContent,
      metadata: {
        last_scored_at: new Date().toISOString(),
        format_version: 1,
      },
    };
  }

  // Strip all memory blocks from prose
  for (const bm of blockMatches) {
    prose = prose.replace(bm.full, '');
  }
  prose = prose.trim();

  for (const bm of blockMatches) {
    const separatorIdx = bm.body.indexOf('---\n');
    let frontmatterStr: string;
    let content: string;

    if (separatorIdx !== -1) {
      frontmatterStr = bm.body.slice(0, separatorIdx);
      content = bm.body.slice(separatorIdx + 4); // skip '---\n'
    } else {
      // No separator: treat entire body as content with no frontmatter
      frontmatterStr = '';
      content = bm.body;
    }

    let meta: Record<string, unknown> = {};
    try {
      meta = (yaml.parse(frontmatterStr) as Record<string, unknown>) ?? {};
    } catch (err) {
      logger.warn(
        { blockId: bm.id, err },
        'Failed to parse YAML frontmatter for memory block',
      );
    }

    blocks.push({
      id: bm.id,
      content: content.trimEnd(),
      fitness: typeof meta.fitness === 'number' ? meta.fitness : 0,
      recency: typeof meta.recency === 'number' ? meta.recency : 0,
      frequency: typeof meta.frequency === 'number' ? meta.frequency : 0,
      tags: Array.isArray(meta.tags)
        ? (meta.tags as string[])
        : typeof meta.tags === 'string'
          ? [meta.tags]
          : [],
      created_at:
        typeof meta.created_at === 'string'
          ? meta.created_at
          : new Date().toISOString(),
      last_accessed_at:
        typeof meta.last_accessed_at === 'string'
          ? meta.last_accessed_at
          : new Date().toISOString(),
      contradicts: Array.isArray(meta.contradicts)
        ? (meta.contradicts as string[])
        : undefined,
    });
  }

  return {
    blocks,
    prose,
    metadata: {
      last_scored_at: new Date().toISOString(),
      format_version: 1,
    },
  };
}

/**
 * Serializes a MemoryFile back to a CLAUDE.md-compatible string.
 * Prose is written first, followed by all memory blocks.
 */
export function serializeMemoryFile(memoryFile: MemoryFile): string {
  if (memoryFile.blocks.length === 0) {
    return memoryFile.prose;
  }

  const serializedBlocks = memoryFile.blocks.map((block) => {
    const frontmatter: Record<string, unknown> = {
      fitness: block.fitness,
      recency: block.recency,
      frequency: block.frequency,
      tags: block.tags,
      created_at: block.created_at,
      last_accessed_at: block.last_accessed_at,
    };
    if (block.contradicts && block.contradicts.length > 0) {
      frontmatter.contradicts = block.contradicts;
    }

    const yamlStr = yaml.stringify(frontmatter).trimEnd();
    return (
      `<!-- memory-start: ${block.id} -->\n` +
      `${yamlStr}\n` +
      `---\n` +
      `${block.content}\n` +
      `<!-- memory-end: ${block.id} -->`
    );
  });

  return memoryFile.prose + '\n\n' + serializedBlocks.join('\n\n');
}

/**
 * Computes a fitness score in [0, 1] from recency, frequency, and contradiction
 * penalty/bonus. Higher is better (block is worth keeping).
 *
 * - recencyScore  = 1 / (1 + recency)       [0..1]   — lower recency = fresher
 * - frequencyScore = min(1, frequency / 10)  [0..1]   — more accesses = more valuable
 * - contradictionPenalty: -0.3 if any contradictions, else +0.2
 *
 * fitness = recencyScore * 0.4 + frequencyScore * 0.4 + contradictionPenalty
 * Clamped to [0, 1].
 */
export function computeMemoryFitness(
  block: Pick<MemoryBlock, 'recency' | 'frequency' | 'contradicts'>,
): number {
  const recencyScore = 1 / (1 + block.recency);
  const frequencyScore = Math.min(1, block.frequency / 10);
  const contradictionPenalty =
    (block.contradicts?.length ?? 0) > 0 ? -0.3 : 0.2;
  const fitness =
    recencyScore * 0.4 + frequencyScore * 0.4 + contradictionPenalty;
  return Math.max(0, Math.min(1, fitness));
}

/**
 * Removes low-fitness blocks from a MemoryFile.
 *
 * First pass: remove blocks below fitnessThreshold (default 0.1).
 * Second pass: if still over maxBlocks (default 50), drop lowest-fitness first.
 *
 * Returns the pruned blocks and the updated MemoryFile.
 */
export function pruneMemories(
  memoryFile: MemoryFile,
  options?: { fitnessThreshold?: number; maxBlocks?: number },
): { pruned: MemoryBlock[]; kept: MemoryFile } {
  const fitnessThreshold = options?.fitnessThreshold ?? 0.1;
  const maxBlocks = options?.maxBlocks ?? 50;

  const pruned: MemoryBlock[] = [];

  // First pass: remove blocks below threshold
  let kept = memoryFile.blocks.filter((b) => {
    if (b.fitness < fitnessThreshold) {
      pruned.push(b);
      return false;
    }
    return true;
  });

  // Second pass: enforce maxBlocks by removing lowest-fitness first
  if (kept.length > maxBlocks) {
    // Sort ascending by fitness so lowest come first
    const sorted = [...kept].sort((a, b) => a.fitness - b.fitness);
    const toRemove = sorted.slice(0, kept.length - maxBlocks);
    const toRemoveIds = new Set(toRemove.map((b) => b.id));
    pruned.push(...toRemove);
    kept = kept.filter((b) => !toRemoveIds.has(b.id));
  }

  return {
    pruned,
    kept: {
      ...memoryFile,
      blocks: kept,
    },
  };
}

/**
 * Marks a memory block as accessed, incrementing its frequency and
 * recomputing recency based on the elapsed time since last_accessed_at.
 * Returns a new MemoryFile (immutable update).
 */
export function touchMemory(
  memoryFile: MemoryFile,
  blockId: string,
  now?: Date,
): MemoryFile {
  const nowDate = now ?? new Date();
  const updatedBlocks = memoryFile.blocks.map((block) => {
    if (block.id !== blockId) return block;

    const lastAccessed = new Date(block.last_accessed_at);
    const recencyDays =
      (nowDate.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);

    const updated: MemoryBlock = {
      ...block,
      frequency: block.frequency + 1,
      recency: recencyDays,
      last_accessed_at: nowDate.toISOString(),
    };
    return updated;
  });

  return { ...memoryFile, blocks: updatedBlocks };
}

/**
 * Recomputes fitness for all blocks relative to `now` (defaults to current
 * time). Recency is re-derived from last_accessed_at and now.
 * Returns a new MemoryFile (immutable update).
 */
export function scoreAllMemories(
  memoryFile: MemoryFile,
  now?: Date,
): MemoryFile {
  const nowDate = now ?? new Date();

  const updatedBlocks = memoryFile.blocks.map((block) => {
    const lastAccessed = new Date(block.last_accessed_at);
    const recencyDays =
      (nowDate.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
    const updatedBlock: MemoryBlock = { ...block, recency: recencyDays };
    const fitness = computeMemoryFitness(updatedBlock);
    return { ...updatedBlock, fitness };
  });

  return {
    ...memoryFile,
    blocks: updatedBlocks,
    metadata: {
      ...memoryFile.metadata,
      last_scored_at: nowDate.toISOString(),
    },
  };
}
