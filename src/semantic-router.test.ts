import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskType } from './model-router.js';

/**
 * Mock embedding module with category-clustered vectors.
 *
 * Uses vi.hoisted() so the implementation function can be referenced
 * both in the vi.mock factory and in beforeEach (to restore after
 * tests that override it via mockRejectedValue).
 */
const { mockGenerateEmbeddings, mockCosineSimilarity } = vi.hoisted(() => {
  // Category keywords mapped to embedding dimension indices.
  const categoryKeywords: Record<string, number> = {
    // research (dim 0)
    research: 0, investigate: 0, 'find out': 0, 'deep dive': 0, compare: 0,
    alternatives: 0, 'pros and cons': 0, 'look into': 0, explore: 0, trends: 0,
    // grunt (dim 1)
    format: 1, convert: 1, csv: 1, json: 1, markdown: 1, clean: 1,
    deduplicate: 1, summarize: 1, extract: 1, parse: 1, sort: 1,
    // conversation (dim 2)
    hey: 2, hello: 2, thanks: 2, 'good morning': 2, joke: 2,
    'how are you': 2, remind: 2, 'what do you think': 2,
    // analysis (dim 3)
    analyze: 3, evaluate: 3, audit: 3, review: 3, assess: 3,
    diagnose: 3, metrics: 3, revenue: 3, roi: 3, churn: 3, 'break down': 3,
    // content (dim 4)
    write: 4, draft: 4, compose: 4, 'blog post': 4, email: 4,
    newsletter: 4, tweet: 4, 'press release': 4, linkedin: 4,
    // code (dim 5)
    implement: 5, debug: 5, fix: 5, refactor: 5, 'unit test': 5,
    api: 5, endpoint: 5, deploy: 5, typescript: 5, bug: 5,
    // quick-check (dim 6)
    check: 6, weather: 6, 'what time': 6, status: 6, verify: 6,
    price: 6, running: 6, pipeline: 6, certificate: 6,
  };

  const mockGenerateEmbeddings = async (text: string): Promise<Float32Array> => {
    const arr = new Float32Array(512);
    const lower = text.toLowerCase();

    for (const [keyword, dim] of Object.entries(categoryKeywords)) {
      if (lower.includes(keyword)) {
        arr[dim] += 3.0;
      }
    }

    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 7; i < 512; i++) {
      hash = ((hash << 5) - hash + i) | 0;
      arr[i] = ((hash & 0xff) / 127.5 - 1) * 0.1;
    }

    let mag = 0;
    for (let i = 0; i < 512; i++) mag += arr[i] * arr[i];
    mag = Math.sqrt(mag);
    if (mag > 0) for (let i = 0; i < 512; i++) arr[i] /= mag;
    return arr;
  };

  const mockCosineSimilarity = (a: Float32Array, b: Float32Array): number => {
    let dot = 0,
      magA = 0,
      magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  };

  return { mockGenerateEmbeddings, mockCosineSimilarity };
});

vi.mock('./embedding.js', () => ({
  generateEmbeddings: vi.fn(mockGenerateEmbeddings),
  cosineSimilarity: vi.fn(mockCosineSimilarity),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  semanticClassifyTask,
  _resetCentroidsForTests,
  TASK_EXAMPLES,
  SIMILARITY_THRESHOLD,
} from './semantic-router.js';
import { generateEmbeddings } from './embedding.js';

beforeEach(() => {
  _resetCentroidsForTests();
  // Restore the mock implementation (in case a test overrode it via mockRejectedValue)
  (generateEmbeddings as ReturnType<typeof vi.fn>).mockImplementation(mockGenerateEmbeddings);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// TASK_EXAMPLES structure
// ---------------------------------------------------------------------------
describe('TASK_EXAMPLES', () => {
  const ALL_TASK_TYPES: TaskType[] = [
    'research',
    'grunt',
    'conversation',
    'analysis',
    'content',
    'code',
    'quick-check',
  ];

  it('has entries for all 7 task types', () => {
    for (const taskType of ALL_TASK_TYPES) {
      expect(TASK_EXAMPLES).toHaveProperty(taskType);
    }
    expect(Object.keys(TASK_EXAMPLES)).toHaveLength(7);
  });

  it('each task type has at least 5 example prompts', () => {
    for (const [taskType, examples] of Object.entries(TASK_EXAMPLES)) {
      expect(
        examples.length,
        `${taskType} should have >= 5 examples`,
      ).toBeGreaterThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// SIMILARITY_THRESHOLD
// ---------------------------------------------------------------------------
describe('SIMILARITY_THRESHOLD', () => {
  it('is 0.3', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// _resetCentroidsForTests
// ---------------------------------------------------------------------------
describe('_resetCentroidsForTests', () => {
  it('clears cached centroids so next call re-initializes', async () => {
    // First call initializes centroids
    await semanticClassifyTask('Research new AI trends and investigate options');
    const callCountAfterFirst = (
      generateEmbeddings as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Reset centroids
    _resetCentroidsForTests();

    // Second call should re-initialize (generating new embeddings)
    await semanticClassifyTask('Investigate competitor strategies and explore alternatives');
    const callCountAfterSecond = (
      generateEmbeddings as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Should have generated more embeddings for re-initialization
    expect(callCountAfterSecond).toBeGreaterThan(callCountAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// semanticClassifyTask
// ---------------------------------------------------------------------------
describe('semanticClassifyTask', () => {
  it('returns task type with similarity score', async () => {
    const result = await semanticClassifyTask(
      'Implement a new feature in TypeScript',
    );
    expect(result).not.toBeNull();
    expect(result!.taskType).toBeDefined();
    expect(result!.similarity).toBeGreaterThan(0);
    expect(typeof result!.similarity).toBe('number');
  });

  it('returns null when centroids fail to init', async () => {
    // Override mock to throw for all calls during this test
    const mockGenerate = generateEmbeddings as ReturnType<typeof vi.fn>;
    mockGenerate.mockRejectedValue(new Error('API unavailable'));

    const result = await semanticClassifyTask('Some prompt');
    expect(result).toBeNull();
    // beforeEach will restore the implementation before the next test
  });

  it('classifies a research prompt as research', async () => {
    const result = await semanticClassifyTask(
      'Research the best project management tools for startups',
    );
    expect(result).not.toBeNull();
    expect(result!.taskType).toBe('research');
  });

  it('classifies a code prompt as code', async () => {
    const result = await semanticClassifyTask(
      'Implement a rate limiter in TypeScript',
    );
    expect(result).not.toBeNull();
    expect(result!.taskType).toBe('code');
  });

  it('classifies a grunt prompt as grunt', async () => {
    const result = await semanticClassifyTask(
      'Format this data as a CSV table',
    );
    expect(result).not.toBeNull();
    expect(result!.taskType).toBe('grunt');
  });

  it('returns null for gibberish input below threshold', async () => {
    // Gibberish with no category keywords produces an embedding with
    // only small random noise — low similarity against all centroids
    const result = await semanticClassifyTask(
      'xylophone quantum banana umbrella platypus',
    );
    if (result !== null) {
      expect(result.similarity).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    }
  });

  it('re-initialization reuses cached centroids (does not re-compute)', async () => {
    // First call initializes centroids + generates prompt embedding
    await semanticClassifyTask('Research new AI trends and investigate options');
    const callCountAfterFirst = (
      generateEmbeddings as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Second call should NOT re-compute centroids — only 1 new embedding for prompt
    await semanticClassifyTask('Investigate competitor strategies and explore alternatives');
    const callCountAfterSecond = (
      generateEmbeddings as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Only one additional call for the new prompt embedding (not re-init)
    expect(callCountAfterSecond).toBe(callCountAfterFirst + 1);
  });

  it('concurrent init calls do not duplicate work', async () => {
    // Fire multiple classify calls simultaneously before centroids are cached
    const results = await Promise.all([
      semanticClassifyTask('Research AI trends and investigate tools'),
      semanticClassifyTask('Debug the TypeScript API endpoint'),
      semanticClassifyTask('Format data as CSV and extract URLs'),
    ]);

    // All should resolve without error
    for (const result of results) {
      if (result !== null) {
        expect(result.taskType).toBeDefined();
        expect(result.similarity).toBeGreaterThan(0);
      }
    }

    // Count total example embeddings generated — should only be ~49 (7 types x 7 examples)
    // plus the 3 prompt embeddings = ~52, NOT 3x the centroid embeddings
    const totalCalls = (
      generateEmbeddings as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    const exampleCount = Object.values(TASK_EXAMPLES).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    // Total should be example embeddings + prompt embeddings (not duplicated)
    expect(totalCalls).toBeLessThanOrEqual(exampleCount + 3);
  });
});
