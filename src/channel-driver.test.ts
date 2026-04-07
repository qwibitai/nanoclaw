/**
 * Tests for ChannelDriverFactory + class-based ChannelDriver.
 *
 * Verifies that prototype methods survive the factory → addChannel flow.
 * Regression test for: object spread dropping prototype methods on class instances.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentImpl } from './agent-impl.js';
import { buildAgentConfig } from './agent-config.js';
import { buildRuntimeConfig } from './runtime-config.js';
import { _initTestDatabase } from './db.js';
import type { Channel } from './types.js';
import type { ChannelDriverFactory } from './api/channel-driver.js';

let tmpDir: string;
const rtConfig = buildRuntimeConfig({}, '/tmp/agentlite-test-pkg');

function createAgent(name: string): AgentImpl {
  const config = buildAgentConfig(
    name,
    { workdir: path.join(tmpDir, 'agents', name) },
    tmpDir,
  );
  return new AgentImpl(config, rtConfig);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-chdrv-'));
  _initTestDatabase();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// A class-based ChannelDriver — methods are on the prototype, not own properties
class MockChannel implements Channel {
  name = '';
  private _connected = false;
  readonly connectCalls: string[] = [];
  readonly sendCalls: Array<{ jid: string; text: string }> = [];

  async connect(): Promise<void> {
    this._connected = true;
    this.connectCalls.push('connect');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    this.sendCalls.push({ jid, text });
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mock:');
  }
}

describe('ChannelDriverFactory with class-based driver', () => {
  it('class prototype methods survive addChannel (regression)', async () => {
    const agent = createAgent('test');

    // Simulate start() setting _started = true (without full DB/subsystem init)
    (agent as unknown as { _started: boolean })._started = true;

    const mockChannel = new MockChannel();
    const factory: ChannelDriverFactory = (_config) => mockChannel;

    await agent.addChannel('mock', factory);

    // Verify connect() was called — this would fail with "connect is not a function"
    // if object spread dropped the prototype
    expect(mockChannel.connectCalls).toEqual(['connect']);
    expect(mockChannel.isConnected()).toBe(true);
  });

  it('channel.name is set to the key', async () => {
    const agent = createAgent('test');
    (agent as unknown as { _started: boolean })._started = true;

    const mockChannel = new MockChannel();
    const factory: ChannelDriverFactory = (_config) => mockChannel;

    await agent.addChannel('my-channel', factory);

    expect(mockChannel.name).toBe('my-channel');
  });

  it('disconnect works on class-based channel', async () => {
    const agent = createAgent('test');
    (agent as unknown as { _started: boolean })._started = true;

    const mockChannel = new MockChannel();
    const factory: ChannelDriverFactory = (_config) => mockChannel;

    await agent.addChannel('mock', factory);
    expect(mockChannel.isConnected()).toBe(true);

    await agent.removeChannel('mock');
    expect(mockChannel.isConnected()).toBe(false);
  });

  it('factory receives ChannelDriverConfig with callbacks', async () => {
    const agent = createAgent('test');
    (agent as unknown as { _started: boolean })._started = true;

    let receivedConfig: unknown = null;
    const factory: ChannelDriverFactory = (config) => {
      receivedConfig = config;
      return new MockChannel();
    };

    await agent.addChannel('mock', factory);

    expect(receivedConfig).not.toBeNull();
    const config = receivedConfig as Record<string, unknown>;
    expect(typeof config.onMessage).toBe('function');
    expect(typeof config.onChatMetadata).toBe('function');
    expect(typeof config.registeredGroups).toBe('function');
  });

  it('async factory works', async () => {
    const agent = createAgent('test');
    (agent as unknown as { _started: boolean })._started = true;

    const mockChannel = new MockChannel();
    const factory: ChannelDriverFactory = async (_config) => {
      await new Promise((r) => setTimeout(r, 1));
      return mockChannel;
    };

    await agent.addChannel('async-mock', factory);

    expect(mockChannel.connectCalls).toEqual(['connect']);
    expect(mockChannel.name).toBe('async-mock');
  });

  it('duplicate key throws', async () => {
    const agent = createAgent('test');
    (agent as unknown as { _started: boolean })._started = true;

    const factory: ChannelDriverFactory = (_config) => new MockChannel();

    await agent.addChannel('dup', factory);
    await expect(agent.addChannel('dup', factory)).rejects.toThrow(
      'already registered',
    );
  });

  it('ownsJid works on class-based channel after addChannel', async () => {
    const agent = createAgent('test');
    (agent as unknown as { _started: boolean })._started = true;

    const mockChannel = new MockChannel();
    const factory: ChannelDriverFactory = (_config) => mockChannel;

    await agent.addChannel('mock', factory);

    // Access internal _channels to verify ownsJid works
    const channels = (agent as unknown as { _channels: Map<string, Channel> })
      ._channels;
    const ch = channels.get('mock')!;
    expect(ch.ownsJid('mock:123')).toBe(true);
    expect(ch.ownsJid('tg:123')).toBe(false);
  });
});
