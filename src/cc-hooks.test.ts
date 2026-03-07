import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSISTANT_NAME } from './config.js';
import {
  createCcWebhookHandler,
  extractCcEventType,
  routeCcEvent,
} from './cc-hooks.js';

describe('extractCcEventType', () => {
  it('extracts event type from direct payload field', () => {
    expect(extractCcEventType({ event: 'review_ready' })).toBe('review_ready');
  });

  it('normalizes legacy task_review_ready event name', () => {
    expect(extractCcEventType({ event_type: 'task_review_ready' })).toBe(
      'review_ready',
    );
  });

  it('extracts event type from nested event object', () => {
    expect(extractCcEventType({ event: { type: 'task_done' } })).toBe(
      'task_done',
    );
  });

  it('returns null for unknown event type', () => {
    expect(extractCcEventType({ event_type: 'unknown_event' })).toBeNull();
  });
});

describe('routeCcEvent', () => {
  it('routes review_ready to hook session with diff context', async () => {
    const createHookSessionMessage = vi.fn();
    const createMainSessionMessage = vi.fn();

    await routeCcEvent(
      'review_ready',
      {
        task_id: 'task-123',
        task_title: 'Review checkout refactor',
        pr_url: 'https://example.com/pr/12',
        pr_diff: 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;',
      },
      { createHookSessionMessage, createMainSessionMessage },
    );

    expect(createHookSessionMessage).toHaveBeenCalledTimes(1);
    expect(createMainSessionMessage).not.toHaveBeenCalled();

    const hookMessage = createHookSessionMessage.mock.calls[0]?.[2];
    expect(hookMessage).toContain(`@${ASSISTANT_NAME}`);
    expect(hookMessage).toContain('PR Diff Context');
    expect(hookMessage).toContain('diff --git a/src/a.ts b/src/a.ts');
  });

  it('routes task_done to hook session', async () => {
    const createHookSessionMessage = vi.fn();
    const createMainSessionMessage = vi.fn();

    await routeCcEvent(
      'task_done',
      {
        task_id: 'task-999',
        message: 'All checks passed and branch merged.',
      },
      { createHookSessionMessage, createMainSessionMessage },
    );

    expect(createHookSessionMessage).toHaveBeenCalledTimes(1);
    expect(createMainSessionMessage).not.toHaveBeenCalled();
    expect(createHookSessionMessage.mock.calls[0]?.[2]).toContain('task_done');
  });

  it('routes task_failed to main session', async () => {
    const createHookSessionMessage = vi.fn();
    const createMainSessionMessage = vi.fn();

    await routeCcEvent(
      'task_failed',
      {
        task_id: 'task-err',
        message: 'Unit tests failed in CI',
      },
      { createHookSessionMessage, createMainSessionMessage },
    );

    expect(createHookSessionMessage).not.toHaveBeenCalled();
    expect(createMainSessionMessage).toHaveBeenCalledTimes(1);
    expect(createMainSessionMessage.mock.calls[0]?.[2]).toContain(
      'task_failed',
    );
  });
});

describe('createCcWebhookHandler', () => {
  const deps = {
    createHookSessionMessage: vi.fn(),
    createMainSessionMessage: vi.fn(),
  };

  let server: http.Server;
  let baseUrl = '';

  beforeEach(async () => {
    deps.createHookSessionMessage.mockReset();
    deps.createMainSessionMessage.mockReset();

    const handler = createCcWebhookHandler(deps, {
      token: 'secret-token',
      host: '127.0.0.1',
      port: 0,
      webhookUrl: 'http://127.0.0.1:0/hooks/cc',
    });

    server = http.createServer((req, res) => {
      void handler(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects requests with invalid token', async () => {
    const response = await fetch(`${baseUrl}/hooks/cc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cc-webhook-token': 'wrong-token',
      },
      body: JSON.stringify({ event: 'review_ready' }),
    });

    expect(response.status).toBe(401);
    expect(deps.createHookSessionMessage).not.toHaveBeenCalled();
  });

  it('accepts valid review-ready webhook and routes it', async () => {
    const response = await fetch(`${baseUrl}/hooks/cc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cc-webhook-token': 'secret-token',
      },
      body: JSON.stringify({
        event: 'review_ready',
        task_id: 'task-abc',
        pr_diff: 'diff --git a/file.ts b/file.ts\n+1',
      }),
    });

    expect(response.status).toBe(202);
    expect(deps.createHookSessionMessage).toHaveBeenCalledTimes(1);
  });
});
