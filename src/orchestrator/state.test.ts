import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  setRouterState,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import type { NewMessage } from '../types.js';

import {
  createState,
  getOrRecoverCursor,
  loadState,
  saveState,
} from './state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('createState', () => {
  it('returns a fresh, empty state object', () => {
    const s = createState();
    expect(s.lastTimestamp).toBe('');
    expect(s.sessions).toEqual({});
    expect(s.registeredGroups).toEqual({});
    expect(s.lastAgentTimestamp).toEqual({});
    expect(s.messageLoopRunning).toBe(false);
    expect(s.lastUsage).toEqual({});
    expect(s.compactCount).toEqual({});
    expect(s.lastRateLimit).toEqual({});
    expect(s.compactPending.size).toBe(0);
    expect(s.deferredCompact.size).toBe(0);
  });

  it('returns independent instances', () => {
    const a = createState();
    const b = createState();
    a.lastTimestamp = 'touched';
    a.compactPending.add('x');
    expect(b.lastTimestamp).toBe('');
    expect(b.compactPending.has('x')).toBe(false);
  });
});

describe('loadState', () => {
  it('hydrates from the router_state rows and DAO helpers', () => {
    setRouterState('last_timestamp', '2026-01-01T00:00:00.000Z');
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify({ 'chat@g.us': '2026-01-01T00:00:01.000Z' }),
    );
    const s = createState();
    loadState(s);
    expect(s.lastTimestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(s.lastAgentTimestamp).toEqual({
      'chat@g.us': '2026-01-01T00:00:01.000Z',
    });
  });

  it('resets lastAgentTimestamp when the stored JSON is corrupted', () => {
    setRouterState('last_agent_timestamp', 'not-json');
    const s = createState();
    loadState(s);
    expect(s.lastAgentTimestamp).toEqual({});
  });

  it('treats missing router_state rows as empty defaults', () => {
    const s = createState();
    loadState(s);
    expect(s.lastTimestamp).toBe('');
    expect(s.lastAgentTimestamp).toEqual({});
  });
});

describe('saveState', () => {
  it('writes lastTimestamp and lastAgentTimestamp to router_state', () => {
    const s = createState();
    s.lastTimestamp = '2026-02-01T00:00:00.000Z';
    s.lastAgentTimestamp = { 'x@g.us': '2026-02-01T00:00:05.000Z' };
    saveState(s);

    const hydrated = createState();
    loadState(hydrated);
    expect(hydrated.lastTimestamp).toBe('2026-02-01T00:00:00.000Z');
    expect(hydrated.lastAgentTimestamp).toEqual({
      'x@g.us': '2026-02-01T00:00:05.000Z',
    });
  });
});

describe('getOrRecoverCursor', () => {
  it('returns the existing cursor when one is set', () => {
    const s = createState();
    s.lastAgentTimestamp['chat@g.us'] = '2026-03-01T00:00:00.000Z';
    expect(getOrRecoverCursor(s, 'chat@g.us', 'Andy')).toBe(
      '2026-03-01T00:00:00.000Z',
    );
  });

  it('recovers from the most recent bot message when no cursor exists', () => {
    const s = createState();
    // storeMessage requires the chat FK to exist first
    storeChatMetadata(
      'chat@g.us',
      '2026-04-01T00:00:00.000Z',
      'Chat',
      'wa',
      true,
    );
    const botMessage: NewMessage = {
      id: 'm1',
      chat_jid: 'chat@g.us',
      sender: 'bot@s.whatsapp.net',
      sender_name: 'Andy',
      content: 'Andy: hi',
      timestamp: '2026-04-01T00:00:00.000Z',
      is_bot_message: true,
    };
    storeMessage(botMessage);
    const cursor = getOrRecoverCursor(s, 'chat@g.us', 'Andy');
    expect(cursor).toBe('2026-04-01T00:00:00.000Z');
    // Side effect: cursor is cached back onto state and persisted
    expect(s.lastAgentTimestamp['chat@g.us']).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns empty string when there is no prior bot message', () => {
    const s = createState();
    expect(getOrRecoverCursor(s, 'unknown@g.us', 'Andy')).toBe('');
  });
});
