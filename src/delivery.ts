import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface RetryOptions {
  provider: string;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  minIntervalMs: number;
}

interface DeliveryFailureRecord {
  timestamp: string;
  provider: string;
  conversationId: string;
  attempts: number;
  error: string;
  textPreview: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadLetterPath(): string {
  const dir = path.join(DATA_DIR, 'dead-letter');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'outbound-messages.jsonl');
}

function writeDeadLetter(record: DeliveryFailureRecord): void {
  fs.appendFileSync(deadLetterPath(), `${JSON.stringify(record)}\n`);
}

export function createReliableSender(
  sendFn: (conversationId: string, text: string) => Promise<void>,
  opts: Partial<RetryOptions> & { provider: string },
): (conversationId: string, text: string) => Promise<void> {
  const options: RetryOptions = {
    provider: opts.provider,
    maxAttempts: opts.maxAttempts || Number(process.env.OUTBOUND_MAX_ATTEMPTS || 4),
    initialDelayMs: opts.initialDelayMs || Number(process.env.OUTBOUND_RETRY_BASE_MS || 500),
    maxDelayMs: opts.maxDelayMs || Number(process.env.OUTBOUND_RETRY_MAX_MS || 8000),
    minIntervalMs: opts.minIntervalMs || Number(process.env.OUTBOUND_MIN_INTERVAL_MS || 0),
  };

  const lastSentAt = new Map<string, number>();

  return async (conversationId: string, text: string): Promise<void> => {
    let delay = options.initialDelayMs;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      try {
        const now = Date.now();
        const last = lastSentAt.get(conversationId);
        if (
          options.minIntervalMs > 0 &&
          last !== undefined &&
          now - last < options.minIntervalMs
        ) {
          await sleep(options.minIntervalMs - (now - last));
        }

        await sendFn(conversationId, text);
        lastSentAt.set(conversationId, Date.now());
        if (attempt > 1) {
          logger.info(
            {
              provider: options.provider,
              conversationId,
              attempt,
            },
            'Outbound delivery succeeded after retry',
          );
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn(
          {
            provider: options.provider,
            conversationId,
            attempt,
            maxAttempts: options.maxAttempts,
            error: lastError,
          },
          'Outbound delivery failed',
        );
        if (attempt < options.maxAttempts) {
          await sleep(delay);
          delay = Math.min(options.maxDelayMs, delay * 2);
        }
      }
    }

    const failure: DeliveryFailureRecord = {
      timestamp: new Date().toISOString(),
      provider: options.provider,
      conversationId,
      attempts: options.maxAttempts,
      error: lastError || 'unknown error',
      textPreview: text.slice(0, 500),
    };
    writeDeadLetter(failure);
    throw new Error(
      `Failed to deliver message after ${options.maxAttempts} attempts: ${failure.error}`,
    );
  };
}
