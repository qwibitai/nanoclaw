/**
 * Tests for Effect-based message queue
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Effect, Exit } from 'effect';
import {
  makeMessageQueue,
  MessageSendError,
  ConcurrencyLimitError,
  type MessageQueueService,
} from './message-queue.js';
import type { AgentBackend } from '../backends/types.js';

// Mock backend
class MockBackend implements Partial<AgentBackend> {
  public sendMessageCalls: Array<{ groupFolder: string; text: string }> = [];
  public shouldSucceed = true;
  public name = 'mock-backend';

  sendMessage(groupFolder: string, text: string): boolean {
    this.sendMessageCalls.push({ groupFolder, text });
    return this.shouldSucceed;
  }

  reset() {
    this.sendMessageCalls = [];
    this.shouldSucceed = true;
  }
}

describe('Effect Message Queue', () => {
  let queue: MessageQueueService;
  let mockBackend: MockBackend;

  beforeEach(async () => {
    mockBackend = new MockBackend();
    queue = await Effect.runPromise(makeMessageQueue({
      maxConcurrent: 2,
      maxRetries: 3,
      baseRetryDelayMs: 10, // Fast retries for tests
      sendTimeoutMs: 1000,
    }));
  });

  it('should send a message successfully', async () => {
    await queue.registerBackend('group1', mockBackend as AgentBackend, 'folder1')
      .pipe(Effect.runPromise);

    const result = await queue.sendMessage('group1', 'Hello world')
      .pipe(
        Effect.runPromiseExit,
      );

    expect(Exit.isSuccess(result)).toBe(true);
    expect(mockBackend.sendMessageCalls).toHaveLength(1);
    expect(mockBackend.sendMessageCalls[0]).toEqual({
      groupFolder: 'folder1',
      text: 'Hello world',
    });
  });

  it('should retry on failure and eventually succeed', async () => {
    await queue.registerBackend('group1', mockBackend as AgentBackend, 'folder1')
      .pipe(Effect.runPromise);

    let callCount = 0;
    const originalSendMessage = mockBackend.sendMessage.bind(mockBackend);
    mockBackend.sendMessage = (groupFolder: string, text: string) => {
      callCount++;
      if (callCount < 3) {
        // Fail first 2 attempts
        return false;
      }
      return originalSendMessage(groupFolder, text);
    };

    const result = await queue.sendMessage('group1', 'Retry test')
      .pipe(Effect.runPromiseExit);

    expect(Exit.isSuccess(result)).toBe(true);
    expect(callCount).toBe(3); // Failed twice, succeeded on third
  });

  it('should fail after max retries', async () => {
    await queue.registerBackend('group1', mockBackend as AgentBackend, 'folder1')
      .pipe(Effect.runPromise);

    mockBackend.shouldSucceed = false;

    const result = await queue.sendMessage('group1', 'Will fail')
      .pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(result.cause._tag).toBe('Fail');
      if (result.cause._tag === 'Fail') {
        expect(result.cause.error._tag).toBe('MessageSendError');
      }
    }
  });

  it('should fail if no backend registered', async () => {
    const result = await queue.sendMessage('group1', 'No backend')
      .pipe(Effect.runPromiseExit);

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(result.cause._tag).toBe('Fail');
      if (result.cause._tag === 'Fail') {
        const error = result.cause.error as MessageSendError;
        expect(error._tag).toBe('MessageSendError');
        expect(error.retryable).toBe(false);
      }
    }
  });

  it('should enforce concurrency limits', async () => {
    const slowBackend = new MockBackend();
    const originalSend = slowBackend.sendMessage.bind(slowBackend);
    slowBackend.sendMessage = (groupFolder: string, text: string) => {
      // Slow operation
      return originalSend(groupFolder, text);
    };

    await queue.registerBackend('group1', slowBackend as AgentBackend, 'folder1')
      .pipe(Effect.runPromise);

    // Start 3 concurrent sends (limit is 2)
    const send1 = queue.sendMessage('group1', 'Message 1')
      .pipe(Effect.runPromiseExit);
    const send2 = queue.sendMessage('group1', 'Message 2')
      .pipe(Effect.runPromiseExit);
    const send3 = queue.sendMessage('group1', 'Message 3')
      .pipe(Effect.runPromiseExit);

    const [result1, result2, result3] = await Promise.all([send1, send2, send3]);

    // At least one should hit the concurrency limit
    const failures = [result1, result2, result3].filter(Exit.isFailure);
    expect(failures.length).toBeGreaterThan(0);

    // Check that the failure is due to concurrency
    const concurrencyErrors = failures.filter((r) => {
      if (r.cause._tag === 'Fail') {
        return r.cause.error._tag === 'ConcurrencyLimitError';
      }
      return false;
    });
    expect(concurrencyErrors.length).toBeGreaterThan(0);
  });

  it('should track stats correctly', async () => {
    await queue.registerBackend('group1', mockBackend as AgentBackend, 'folder1')
      .pipe(Effect.runPromise);
    await queue.registerBackend('group2', mockBackend as AgentBackend, 'folder2')
      .pipe(Effect.runPromise);

    const stats = await queue.getStats()
      .pipe(Effect.runPromise);

    expect(stats.totalGroups).toBe(2);
    expect(stats.activeCount).toBe(0);
  });

  it('should use provided backend over registered backend', async () => {
    const backend1 = new MockBackend();
    const backend2 = new MockBackend();

    await queue.registerBackend('group1', backend1 as AgentBackend, 'folder1')
      .pipe(Effect.runPromise);

    // Send with explicit backend (should override registered one)
    await queue.sendMessage('group1', 'Override test', backend2 as AgentBackend, 'folder2')
      .pipe(Effect.runPromise);

    expect(backend1.sendMessageCalls).toHaveLength(0);
    expect(backend2.sendMessageCalls).toHaveLength(1);
    expect(backend2.sendMessageCalls[0]).toEqual({
      groupFolder: 'folder2',
      text: 'Override test',
    });
  });
});
