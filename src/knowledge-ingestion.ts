import { logger } from './logger.js';

interface TaskOutcome {
  groupId: string;
  prompt: string;
  status: 'success' | 'error';
  durationMs: number;
}

const MAX_FACT_LENGTH = 250;

/**
 * Capture a successful task outcome as a knowledge fact.
 * Silently skips failed tasks and very short prompts.
 */
export async function captureTaskOutcome(outcome: TaskOutcome): Promise<void> {
  if (outcome.status !== 'success') return;
  if (outcome.prompt.length < 10) return;

  try {
    const { storeFactWithVector } = await import('./memory/knowledge-store.js');
    const truncated = outcome.prompt.slice(0, MAX_FACT_LENGTH);
    const fact = `Task completed: ${truncated} (${Math.round(outcome.durationMs / 1000)}s)`;

    await storeFactWithVector({
      text: fact,
      domain: 'task_outcome',
      groupId: outcome.groupId,
      source: 'auto_capture',
    });

    logger.debug({ groupId: outcome.groupId }, 'Task outcome captured as fact');
  } catch (err) {
    logger.debug({ err }, 'Failed to capture task outcome (non-fatal)');
  }
}
