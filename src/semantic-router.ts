/**
 * Semantic Model Router — embedding-based task classifier.
 *
 * Pre-computes centroid embeddings for each task type from example prompts,
 * then classifies new prompts by cosine similarity to centroids.
 * Falls back to keyword classifier when similarity is below threshold.
 */
import { generateEmbeddings, cosineSimilarity } from './embedding.js';
import { logger } from './logger.js';
import type { TaskType } from './model-router.js';

const SIMILARITY_THRESHOLD = 0.3;

// Example prompts for each task type — centroids are computed from these
const TASK_EXAMPLES: Record<TaskType, string[]> = {
  research: [
    'Research the best project management tools for startups',
    'Find out about competitor pricing strategies',
    'Look into the latest trends in AI agents',
    'Deep dive into Web3 gaming market size',
    'Compare different cloud hosting providers',
    'Investigate alternatives to Notion',
    'What are the pros and cons of serverless architecture',
  ],
  grunt: [
    'Format this data as a CSV table',
    'Convert this JSON to markdown',
    'Clean up and deduplicate this list of emails',
    'Summarize this long article in 3 bullet points',
    'Extract all URLs from this text',
    'Parse this log file and count errors',
    'Sort these items alphabetically',
  ],
  conversation: [
    'Hey, how are you doing today?',
    'Thanks for helping me with that',
    'What do you think about this idea?',
    'Good morning!',
    'Tell me a joke',
    'How was your day?',
    'Remind me about the meeting tomorrow',
  ],
  analysis: [
    'Analyze our revenue trends from last quarter',
    'Evaluate the performance of our marketing campaigns',
    'Audit the security of our API endpoints',
    'Review our customer churn metrics and identify patterns',
    'Assess the ROI of our content marketing strategy',
    'Diagnose why conversion rates dropped last month',
    'Break down our cost structure by department',
  ],
  content: [
    'Write a blog post about artificial intelligence trends',
    'Draft a cold email for investor outreach',
    'Create a LinkedIn post about our product launch',
    'Compose a newsletter for our subscribers',
    'Write tweet thread about productivity tips',
    'Draft a press release for our funding round',
    'Create an email sequence for onboarding',
  ],
  code: [
    'Implement a rate limiter in TypeScript',
    'Debug the authentication endpoint',
    'Fix the bug in the payment processing flow',
    'Refactor the database query layer',
    'Write unit tests for the user service',
    'Build a REST API endpoint for user profiles',
    'Deploy the application to production',
  ],
  'quick-check': [
    'Check the weather in Singapore',
    'What time is it in Tokyo right now?',
    'Is the API server running?',
    'What is the current Bitcoin price?',
    'Verify the SSL certificate expiry date',
    'Check if the deployment succeeded',
    'Status of the CI pipeline',
  ],
};

// Cached centroids — lazy initialized on first call
let centroids: Map<TaskType, Float32Array> | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize centroid embeddings for all task types.
 * Lazy — only runs on first call to semanticClassifyTask.
 */
async function initCentroids(): Promise<void> {
  if (centroids) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const start = Date.now();
    const newCentroids = new Map<TaskType, Float32Array>();

    for (const [taskType, examples] of Object.entries(TASK_EXAMPLES)) {
      const embeddings: Float32Array[] = [];

      for (const example of examples) {
        try {
          const embedding = await generateEmbeddings(example);
          embeddings.push(embedding);
        } catch (err) {
          logger.warn({ taskType, err }, 'Failed to generate example embedding, skipping');
        }
      }

      if (embeddings.length === 0) {
        logger.warn({ taskType }, 'No embeddings generated for task type');
        continue;
      }

      // Compute centroid (average of all embeddings)
      const dim = embeddings[0].length;
      const centroid = new Float32Array(dim);
      for (const emb of embeddings) {
        for (let i = 0; i < dim; i++) {
          centroid[i] += emb[i];
        }
      }
      for (let i = 0; i < dim; i++) {
        centroid[i] /= embeddings.length;
      }

      // Normalize to unit vector
      let magnitude = 0;
      for (let i = 0; i < dim; i++) {
        magnitude += centroid[i] * centroid[i];
      }
      magnitude = Math.sqrt(magnitude);
      if (magnitude > 0) {
        for (let i = 0; i < dim; i++) {
          centroid[i] /= magnitude;
        }
      }

      newCentroids.set(taskType as TaskType, centroid);
    }

    centroids = newCentroids;
    logger.info(
      { taskTypes: newCentroids.size, durationMs: Date.now() - start },
      'Semantic router centroids initialized',
    );
  })();

  return initPromise;
}

/**
 * Classify a prompt using semantic (embedding-based) similarity.
 * Returns the best-matching task type and similarity score,
 * or null if no type exceeds the similarity threshold.
 */
export async function semanticClassifyTask(
  prompt: string,
): Promise<{ taskType: TaskType; similarity: number } | null> {
  await initCentroids();

  if (!centroids || centroids.size === 0) {
    return null;
  }

  let promptEmbedding: Float32Array;
  try {
    promptEmbedding = await generateEmbeddings(prompt);
  } catch (err) {
    logger.warn({ err }, 'Failed to generate prompt embedding for semantic classification');
    return null;
  }

  let bestType: TaskType | null = null;
  let bestSimilarity = -1;

  for (const [taskType, centroid] of centroids) {
    const similarity = cosineSimilarity(promptEmbedding, centroid);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestType = taskType;
    }
  }

  if (bestType === null || bestSimilarity < SIMILARITY_THRESHOLD) {
    logger.debug(
      { bestType, bestSimilarity, threshold: SIMILARITY_THRESHOLD },
      'Semantic classification below threshold',
    );
    return null;
  }

  return { taskType: bestType, similarity: bestSimilarity };
}

/** @internal — reset for testing */
export function _resetCentroidsForTests(): void {
  centroids = null;
  initPromise = null;
}

/** @internal — expose for testing */
export { TASK_EXAMPLES, SIMILARITY_THRESHOLD };
