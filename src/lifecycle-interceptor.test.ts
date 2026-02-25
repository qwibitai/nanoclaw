/**
 * Tests for the lifecycle interceptor facade.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLifecycleInterceptor } from './lifecycle-interceptor.js';
import type { LifecycleInterceptor } from './lifecycle-interceptor.js';
import type { Logger } from 'pino';
import type { CamBotCoreServices } from 'cambot-core';

function mockLogger(): Logger {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

function mockCore(overrides: Partial<CamBotCoreServices> = {}): CamBotCoreServices {
  return {
    db: {} as any,
    config: {} as any,
    eventBus: { emit: vi.fn(), on: vi.fn() } as any,
    entityStore: { upsert: vi.fn() } as any,
    factStore: { insert: vi.fn().mockReturnValue({ id: 1 }) } as any,
    extractor: null,
    embeddingService: null,
    searchEngine: {} as any,
    sessionStore: {
      create: vi.fn(),
      getActive: vi.fn().mockReturnValue(null),
      updateStatus: vi.fn(),
    } as any,
    shortTermStore: { remember: vi.fn() } as any,
    sessionSummaryStore: {} as any,
    summarize: null,
    apiCallStore: {} as any,
    costLedgerStore: {} as any,
    securityEventStore: {} as any,
    anomalyDetector: {} as any,
    telemetryRecorder: { recordContainerRun: vi.fn() } as any,
    buildBootContext: vi.fn().mockReturnValue('# Boot Context'),
    redactPii: vi.fn().mockImplementation((text: string) => ({
      redacted: text.replace(/test@example\.com/g, '[EMAIL_1]'),
      mappings: text.includes('test@example.com')
        ? [{ placeholder: '[EMAIL_1]', tag: 'email' as const, originalValue: 'test@example.com' }]
        : [],
      hasPii: text.includes('test@example.com'),
    })),
    restorePii: vi.fn().mockImplementation((text: string, mappings: any[]) => {
      let restored = text;
      for (const m of mappings) {
        restored = restored.replace(m.placeholder, m.originalValue);
      }
      return restored;
    }),
    close: vi.fn(),
    ...overrides,
  };
}

describe('createLifecycleInterceptor', () => {
  let logger: Logger;
  let core: CamBotCoreServices;
  let interceptor: LifecycleInterceptor;

  beforeEach(() => {
    logger = mockLogger();
    core = mockCore();
    interceptor = createLifecycleInterceptor(core, logger);
  });

  afterEach(async () => {
    await interceptor.close();
  });

  describe('redactPrompt', () => {
    it('delegates to core.redactPii', () => {
      const result = interceptor.redactPrompt('Email: test@example.com');

      expect(core.redactPii).toHaveBeenCalledWith('Email: test@example.com');
      expect(result.redacted).toBe('Email: [EMAIL_1]');
      expect(result.mappings).toHaveLength(1);
    });

    it('returns original on error', () => {
      core = mockCore({
        redactPii: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });
      interceptor = createLifecycleInterceptor(core, logger);

      const result = interceptor.redactPrompt('test@example.com');
      expect(result.redacted).toBe('test@example.com');
      expect(result.mappings).toEqual([]);
    });
  });

  describe('restoreOutput', () => {
    it('round-trips PII correctly', () => {
      const { redacted, mappings } = interceptor.redactPrompt('Email: test@example.com');
      const restored = interceptor.restoreOutput(redacted, mappings);

      expect(restored).toBe('Email: test@example.com');
    });

    it('returns original when no mappings', () => {
      const result = interceptor.restoreOutput('hello', []);
      expect(result).toBe('hello');
    });

    it('returns original on error', () => {
      core = mockCore({
        restorePii: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });
      interceptor = createLifecycleInterceptor(core, logger);

      const result = interceptor.restoreOutput('[EMAIL_1]', [
        { placeholder: '[EMAIL_1]', tag: 'email' as any, originalValue: 'x@y.com' },
      ]);
      expect(result).toBe('[EMAIL_1]');
    });
  });

  describe('getBootContext', () => {
    it('returns boot context from core', () => {
      const result = interceptor.getBootContext();
      expect(result).toBe('# Boot Context');
      expect(core.buildBootContext).toHaveBeenCalled();
    });

    it('caches boot context for 60s', () => {
      interceptor.getBootContext();
      interceptor.getBootContext();
      interceptor.getBootContext();

      expect(core.buildBootContext).toHaveBeenCalledTimes(1);
    });

    it('returns empty string on error', () => {
      core = mockCore({
        buildBootContext: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });
      interceptor = createLifecycleInterceptor(core, logger);

      expect(interceptor.getBootContext()).toBe('');
    });
  });

  describe('ingestMessage', () => {
    it('enqueues extraction when extractor is available', async () => {
      const extractFn = vi.fn().mockResolvedValue({ facts: [], entities: [] });
      core = mockCore({
        extractor: { extract: extractFn } as any,
      });
      interceptor = createLifecycleInterceptor(core, logger);

      interceptor.ingestMessage({
        id: '1',
        chat_jid: 'group@g.us',
        sender: '123',
        sender_name: 'Alice',
        content: 'Hello world',
        timestamp: new Date().toISOString(),
      });

      await interceptor.close(); // drain queue

      expect(extractFn).toHaveBeenCalledWith(
        'Alice: Hello world',
        expect.objectContaining({ fileName: 'channel:group@g.us' }),
      );
    });

    it('no-ops when extractor is null', async () => {
      interceptor.ingestMessage({
        id: '1',
        chat_jid: 'group@g.us',
        sender: '123',
        sender_name: 'Alice',
        content: 'Hello world',
        timestamp: new Date().toISOString(),
      });

      // Should complete without error
      await interceptor.close();
    });
  });

  describe('ingestResponse', () => {
    it('enqueues extraction for agent responses', async () => {
      const extractFn = vi.fn().mockResolvedValue({ facts: [], entities: [] });
      core = mockCore({
        extractor: { extract: extractFn } as any,
      });
      interceptor = createLifecycleInterceptor(core, logger);

      interceptor.ingestResponse('main', 'group@g.us', 'Agent says hello');

      await interceptor.close();

      expect(extractFn).toHaveBeenCalledWith(
        'Agent says hello',
        expect.objectContaining({ fileName: 'agent:main' }),
      );
    });
  });

  describe('startSession / endSession', () => {
    it('creates a session on startSession', () => {
      interceptor.startSession('main', 'group@g.us');
      expect(core.sessionStore.create).toHaveBeenCalled();
    });

    it('sets currentSessionKey after startSession', () => {
      expect(interceptor.currentSessionKey).toBeNull();

      interceptor.startSession('main', 'group@g.us');

      expect(interceptor.currentSessionKey).toMatch(/^main:group@g\.us:\d+$/);
    });

    it('clears currentSessionKey after endSession', () => {
      interceptor.startSession('main', 'group@g.us');
      expect(interceptor.currentSessionKey).not.toBeNull();

      interceptor.endSession('main', true);

      expect(interceptor.currentSessionKey).toBeNull();
    });

    it('clears currentSessionKey even when endSession encounters an error', () => {
      interceptor.startSession('main', 'group@g.us');
      (core.sessionStore.getActive as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('db error');
      });

      interceptor.endSession('main', true);

      expect(interceptor.currentSessionKey).toBeNull();
    });

    it('ends the active session on endSession', () => {
      (core.sessionStore.getActive as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionKey: 'test-session',
        agent: 'main',
      });

      interceptor.endSession('main', true);
      expect(core.sessionStore.updateStatus).toHaveBeenCalledWith(
        core.db,
        'test-session',
        'completed',
      );
    });

    it('marks session as error on failure', () => {
      (core.sessionStore.getActive as ReturnType<typeof vi.fn>).mockReturnValue({
        sessionKey: 'test-session',
        agent: 'main',
      });

      interceptor.endSession('main', false);
      expect(core.sessionStore.updateStatus).toHaveBeenCalledWith(
        core.db,
        'test-session',
        'error',
      );
    });

    it('does not throw if no active session', () => {
      expect(() => interceptor.endSession('main', true)).not.toThrow();
    });
  });

  describe('short-term memory', () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: '123',
      sender_name: 'Alice',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
    };

    it('writes inbound message via remember() after startSession', () => {
      interceptor.startSession('main', 'group@g.us');
      interceptor.ingestMessage(msg);

      expect(core.shortTermStore.remember).toHaveBeenCalledWith(
        core.db,
        {
          sessionKey: interceptor.currentSessionKey,
          content: 'Alice: Hello world',
          category: 'message',
        },
      );
    });

    it('writes agent response via remember() after startSession', () => {
      interceptor.startSession('main', 'group@g.us');
      interceptor.ingestResponse('main', 'group@g.us', 'Agent says hello');

      expect(core.shortTermStore.remember).toHaveBeenCalledWith(
        core.db,
        {
          sessionKey: interceptor.currentSessionKey,
          content: 'Agent says hello',
          category: 'response',
        },
      );
    });

    it('does not call remember() when there is no active session (ingestMessage)', () => {
      interceptor.ingestMessage(msg);

      expect(core.shortTermStore.remember).not.toHaveBeenCalled();
    });

    it('does not call remember() when there is no active session (ingestResponse)', () => {
      interceptor.ingestResponse('main', 'group@g.us', 'Agent says hello');

      expect(core.shortTermStore.remember).not.toHaveBeenCalled();
    });

    it('catches and logs remember() errors without throwing', () => {
      (core.shortTermStore.remember as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('sqlite busy');
      });

      interceptor.startSession('main', 'group@g.us');

      expect(() => interceptor.ingestMessage(msg)).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Failed to write message to short-term memory',
      );
    });

    it('catches and logs remember() errors on ingestResponse without throwing', () => {
      (core.shortTermStore.remember as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('sqlite busy');
      });

      interceptor.startSession('main', 'group@g.us');

      expect(() => interceptor.ingestResponse('main', 'group@g.us', 'reply')).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Failed to write response to short-term memory',
      );
    });
  });

  describe('close', () => {
    it('drains queue and closes core', async () => {
      await interceptor.close();
      expect(core.close).toHaveBeenCalled();
    });
  });
});
