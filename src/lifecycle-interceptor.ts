/**
 * Lifecycle Interceptor — Bridges cambot-core into the agent message lifecycle.
 *
 * All methods are error-isolated: failures log but never propagate to the
 * message pipeline. The LLM agent has zero awareness of memory operations.
 */

import type { Logger } from 'pino';
import type { CamBotCoreServices, PiiMapping, RedactionResult } from 'cambot-core';
import type { NewMessage } from './types.js';
import type { ContainerTelemetry } from './container-runner.js';
import { createIngestionQueue } from './ingestion-queue.js';
import type { IngestionQueue } from './ingestion-queue.js';
import crypto from 'node:crypto';

export interface LifecycleInterceptor {
  readonly currentSessionKey: string | null;
  ingestMessage(msg: NewMessage): void;
  ingestResponse(groupFolder: string, chatJid: string, text: string): void;
  redactPrompt(prompt: string): { redacted: string; mappings: PiiMapping[] };
  restoreOutput(text: string, mappings: PiiMapping[]): string;
  getBootContext(): string;
  recordTelemetry(telemetry: ContainerTelemetry, channel?: string): void;
  startSession(groupFolder: string, chatJid: string): void;
  endSession(groupFolder: string, success: boolean): void;
  startPeriodicTasks(): void;
  close(): Promise<void>;
}

const BOOT_CONTEXT_TTL_MS = 60_000;

export function createLifecycleInterceptor(
  core: CamBotCoreServices,
  logger: Logger,
): LifecycleInterceptor {
  const queue: IngestionQueue = createIngestionQueue({
    maxConcurrency: 2,
    maxDepth: 100,
    logger,
  });

  // Boot context cache
  let cachedBootContext = '';
  let bootContextCachedAt = 0;

  // Active session key for short-term memory writes
  let currentSessionKey: string | null = null;

  // Periodic task timers
  const timers: ReturnType<typeof setInterval>[] = [];

  /**
   * Run the extract → upsert entities → insert facts → embed pipeline.
   * Shared by ingestMessage and ingestResponse.
   */
  async function extractAndStore(text: string, source: string): Promise<void> {
    if (!core.extractor) return;

    const result = await core.extractor.extract(text, {
      fileName: source,
      fileDate: new Date().toISOString().slice(0, 10),
      lineStart: 0,
    });

    if (result.facts.length === 0 && result.entities.length === 0) return;

    // Upsert entities
    for (const entity of result.entities) {
      core.entityStore.upsert(core.db, {
        display: entity.name,
        type: entity.type,
        description: entity.description ?? undefined,
        aliases: entity.aliases,
      });
    }

    // Insert facts
    const sourceHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    for (const fact of result.facts) {
      const inserted = core.factStore.insert(core.db, {
        content: fact.content,
        type: fact.type,
        confidence: fact.confidence,
        sourceFile: source,
        sourceHash,
        factDate: fact.date ?? undefined,
        entities: fact.entities,
      });

      // Embed the fact if embedding service is available
      if (core.embeddingService && inserted) {
        try {
          const embedding = await core.embeddingService.embed(fact.content);
          core.embeddingService.store(core.db, inserted.id, embedding);
        } catch (err) {
          logger.debug({ err, factId: inserted.id }, 'Failed to embed fact');
        }
      }
    }
  }

  return {
    get currentSessionKey(): string | null {
      return currentSessionKey;
    },

    ingestMessage(msg: NewMessage): void {
      try {
        queue.enqueue(`msg:${msg.chat_jid}:${msg.id}`, async () => {
          await extractAndStore(
            `${msg.sender_name}: ${msg.content}`,
            `channel:${msg.chat_jid}`,
          );
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to enqueue message ingestion');
      }

      if (currentSessionKey) {
        try {
          core.shortTermStore.remember(core.db, {
            sessionKey: currentSessionKey,
            content: `${msg.sender_name}: ${msg.content}`,
            category: 'message',
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to write message to short-term memory');
        }
      }
    },

    ingestResponse(groupFolder: string, chatJid: string, text: string): void {
      try {
        queue.enqueue(`resp:${groupFolder}:${chatJid}`, async () => {
          await extractAndStore(text, `agent:${groupFolder}`);
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to enqueue response ingestion');
      }

      if (currentSessionKey) {
        try {
          core.shortTermStore.remember(core.db, {
            sessionKey: currentSessionKey,
            content: text,
            category: 'response',
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to write response to short-term memory');
        }
      }
    },

    redactPrompt(prompt: string): { redacted: string; mappings: PiiMapping[] } {
      try {
        const result: RedactionResult = core.redactPii(prompt);
        return { redacted: result.redacted, mappings: result.mappings };
      } catch (err) {
        logger.warn({ err }, 'PII redaction failed, passing prompt through');
        return { redacted: prompt, mappings: [] };
      }
    },

    restoreOutput(text: string, mappings: PiiMapping[]): string {
      try {
        if (mappings.length === 0) return text;
        return core.restorePii(text, mappings);
      } catch (err) {
        logger.warn({ err }, 'PII restoration failed, passing text through');
        return text;
      }
    },

    recordTelemetry(telemetry: ContainerTelemetry, channel?: string): void {
      try {
        core.telemetryRecorder.recordContainerRun({
          sessionKey: currentSessionKey ?? undefined,
          channel,
          totalCostUsd: telemetry.totalCostUsd,
          durationMs: telemetry.durationMs,
          durationApiMs: telemetry.durationApiMs,
          numTurns: telemetry.numTurns,
          usage: telemetry.usage,
          modelUsage: telemetry.modelUsage,
          toolInvocations: telemetry.toolInvocations,
          status: 'success',
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to record container telemetry');
      }
    },

    getBootContext(): string {
      try {
        const now = Date.now();
        if (now - bootContextCachedAt < BOOT_CONTEXT_TTL_MS && cachedBootContext) {
          return cachedBootContext;
        }
        cachedBootContext = core.buildBootContext();
        bootContextCachedAt = now;
        return cachedBootContext;
      } catch (err) {
        logger.warn({ err }, 'Boot context generation failed');
        return '';
      }
    },

    startSession(groupFolder: string, chatJid: string): void {
      try {
        const sessionKey = `${groupFolder}:${chatJid}:${Date.now()}`;
        core.sessionStore.create(core.db, {
          sessionKey,
          channel: chatJid,
          agent: groupFolder,
        });
        currentSessionKey = sessionKey;
      } catch (err) {
        logger.warn({ err }, 'Failed to start session');
      }
    },

    endSession(groupFolder: string, success: boolean): void {
      try {
        const status = success ? 'completed' : 'error';
        // Find the most recent active session for this group
        const active = core.sessionStore.getActive(core.db);
        if (active && active.agent === groupFolder) {
          core.sessionStore.updateStatus(core.db, active.sessionKey, status);
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to end session');
      }
      currentSessionKey = null;
    },

    startPeriodicTasks(): void {
      // Health log: every 1 hour
      const healthTimer = setInterval(() => {
        try {
          logger.info(
            { pending: queue.pending, inflight: queue.inflight },
            'Ingestion queue health',
          );
        } catch {
          // ignore
        }
      }, 60 * 60 * 1000);
      timers.push(healthTimer);
    },

    async close(): Promise<void> {
      // Stop timers
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;

      // Drain queue
      try {
        await queue.drain();
      } catch (err) {
        logger.warn({ err }, 'Error draining ingestion queue');
      }

      // Close core
      try {
        core.close();
      } catch (err) {
        logger.warn({ err }, 'Error closing cambot-core');
      }
    },
  };
}
