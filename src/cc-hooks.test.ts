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
    expect(extractCcEventType({ event_type: 'task_review_ready' })).toBe(
      'task_review_ready',
    );
  });

  it('extracts event type from nested event object', () => {
    expect(extractCcEventType({ event: { type: 'pipeline_stalled' } })).toBe(
      'pipeline_stalled',
    );
  });

  it('returns null for unknown event type', () => {
    expect(extractCcEventType({ event_type: 'unknown_event' })).toBeNull();
  });
});

describe('routeCcEvent', () => {
  it('routes task_review_ready to hook session with diff context', async () => {
    const createHookSessionMessage = vi.fn();
    const sendAdamWhatsApp = vi.fn(async (_message: string) => {});

    await routeCcEvent(
      'task_review_ready',
      {
        task_id: 'task-123',
        task_title: 'Review checkout refactor',
        pr_url: 'https://example.com/pr/12',
        pr_diff: 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;',
      },
      { createHookSessionMessage, sendAdamWhatsApp },
    );

    expect(createHookSessionMessage).toHaveBeenCalledTimes(1);
    expect(sendAdamWhatsApp).not.toHaveBeenCalled();

    const hookMessage = createHookSessionMessage.mock.calls[0]?.[2];
    expect(hookMessage).toContain(`@${ASSISTANT_NAME}`);
    expect(hookMessage).toContain('PR Diff Context');
    expect(hookMessage).toContain('diff --git a/src/a.ts b/src/a.ts');
  });

  it('routes pipeline_stalled to WhatsApp alert', async () => {
    const createHookSessionMessage = vi.fn();
    const sendAdamWhatsApp = vi.fn(async (_message: string) => {});

    await routeCcEvent(
      'pipeline_stalled',
      {
        pipeline: 'deploy-main',
        task_id: 'task-999',
      },
      { createHookSessionMessage, sendAdamWhatsApp },
    );

    expect(createHookSessionMessage).not.toHaveBeenCalled();
    expect(sendAdamWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendAdamWhatsApp.mock.calls[0]?.[0]).toContain('pipeline stalled');
  });
});

describe('createCcWebhookHandler', () => {
  const deps = {
    createHookSessionMessage: vi.fn(),
    sendAdamWhatsApp: vi.fn(async (_message: string) => {}),
  };

  let server: http.Server;
  let baseUrl = '';

  beforeEach(async () => {
    deps.createHookSessionMessage.mockReset();
    deps.sendAdamWhatsApp.mockReset();
    deps.sendAdamWhatsApp.mockImplementation(async (_message: string) => {});

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
      body: JSON.stringify({ event_type: 'task_review_ready' }),
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
        event_type: 'task_review_ready',
        task_id: 'task-abc',
        pr_diff: 'diff --git a/file.ts b/file.ts\n+1',
      }),
    });

    expect(response.status).toBe(202);
    expect(deps.createHookSessionMessage).toHaveBeenCalledTimes(1);
  });
});
