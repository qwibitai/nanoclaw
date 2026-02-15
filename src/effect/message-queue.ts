/**
 * Effect-based message queue implementation
 * Provides retry logic, timeout protection, and type-safe error handling
 */

import { Effect, Layer, Ref, Schedule } from 'effect';
import * as S from '@effect/schema/Schema';
import { logger } from '../logger.js';
import type { AgentBackend } from '../backends/types.js';

// ============================================================================
// Error Types
// ============================================================================

export class MessageSendError extends S.TaggedError<MessageSendError>()(
  'MessageSendError',
  {
    groupJid: S.String,
    reason: S.String,
    retryable: S.Boolean,
  },
) {}

export class ConcurrencyLimitError extends S.TaggedError<ConcurrencyLimitError>()(
  'ConcurrencyLimitError',
  {
    activeCount: S.Number,
    maxConcurrent: S.Number,
  },
) {}

// ============================================================================
// Domain Types
// ============================================================================

export const GroupState = S.Struct({
  groupJid: S.String,
  active: S.Boolean,
  retryCount: S.Number,
  backend: S.Union(S.Unknown, S.Null),
  groupFolder: S.Union(S.String, S.Null),
});
export type GroupState = S.Schema.Type<typeof GroupState>;

// ============================================================================
// Message Queue Service
// ============================================================================

export interface MessageQueueConfig {
  maxConcurrent: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  sendTimeoutMs: number;
}

const defaultConfig: MessageQueueConfig = {
  maxConcurrent: 5,
  maxRetries: 5,
  baseRetryDelayMs: 5000,
  sendTimeoutMs: 30000,
};

/**
 * Service interface for the message queue
 */
export interface MessageQueueService {
  /**
   * Send a message to a group with automatic retries and timeout protection
   */
  sendMessage: (
    groupJid: string,
    text: string,
    backend?: AgentBackend,
    groupFolder?: string,
  ) => Effect.Effect<void, MessageSendError | ConcurrencyLimitError>;

  /**
   * Register a backend for a group
   */
  registerBackend: (
    groupJid: string,
    backend: AgentBackend,
    groupFolder: string,
  ) => Effect.Effect<void>;

  /**
   * Mark a group as active/inactive
   */
  setActive: (groupJid: string, active: boolean) => Effect.Effect<void>;

  /**
   * Get current queue stats
   */
  getStats: () => Effect.Effect<{
    activeCount: number;
    totalGroups: number;
  }>;
}

/**
 * Tag for dependency injection
 */
export class MessageQueue extends Effect.Tag('MessageQueue')<
  MessageQueue,
  MessageQueueService
>() {}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Internal state for a group
 */
interface InternalGroupState {
  active: boolean;
  retryCount: number;
  backend: AgentBackend | null;
  groupFolder: string | null;
}

/**
 * Create the message queue service implementation
 */
export const makeMessageQueue = (
  config: MessageQueueConfig = defaultConfig,
): Effect.Effect<MessageQueueService> => {
  return Effect.gen(function* (_) {
    // Shared state
    const groupStates = yield* _(
      Ref.make(new Map<string, InternalGroupState>()),
    );
    const activeCount = yield* _(Ref.make(0));

    // Helper: Get or create group state (atomic to prevent race conditions)
    const getGroupState = (
      groupJid: string,
    ): Effect.Effect<InternalGroupState> =>
      Ref.modify(groupStates, (states) => {
        let state = states.get(groupJid);
        if (!state) {
          state = {
            active: false,
            retryCount: 0,
            backend: null,
            groupFolder: null,
          };
          const newStates = new Map(states);
          newStates.set(groupJid, state);
          return [state, newStates] as const;
        }
        return [state, states] as const;
      });

    // Helper: Update group state
    const updateGroupState = (
      groupJid: string,
      update: Partial<InternalGroupState>,
    ): Effect.Effect<void> =>
      Ref.update(groupStates, (states) => {
        const newStates = new Map(states);
        const current = newStates.get(groupJid) || {
          active: false,
          retryCount: 0,
          backend: null,
          groupFolder: null,
        };
        newStates.set(groupJid, { ...current, ...update });
        return newStates;
      });

    // Core message send operation (no retry/timeout yet)
    const sendMessageCore = (
      groupJid: string,
      text: string,
      backend?: AgentBackend,
      groupFolder?: string,
    ): Effect.Effect<void, MessageSendError> =>
      Effect.gen(function* (_) {
        const state = yield* _(getGroupState(groupJid));

        // Use provided backend or fall back to registered one
        const targetBackend = backend || state.backend;
        const targetFolder = groupFolder || state.groupFolder;

        if (!targetBackend || !targetFolder) {
          return yield* _(
            Effect.fail(
              new MessageSendError({
                groupJid,
                reason: 'No backend or group folder registered',
                retryable: false,
              }),
            ),
          );
        }

        // Attempt to send via backend (wrap in try to catch sync exceptions)
        const sendResult = yield* _(
          Effect.try({
            try: () => targetBackend.sendMessage(targetFolder, text),
            catch: (error) =>
              new MessageSendError({
                groupJid,
                reason: `Backend sendMessage threw: ${error}`,
                retryable: true,
              }),
          }),
        );

        if (!sendResult) {
          return yield* _(
            Effect.fail(
              new MessageSendError({
                groupJid,
                reason: 'Backend sendMessage returned false',
                retryable: true,
              }),
            ),
          );
        }

        // Log success
        logger.debug({ groupJid, textLength: text.length }, 'Message sent via Effect');
      });

    // Retry schedule: exponential backoff
    const retrySchedule = Schedule.exponential(config.baseRetryDelayMs).pipe(
      Schedule.compose(Schedule.recurs(config.maxRetries)),
    );

    // Send message with retry and timeout
    const sendMessage = (
      groupJid: string,
      text: string,
      backend?: AgentBackend,
      groupFolder?: string,
    ): Effect.Effect<void, MessageSendError | ConcurrencyLimitError> =>
      Effect.gen(function* (_) {
        // Atomic check-and-increment for concurrency limit
        const incrementResult = yield* _(
          Ref.modify(activeCount, (current) => {
            if (current >= config.maxConcurrent) {
              return [
                Effect.fail(
                  new ConcurrencyLimitError({
                    activeCount: current,
                    maxConcurrent: config.maxConcurrent,
                  }),
                ),
                current,
              ] as const;
            }
            return [Effect.succeed(undefined), current + 1] as const;
          }),
        );

        // If concurrency limit exceeded, fail early
        yield* _(incrementResult);

        // Send with retry and timeout
        const result = yield* _(
          sendMessageCore(groupJid, text, backend, groupFolder).pipe(
            // Inspect errors before retry: convert non-retryable to defect
            Effect.catchAll((error) => {
              if (error._tag === 'MessageSendError' && !error.retryable) {
                // Non-retryable errors become defects (won't be retried)
                logger.error(
                  { groupJid, error: error.reason },
                  'Message send failed (non-retryable)',
                );
                return Effect.die(error); // Die = unrecoverable defect
              }
              // Retryable errors get re-thrown for retry
              return Effect.fail(error);
            }),
            Effect.retry(retrySchedule),
            Effect.timeout(config.sendTimeoutMs),
            // Catch defects (non-retryable) and convert back to typed failure
            Effect.catchAllDefect((defect) => {
              if (typeof defect === 'object' && defect !== null && '_tag' in defect && defect._tag === 'MessageSendError') {
                return Effect.fail(defect as MessageSendError);
              }
              // Unknown defect
              logger.error({ groupJid, defect }, 'Unknown defect in message send');
              return Effect.fail(
                new MessageSendError({
                  groupJid,
                  reason: `Unknown defect: ${defect}`,
                  retryable: false,
                }),
              );
            }),
            Effect.catchAll((error) => {
              if (error._tag === 'MessageSendError') {
                logger.error(
                  { groupJid, error: error.reason, retryable: error.retryable },
                  'Message send failed after retries',
                );
                return Effect.fail(error);
              }
              // Timeout or other error
              logger.error({ groupJid, error }, 'Message send timeout or unknown error');
              return Effect.fail(
                new MessageSendError({
                  groupJid,
                  reason: 'Timeout or unknown error',
                  retryable: false,
                }),
              );
            }),
            Effect.ensuring(Ref.update(activeCount, (n) => n - 1)),
          ),
        );

        return result;
      });

    // Register backend
    const registerBackend = (
      groupJid: string,
      backend: AgentBackend,
      groupFolder: string,
    ): Effect.Effect<void> =>
      updateGroupState(groupJid, { backend, groupFolder });

    // Set active status
    const setActive = (groupJid: string, active: boolean): Effect.Effect<void> =>
      updateGroupState(groupJid, { active });

    // Get stats
    const getStats = (): Effect.Effect<{
      activeCount: number;
      totalGroups: number;
    }> =>
      Effect.gen(function* (_) {
        const active = yield* _(Ref.get(activeCount));
        const states = yield* _(Ref.get(groupStates));
        return {
          activeCount: active,
          totalGroups: states.size,
        };
      });

    return {
      sendMessage,
      registerBackend,
      setActive,
      getStats,
    };
  });
};

/**
 * Live layer for MessageQueue
 */
export const MessageQueueLive = (config?: Partial<MessageQueueConfig>) =>
  Layer.effect(
    MessageQueue,
    makeMessageQueue({ ...defaultConfig, ...config }),
  );
