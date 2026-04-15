import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', async () => {
  const actual = await vi.importActual<
    typeof import('../container-runner.js')
  >('../container-runner.js');
  return {
    ...actual,
    runContainerAgent: vi.fn(),
  };
});

import { AgentImpl } from '../agent/agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from '../agent/config.js';
import { _initTestDatabase, AgentDb } from '../db.js';
import { buildRuntimeConfig } from '../runtime-config.js';
import { runContainerAgent } from '../container-runner.js';
import type { Channel, RegisteredGroup } from '../types.js';

import { ACP_NOTICE_SENDER, ACP_NOTICE_SENDER_NAME } from './notice.js';

const runtimeConfig = buildRuntimeConfig(
  { timezone: 'UTC' },
  '/tmp/agentlite-test-pkg',
);

const TEAM_GROUP: RegisteredGroup = {
  name: 'Team',
  folder: 'team',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
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
      return jid === 'team@g.us';
    },
    async setTyping(): Promise<void> {},
  };
}

describe('ACP notices', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-acp-notice-'));
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

  it('bypasses trigger requirements when waking a non-main group', async () => {
    const agent = createAgent('acp-notice');
    agent._setDbForTests(db);
    agent._setRegisteredGroups({ 'team@g.us': TEAM_GROUP });
    (agent as unknown as { _started: boolean })._started = true;
    (agent as unknown as { channels: Map<string, Channel> }).channels.set(
      'mock',
      createMockChannel(),
    );

    db.storeChatMetadata('team@g.us', '2026-04-15T00:00:00.000Z', 'Team Chat');
    db.storeMessageDirect({
      id: 'acp-notice-1',
      chat_jid: 'team@g.us',
      sender: ACP_NOTICE_SENDER,
      sender_name: ACP_NOTICE_SENDER_NAME,
      content:
        'ACP prompt finished for session peer-session-1: completed (end_turn). Result file: /workspace/ipc/acp/runs/acp-run-1.json',
      timestamp: '2026-04-15T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: null,
    });

    const ok = await agent.processGroupMessages('team@g.us');
    expect(ok).toBe(true);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    expect(runContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'team' }),
      expect.objectContaining({
        chatJid: 'team@g.us',
        prompt: expect.stringContaining(
          'ACP prompt finished for session peer-session-1',
        ),
      }),
      runtimeConfig,
      expect.any(Function),
      expect.any(Function),
    );
  });
});
