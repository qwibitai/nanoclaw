// src/__tests__/agentic-ux-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  MessageMeta,
  MessageCategory,
  MessageUrgency,
  ActionStyle,
  Action,
} from '../types.js';

describe('Agentic UX types', () => {
  it('MessageMeta has required fields', () => {
    const meta: MessageMeta = {
      category: 'financial',
      urgency: 'action-required',
      actions: [
        {
          label: 'Confirm',
          callbackData: 'confirm:123',
          style: 'primary',
          confirmRequired: true,
        },
      ],
      batchable: false,
    };
    expect(meta.category).toBe('financial');
    expect(meta.urgency).toBe('action-required');
    expect(meta.actions[0].style).toBe('primary');
    expect(meta.actions[0].confirmRequired).toBe(true);
    expect(meta.batchable).toBe(false);
  });

  it('MessageMeta optional fields', () => {
    const meta: MessageMeta = {
      category: 'auto-handled',
      urgency: 'info',
      actions: [],
      batchable: true,
      miniAppUrl: '/task/abc123',
      emailId: 'msg_123',
      threadId: 'thread_456',
      account: 'personal',
    };
    expect(meta.miniAppUrl).toBe('/task/abc123');
    expect(meta.emailId).toBe('msg_123');
  });
});
