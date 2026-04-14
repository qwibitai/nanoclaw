import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/test-groups',
}));

import {
  matchPattern,
  eventMatchesRule,
  processEvent,
  formatNotification,
  type EventMatchRule,
  type EventRouterDeps,
} from '../event-router.js';
import type { NanoClawEvent, EmailReceivedEvent } from '../events.js';

describe('matchPattern', () => {
  it('matches wildcard "*"', () => {
    expect(matchPattern('anything', '*')).toBe(true);
  });

  it('matches suffix pattern "*@alto.com"', () => {
    expect(matchPattern('user@alto.com', '*@alto.com')).toBe(true);
    expect(matchPattern('user@other.com', '*@alto.com')).toBe(false);
  });

  it('matches prefix pattern "urgent*"', () => {
    expect(matchPattern('urgent task', 'urgent*')).toBe(true);
    expect(matchPattern('not urgent', 'urgent*')).toBe(false);
  });

  it('matches contains pattern "*keyword*"', () => {
    expect(matchPattern('has keyword inside', '*keyword*')).toBe(true);
    expect(matchPattern('no match here', '*keyword*')).toBe(false);
  });

  it('matches exact string (case insensitive)', () => {
    expect(matchPattern('Hello', 'hello')).toBe(true);
    expect(matchPattern('hello', 'HELLO')).toBe(true);
    expect(matchPattern('world', 'hello')).toBe(false);
  });
});

describe('eventMatchesRule', () => {
  it('matches by event source', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {},
    };
    const rule: EventMatchRule = { source: 'email-sse', action: 'notify' };
    expect(eventMatchesRule(event, rule)).toBe(true);
  });

  it('matches by event type prefix', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {},
    };
    const rule: EventMatchRule = { source: 'email', action: 'notify' };
    expect(eventMatchesRule(event, rule)).toBe(true);
  });

  it('does not match different source', () => {
    const event: NanoClawEvent = {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {},
    };
    const rule: EventMatchRule = { source: 'email-sse', action: 'notify' };
    expect(eventMatchesRule(event, rule)).toBe(false);
  });

  it('matches payload patterns', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: { sender: 'ceo@alto.com', subject: 'urgent deal' },
    };
    const rule: EventMatchRule = {
      source: 'email-sse',
      match: { sender: '*@alto.com' },
      action: 'notify',
    };
    expect(eventMatchesRule(event, rule)).toBe(true);
  });

  it('fails when payload pattern does not match', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: { sender: 'user@other.com' },
    };
    const rule: EventMatchRule = {
      source: 'email-sse',
      match: { sender: '*@alto.com' },
      action: 'notify',
    };
    expect(eventMatchesRule(event, rule)).toBe(false);
  });

  it('fails when payload key is missing', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {},
    };
    const rule: EventMatchRule = {
      source: 'email-sse',
      match: { sender: '*@alto.com' },
      action: 'notify',
    };
    expect(eventMatchesRule(event, rule)).toBe(false);
  });

  it('matches numeric payload values', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: { count: 5 },
    };
    const rule: EventMatchRule = {
      source: 'email-sse',
      match: { count: 5 },
      action: 'notify',
    };
    expect(eventMatchesRule(event, rule)).toBe(true);
  });
});

describe('formatNotification', () => {
  it('formats notification with priority and label', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: { count: 3, connection: 'primary' },
    };
    const rule: EventMatchRule = {
      source: 'email-sse',
      action: 'notify',
      priority: 'high',
      label: 'New emails',
    };
    const result = formatNotification(event, rule);
    expect(result).toContain('New emails');
    expect(result).toContain('\u{26A0}\u{FE0F}');
    expect(result).toContain('count: 3');
  });

  it('uses event type as label when none provided', () => {
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {},
    };
    const rule: EventMatchRule = { source: 'email-sse', action: 'notify' };
    const result = formatNotification(event, rule);
    expect(result).toContain('email.received from email-sse');
  });
});

describe('processEvent', () => {
  let deps: EventRouterDeps;
  let sendMessage: (jid: string, text: string) => Promise<void>;
  let enqueueTask: (chatJid: string, prompt: string, groupFolder: string) => void;

  beforeEach(() => {
    sendMessage = vi.fn<(jid: string, text: string) => Promise<void>>().mockResolvedValue(undefined);
    enqueueTask = vi.fn<(chatJid: string, prompt: string, groupFolder: string) => void>();
    deps = {
      sendMessage,
      enqueueTask,
      registeredGroups: () => ({}),
    };
  });

  it('does nothing when no groups have rules', () => {
    deps.registeredGroups = () => ({
      'jid@test': { folder: 'test_group', name: 'Test' },
    });
    // No events.json file exists for test_group
    const event: NanoClawEvent = {
      type: 'email.received',
      source: 'email-sse',
      timestamp: Date.now(),
      payload: {},
    };
    processEvent(event, deps);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
