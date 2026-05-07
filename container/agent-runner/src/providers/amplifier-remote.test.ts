import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import http from 'http';
import { EventEmitter } from 'events';

import { AmplifierRemoteProvider, __test } from './amplifier-remote.js';
import type { ProviderEvent } from './types.js';

const VALID_ENV = {
  AMPLIFIERD_API_KEY: 'test-key',
  AMPLIFIERD_BASE_URL: 'http://amp.test:8410',
};

interface MockResponse {
  statusCode: number;
  body: string;
}

let mockQueue: Array<MockResponse | { error: Error }> = [];
let captured: Array<{ method: string; path: string; body: string; headers: Record<string, unknown> }> = [];
let httpSpy: ReturnType<typeof spyOn> | null = null;

function enqueueResponse(statusCode: number, body: string): void {
  mockQueue.push({ statusCode, body });
}

function enqueueError(err: Error): void {
  mockQueue.push({ error: err });
}

function installHttpMock(): void {
  httpSpy = spyOn(http, 'request').mockImplementation(((opts: http.RequestOptions, cb?: (res: any) => void) => {
    const req = new EventEmitter() as any;
    let bodyAcc = '';
    req.write = (chunk: string) => {
      bodyAcc += chunk;
    };
    req.end = () => {
      captured.push({
        method: String(opts.method),
        path: String(opts.path),
        body: bodyAcc,
        headers: (opts.headers as Record<string, unknown>) ?? {},
      });
      const next = mockQueue.shift();
      setImmediate(() => {
        if (!next) {
          req.emit('error', new Error('no mock response queued'));
          return;
        }
        if ('error' in next) {
          req.emit('error', next.error);
          return;
        }
        if (cb) {
          const res = new EventEmitter() as any;
          res.statusCode = next.statusCode;
          cb(res);
          setImmediate(() => {
            res.emit('data', Buffer.from(next.body));
            res.emit('end');
          });
        }
      });
    };
    req.destroy = () => {};
    return req;
  }) as any);
}

beforeEach(() => {
  mockQueue = [];
  captured = [];
  installHttpMock();
});

afterEach(() => {
  httpSpy?.mockRestore();
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('AmplifierRemoteProvider', () => {
  describe('readConfig', () => {
    it('throws when AMPLIFIERD_API_KEY missing', () => {
      expect(() => __test.readConfig({ AMPLIFIERD_BASE_URL: 'x' })).toThrow(/API_KEY/);
    });

    it('throws when AMPLIFIERD_BASE_URL missing', () => {
      expect(() => __test.readConfig({ AMPLIFIERD_API_KEY: 'x' })).toThrow(/BASE_URL/);
    });

    it('uses defaults for bundle / max-bytes / timeout', () => {
      const cfg = __test.readConfig(VALID_ENV);
      expect(cfg.bundle).toBe('joi');
      expect(cfg.maxPromptBytes).toBe(__test.DEFAULT_MAX_PROMPT_BYTES);
      expect(cfg.timeoutMs).toBe(__test.DEFAULT_TIMEOUT_MS);
      expect(cfg.workingDir).toBeUndefined();
    });

    it('honors overrides', () => {
      const cfg = __test.readConfig({
        ...VALID_ENV,
        AMPLIFIERD_BUNDLE: 'custom',
        AMPLIFIERD_WORKING_DIR: '/work',
        AMPLIFIERD_MAX_PROMPT_BYTES: '1024',
        AMPLIFIERD_TIMEOUT_MS: '5000',
      });
      expect(cfg.bundle).toBe('custom');
      expect(cfg.workingDir).toBe('/work');
      expect(cfg.maxPromptBytes).toBe(1024);
      expect(cfg.timeoutMs).toBe(5000);
    });

    it('falls back to default on garbage numeric overrides', () => {
      const cfg = __test.readConfig({
        ...VALID_ENV,
        AMPLIFIERD_MAX_PROMPT_BYTES: 'not-a-number',
        AMPLIFIERD_TIMEOUT_MS: '-50',
      });
      expect(cfg.maxPromptBytes).toBe(__test.DEFAULT_MAX_PROMPT_BYTES);
      expect(cfg.timeoutMs).toBe(__test.DEFAULT_TIMEOUT_MS);
    });
  });

  describe('isStaleSessionError', () => {
    it('matches HTTP 404 error text', () => {
      expect(__test.isStaleSessionError(new Error('amplifierd 404 on executePrompt: Not Found'))).toBe(true);
    });
    it('matches "session not found"', () => {
      expect(__test.isStaleSessionError(new Error('Session Not Found'))).toBe(true);
      expect(__test.isStaleSessionError(new Error('amplifierd: session_not_found'))).toBe(true);
    });
    it('matches HTTP 409 "already executing" — leaked session from a prior killed turn', () => {
      expect(
        __test.isStaleSessionError(
          new Error("amplifierd 409 on executePrompt: Session 'abc-123' is already executing"),
        ),
      ).toBe(true);
    });
    it('does not match unrelated errors', () => {
      expect(__test.isStaleSessionError(new Error('connection refused'))).toBe(false);
      expect(__test.isStaleSessionError(new Error('amplifierd 500: internal'))).toBe(false);
    });
  });

  describe('extractErrorDetail', () => {
    it('extracts string detail from JSON', () => {
      expect(__test.extractErrorDetail('{"detail":"thing exploded"}', 'fb')).toBe('thing exploded');
    });
    it('extracts nested detail.detail (RFC 7807)', () => {
      expect(__test.extractErrorDetail('{"detail":{"detail":"deep","title":"shallow"}}', 'fb')).toBe('deep');
    });
    it('falls back to title when detail.detail missing', () => {
      expect(__test.extractErrorDetail('{"detail":{"title":"oops"}}', 'fb')).toBe('oops');
    });
    it('falls back to body slice on non-JSON', () => {
      expect(__test.extractErrorDetail('totally not json', 'fb')).toBe('totally not json');
    });
    it('returns fallback on empty body', () => {
      expect(__test.extractErrorDetail('', 'fb')).toBe('fb');
    });
  });

  describe('query() — full flow', () => {
    it('creates a session on first turn and yields init + result', async () => {
      enqueueResponse(200, JSON.stringify({ session_id: 'sess-1', status: 'ready' }));
      enqueueResponse(200, JSON.stringify({ response: 'hello back' }));

      const provider = new AmplifierRemoteProvider({ env: VALID_ENV });
      const q = provider.query({ prompt: 'hi', cwd: '/workspace' });
      q.end();

      const events = await collect(q.events);
      expect(events).toEqual([
        { type: 'activity' },
        { type: 'init', continuation: 'sess-1' },
        { type: 'activity' },
        { type: 'result', text: 'hello back' },
      ]);
      expect(captured).toHaveLength(2);
      expect(captured[0]!.path).toBe('/sessions');
      expect(captured[1]!.path).toBe('/sessions/sess-1/execute');
      expect(JSON.parse(captured[0]!.body)).toEqual({ bundle_name: 'joi' });
      expect(JSON.parse(captured[1]!.body)).toEqual({ prompt: 'hi' });
      expect(captured[0]!.headers.Authorization).toBe('Bearer test-key');
    });

    it('reuses continuation token without creating a new session', async () => {
      enqueueResponse(200, JSON.stringify({ response: 'second turn' }));

      const provider = new AmplifierRemoteProvider({ env: VALID_ENV });
      const q = provider.query({ prompt: 'hello again', cwd: '/workspace', continuation: 'sess-existing' });
      q.end();

      const events = await collect(q.events);
      expect(events.filter((e) => e.type === 'init')).toHaveLength(0);
      expect(events).toContainEqual({ type: 'result', text: 'second turn' });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.path).toBe('/sessions/sess-existing/execute');
    });

    it('on stale-session 404 with cached continuation, creates fresh session and retries once', async () => {
      enqueueResponse(404, JSON.stringify({ detail: 'session not found' }));
      enqueueResponse(200, JSON.stringify({ session_id: 'sess-fresh', status: 'ready' }));
      enqueueResponse(200, JSON.stringify({ response: 'after retry' }));

      const provider = new AmplifierRemoteProvider({ env: VALID_ENV });
      const q = provider.query({ prompt: 'p', cwd: '/workspace', continuation: 'sess-stale' });
      q.end();

      const events = await collect(q.events);
      expect(events).toContainEqual({ type: 'init', continuation: 'sess-fresh' });
      expect(events).toContainEqual({ type: 'result', text: 'after retry' });
      expect(captured).toHaveLength(3);
      expect(captured[0]!.path).toBe('/sessions/sess-stale/execute');
      expect(captured[1]!.path).toBe('/sessions');
      expect(captured[2]!.path).toBe('/sessions/sess-fresh/execute');
    });

    it('does NOT retry on non-stale errors', async () => {
      enqueueResponse(500, JSON.stringify({ detail: 'internal error' }));

      const provider = new AmplifierRemoteProvider({ env: VALID_ENV });
      const q = provider.query({ prompt: 'p', cwd: '/workspace', continuation: 'sess-existing' });
      q.end();

      const events = await collect(q.events);
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
      expect((errs[0] as { message: string }).message).toMatch(/500.*internal error/);
      expect(captured).toHaveLength(1);
    });

    it('rejects oversize prompts before any HTTP call', async () => {
      enqueueResponse(200, JSON.stringify({ session_id: 'sess-1' }));

      const provider = new AmplifierRemoteProvider({
        env: { ...VALID_ENV, AMPLIFIERD_MAX_PROMPT_BYTES: '10' },
      });
      const q = provider.query({ prompt: 'this prompt is more than ten bytes long', cwd: '/workspace' });
      q.end();

      const events = await collect(q.events);
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
      expect((errs[0] as { message: string }).message).toMatch(/exceeds limit 10 bytes/);
      // createSession was attempted but executePrompt was not — captured should have only the create call
      expect(captured.length).toBeLessThanOrEqual(1);
    });

    it('forwards working_dir to amplifierd when AMPLIFIERD_WORKING_DIR set', async () => {
      enqueueResponse(200, JSON.stringify({ session_id: 'sess-1' }));
      enqueueResponse(200, JSON.stringify({ response: 'ok' }));

      const provider = new AmplifierRemoteProvider({
        env: { ...VALID_ENV, AMPLIFIERD_WORKING_DIR: '/amplifier/work' },
      });
      const q = provider.query({ prompt: 'hi', cwd: '/workspace' });
      q.end();
      await collect(q.events);

      expect(JSON.parse(captured[0]!.body)).toEqual({ bundle_name: 'joi', working_dir: '/amplifier/work' });
    });

    it('handles push() for multi-turn conversation reusing the session', async () => {
      enqueueResponse(200, JSON.stringify({ session_id: 'sess-1' }));
      enqueueResponse(200, JSON.stringify({ response: 'turn 1' }));
      enqueueResponse(200, JSON.stringify({ response: 'turn 2' }));

      const provider = new AmplifierRemoteProvider({ env: VALID_ENV });
      const q = provider.query({ prompt: 'first', cwd: '/workspace' });

      // Iterate while pushing
      const collected: ProviderEvent[] = [];
      const pushAfter = (async () => {
        // Wait a tick for first turn to start, then push and end
        await new Promise((r) => setTimeout(r, 20));
        q.push('second');
        await new Promise((r) => setTimeout(r, 20));
        q.end();
      })();

      for await (const e of q.events) collected.push(e);
      await pushAfter;

      const results = collected.filter((e) => e.type === 'result').map((e) => (e as { text: string }).text);
      expect(results).toEqual(['turn 1', 'turn 2']);
      // Only one createSession (3 calls total: 1 create + 2 execute)
      expect(captured).toHaveLength(3);
      expect(captured[0]!.path).toBe('/sessions');
      expect(captured[1]!.path).toBe('/sessions/sess-1/execute');
      expect(captured[2]!.path).toBe('/sessions/sess-1/execute');
    });
  });

  describe('isSessionInvalid', () => {
    it('delegates to stale-session detector', () => {
      const provider = new AmplifierRemoteProvider({ env: VALID_ENV });
      expect(provider.isSessionInvalid(new Error('amplifierd 404'))).toBe(true);
      expect(provider.isSessionInvalid(new Error('refused'))).toBe(false);
    });
  });
});
