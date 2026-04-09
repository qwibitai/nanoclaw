/**
 * Tests for message.in event emission.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentImpl } from './agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent-config.js';
import { buildRuntimeConfig } from './runtime-config.js';
import { _initTestDatabase, AgentDb } from './db.js';

let tmpDir: string;
const rtConfig = buildRuntimeConfig({}, '/tmp/agentlite-test-pkg');

function createAgent(name: string): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });
  const agent = new AgentImpl(config, rtConfig);
  agent._setDbForTests(db);
  return agent;
}

let db: AgentDb;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-msg-'));
  db = _initTestDatabase();
  // Ensure chat rows exist for FK constraints
  db.storeChatMetadata('tg:12345', '2026-04-07T00:00:00Z', 'Test Chat');
  db.storeChatMetadata('tg:1', '2026-04-07T00:00:00Z', 'Chat 1');
  db.storeChatMetadata('tg:2', '2026-04-07T00:00:00Z', 'Chat 2');
  db.storeChatMetadata('tg:99999', '2026-04-07T00:00:00Z', 'E2E Chat');
  db.storeChatMetadata('dune:agent-1', '2026-04-07T00:00:00Z', 'Dune Agent');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('message.in event', () => {
  it('emits message.in when handler receives a message', () => {
    const agent = createAgent('test');
    const events: unknown[] = [];
    agent.on('message.in', (evt) => events.push(evt));

    // Access the internal handler directly
    const handler = (
      agent as unknown as {
        buildDefaultChannelHandler: () => { onMessage: Function };
      }
    ).buildDefaultChannelHandler();

    handler.onMessage('tg:12345', {
      id: 'msg-1',
      chat_jid: 'tg:12345',
      sender: 'user1',
      sender_name: 'User 1',
      content: 'hello world',
      timestamp: '2026-04-07T12:00:00Z',
      is_from_me: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      jid: 'tg:12345',
      sender: 'user1',
      text: 'hello world',
      timestamp: '2026-04-07T12:00:00Z',
    });
  });

  it('does not emit message.in for remote-control commands', () => {
    const agent = createAgent('test');
    const events: unknown[] = [];
    agent.on('message.in', (evt) => events.push(evt));

    const handler = (
      agent as unknown as {
        buildDefaultChannelHandler: () => { onMessage: Function };
      }
    ).buildDefaultChannelHandler();

    handler.onMessage('tg:12345', {
      id: 'msg-rc',
      chat_jid: 'tg:12345',
      sender: 'user1',
      sender_name: 'User 1',
      content: '/remote-control',
      timestamp: '2026-04-07T12:00:00Z',
      is_from_me: false,
    });

    expect(events).toHaveLength(0);
  });

  it('emits message.in with correct payload fields', () => {
    const agent = createAgent('test');
    const listener = vi.fn();
    agent.on('message.in', listener);

    const handler = (
      agent as unknown as {
        buildDefaultChannelHandler: () => { onMessage: Function };
      }
    ).buildDefaultChannelHandler();

    handler.onMessage('dune:agent-1', {
      id: 'msg-2',
      chat_jid: 'dune:agent-1',
      sender: 'alice',
      sender_name: 'Alice',
      content: '@Andy help me',
      timestamp: '2026-04-07T13:00:00Z',
      is_from_me: false,
    });

    expect(listener).toHaveBeenCalledOnce();
    const evt = listener.mock.calls[0][0];
    expect(evt.jid).toBe('dune:agent-1');
    expect(evt.sender).toBe('alice');
    expect(evt.text).toBe('@Andy help me');
    expect(evt.timestamp).toBe('2026-04-07T13:00:00Z');
  });

  it('emits multiple message.in events for multiple messages', () => {
    const agent = createAgent('test');
    const events: unknown[] = [];
    agent.on('message.in', (evt) => events.push(evt));

    const handler = (
      agent as unknown as {
        buildDefaultChannelHandler: () => { onMessage: Function };
      }
    ).buildDefaultChannelHandler();

    handler.onMessage('tg:1', {
      id: 'msg-a',
      chat_jid: 'tg:1',
      sender: 'user1',
      sender_name: 'User 1',
      content: 'first',
      timestamp: '2026-04-07T12:00:00Z',
      is_from_me: false,
    });

    handler.onMessage('tg:2', {
      id: 'msg-b',
      chat_jid: 'tg:2',
      sender: 'user2',
      sender_name: 'User 2',
      content: 'second',
      timestamp: '2026-04-07T12:01:00Z',
      is_from_me: false,
    });

    expect(events).toHaveLength(2);
    expect((events[0] as { jid: string }).jid).toBe('tg:1');
    expect((events[1] as { jid: string }).jid).toBe('tg:2');
  });

  it('e2e: channel factory receives onMessage that triggers message.in', () => {
    const agent = createAgent('test');
    const events: unknown[] = [];
    agent.on('message.in', (evt) => events.push(evt));

    // Simulate what happens inside addChannel → factory(config)
    // The factory receives config.onMessage — calling it should trigger message.in
    const config = (
      agent as unknown as { _buildDriverConfig: () => { onMessage: Function } }
    )._buildDriverConfig();

    // This is what a real ChannelDriver would call when it receives a message
    config.onMessage('tg:99999', {
      id: 'msg-e2e',
      chat_jid: 'tg:99999',
      sender: 'telegram-user',
      sender_name: 'Telegram User',
      content: 'hello from telegram',
      timestamp: '2026-04-07T14:00:00Z',
      is_from_me: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      jid: 'tg:99999',
      sender: 'telegram-user',
      text: 'hello from telegram',
      timestamp: '2026-04-07T14:00:00Z',
    });
  });
});
