import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>(
    './container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

import { AgentImpl } from './agent/agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent/config.js';
import { _initTestDatabase, AgentDb } from './db.js';
import { buildRuntimeConfig } from './runtime-config.js';
import { runContainerAgent } from './container-runner.js';
import type { RunStateEvent } from './api/events.js';
import type { Channel, RegisteredGroup } from './types.js';

const runtimeConfig = buildRuntimeConfig(
  { timezone: 'UTC' },
  '/tmp/agentlite-test-pkg',
);

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let tmpDir: string;
let db: AgentDb;

function createAgent(name: string): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });
  return new AgentImpl(config, runtimeConfig);
}

function createMockChannel(): Channel {
  return {
    name: 'mock',
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    async sendMessage(): Promise<void> {},
    isConnected(): boolean {
      return true;
    },
    ownsJid(jid: string): boolean {
      return jid === 'mock:run-state';
    },
    async setTyping(): Promise<void> {},
  };
}

describe('run.state event', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-run-state-'));
    db = _initTestDatabase();
    vi.mocked(runContainerAgent).mockReset();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits active, idle, and stopped with agentId for message-driven runs', async () => {
    const agent = createAgent('test');
    agent._setDbForTests(db);
    agent._setRegisteredGroups({
      'mock:run-state': MAIN_GROUP,
    });
    (agent as unknown as { _started: boolean })._started = true;

    const channel = createMockChannel();
    (
      agent as unknown as {
        channels: Map<string, Channel>;
      }
    ).channels.set('mock', channel);

    db.storeChatMetadata(
      'mock:run-state',
      '2026-04-11T00:00:00.000Z',
      'Run State Chat',
    );
    db.storeMessage({
      id: 'msg-1',
      chat_jid: 'mock:run-state',
      sender: 'user1',
      sender_name: 'User 1',
      content: 'trigger a run',
      timestamp: '2026-04-11T00:00:01.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _runtimeConfig, _onProcess, onOutput) => {
        await onOutput?.({
          type: 'state',
          state: 'active',
        });
        await onOutput?.({
          type: 'result',
          result: 'hello from the agent',
        });
        await onOutput?.({
          type: 'state',
          state: 'idle',
        });
        await onOutput?.({
          type: 'state',
          state: 'stopped',
          reason: 'exit',
          exitCode: 0,
        });
        return {
          status: 'success',
          result: 'hello from the agent',
        };
      },
    );

    const events: RunStateEvent[] = [];
    agent.on('run.state', (evt) => events.push(evt));

    const processed = await (
      agent as unknown as {
        processGroupMessages: (chatJid: string) => Promise<boolean>;
      }
    ).processGroupMessages('mock:run-state');

    expect(processed).toBe(true);
    expect(events).toHaveLength(3);
    expect(events.map((evt) => evt.state)).toEqual([
      'active',
      'idle',
      'stopped',
    ]);
    for (const evt of events) {
      expect(evt.agentId).toBe(agent.id);
      expect(evt.jid).toBe('mock:run-state');
      expect(evt.name).toBe('Main');
      expect(evt.folder).toBe('main');
      expect(typeof evt.timestamp).toBe('string');
    }
    expect(events[2]).toMatchObject({
      state: 'stopped',
      reason: 'exit',
      exitCode: 0,
    });
  });
});
