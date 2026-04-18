import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleWebhookEvent } from '../webhook-consumer.js';

describe('handleWebhookEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues a task when webhook event has a payload', () => {
    const mockEnqueue = vi.fn();
    const event = {
      type: 'webhook.github',
      payload: {
        action: 'opened',
        pull_request: { title: 'test PR', number: 42 },
      },
      source: 'github',
      receivedAt: new Date().toISOString(),
    };

    handleWebhookEvent(event, mockEnqueue, 'main');

    expect(mockEnqueue).toHaveBeenCalledOnce();
    const prompt = mockEnqueue.mock.calls[0][0];
    expect(prompt).toContain('webhook');
    expect(prompt).toContain('github');
  });

  it('skips events with empty payload', () => {
    const mockEnqueue = vi.fn();
    const event = {
      type: 'webhook.generic',
      payload: {},
      source: 'generic',
      receivedAt: new Date().toISOString(),
    };

    handleWebhookEvent(event, mockEnqueue, 'main');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('truncates large payloads in the prompt', () => {
    const mockEnqueue = vi.fn();
    const event = {
      type: 'webhook.large',
      payload: { data: 'x'.repeat(2000) },
      source: 'large',
      receivedAt: new Date().toISOString(),
    };

    handleWebhookEvent(event, mockEnqueue, 'main');
    const prompt = mockEnqueue.mock.calls[0][0];
    expect(prompt.length).toBeLessThan(1500);
  });

  it('includes the source in the prompt', () => {
    const mockEnqueue = vi.fn();
    const event = {
      type: 'webhook.notion',
      payload: { page_id: 'abc123' },
      source: 'notion',
      receivedAt: new Date().toISOString(),
    };

    handleWebhookEvent(event, mockEnqueue, 'main');
    const prompt = mockEnqueue.mock.calls[0][0];
    expect(prompt).toContain('notion');
  });
});
