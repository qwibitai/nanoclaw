import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnsureOllamaServerRunning = vi.fn(async () => ({
  ok: true,
  started: false,
}));
const mockResolvePreferredOllamaModel = vi.fn(
  () => 'qwen3.5:35b-a3b-coding-nvfp4',
);
const mockWriteModelSwitchHandoff = vi.fn(
  (_args: {
    chatJid: string;
    group: RegisteredGroup;
    previousRuntime: string;
    nextRuntime: string;
    requestedBy?: string;
  }) => '/tmp/handoff.md',
);

vi.mock('../model-switch.js', () => ({
  ensureOllamaServerRunning: () => mockEnsureOllamaServerRunning(),
  resolvePreferredOllamaModel: () => mockResolvePreferredOllamaModel(),
  writeModelSwitchHandoff: (args: {
    chatJid: string;
    group: RegisteredGroup;
    previousRuntime: string;
    nextRuntime: string;
    requestedBy?: string;
  }) => mockWriteModelSwitchHandoff(args),
}));

import {
  _closeDatabase,
  _initTestDatabase,
  setRouterState,
  getRegisteredGroup,
  setRegisteredGroup,
} from '../db.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { AgentSessionService } from './agent-session-service.js';
import { createChannelCommandService } from './channel-command-service.js';

function createFakeChannel(jid: string): Channel & { sent: string[] } {
  return {
    name: 'fake',
    sent: [],
    async connect() {},
    async sendMessage(_jid: string, text: string) {
      this.sent.push(text);
    },
    isConnected() {
      return true;
    },
    ownsJid(targetJid: string) {
      return targetJid === jid;
    },
    async disconnect() {},
  };
}

function createSessionService() {
  const repository = {
    getLiveSession: vi.fn(),
    setLiveSession: vi.fn(),
    deleteLiveSession: vi.fn(),
    getNamedSession: vi.fn(),
    listNamedSessions: vi.fn().mockReturnValue([]),
    setNamedSession: vi.fn(),
    getActiveLabel: vi.fn(),
    setActiveLabel: vi.fn(),
  };
  return {
    repository,
    service: new AgentSessionService(repository, {}),
  };
}

describe('channel model command', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
    mockResolvePreferredOllamaModel.mockReturnValue(
      'qwen3.5:35b-a3b-coding-nvfp4',
    );
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('shows current admin runtime status', async () => {
    const mainGroup: RegisteredGroup = {
      name: 'Admin',
      folder: 'discord_main',
      trigger: '@admin',
      added_at: '2026-04-02T00:00:00.000Z',
      isMain: true,
      agentType: 'codex',
      containerConfig: {
        model: 'gpt-5.4',
        reasoningEffort: 'high',
      },
    };
    setRegisteredGroup('dc:admin', mainGroup);
    const fakeChannel = createFakeChannel('dc:admin');
    const { service } = createSessionService();
    const groups = { 'dc:admin': mainGroup };
    const commandService = createChannelCommandService({
      channels: [fakeChannel],
      getRegisteredGroups: () => groups,
      queue: { closeStdin: vi.fn() } as never,
      sessionService: service,
    });

    await commandService.handleInboundCommand('dc:admin', {
      id: 'm1',
      chat_jid: 'dc:admin',
      sender: 'u1',
      sender_name: 'user',
      content: '/model',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(fakeChannel.sent[0]).toContain('agent=`codex`');
    expect(fakeChannel.sent[0]).toContain('model=`gpt-5.4`');
  });

  it('switches admin runtime provider and persists overrides', async () => {
    const mainGroup: RegisteredGroup = {
      name: 'Admin',
      folder: 'discord_main',
      trigger: '@admin',
      added_at: '2026-04-02T00:00:00.000Z',
      isMain: true,
      agentType: 'claude-code',
      containerConfig: {
        model: 'sonnet',
      },
    };
    setRegisteredGroup('dc:admin', mainGroup);
    const fakeChannel = createFakeChannel('dc:admin');
    const { repository, service } = createSessionService();
    const closeStdin = vi.fn();
    const groups = { 'dc:admin': mainGroup };
    const commandService = createChannelCommandService({
      channels: [fakeChannel],
      getRegisteredGroups: () => groups,
      queue: { closeStdin } as never,
      sessionService: service,
    });

    await commandService.handleInboundCommand('dc:admin', {
      id: 'm2',
      chat_jid: 'dc:admin',
      sender: 'u1',
      sender_name: 'user',
      content: '/model codex gpt-5.4 high',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(groups['dc:admin'].agentType).toBe('codex');
    expect(groups['dc:admin'].containerConfig?.model).toBe('gpt-5.4');
    expect(groups['dc:admin'].containerConfig?.reasoningEffort).toBe('high');
    expect(getRegisteredGroup('dc:admin', 'claude-code')).toBeUndefined();
    expect(
      getRegisteredGroup('dc:admin', 'codex')?.containerConfig?.model,
    ).toBe('gpt-5.4');
    expect(repository.deleteLiveSession).toHaveBeenCalled();
    expect(closeStdin).toHaveBeenCalledWith('dc:admin');
    expect(fakeChannel.sent[0]).toContain('agent=`codex`');
  });

  it('reports admin status from main channel', async () => {
    const mainGroup: RegisteredGroup = {
      name: 'Admin',
      folder: 'discord_main',
      trigger: '@admin',
      added_at: '2026-04-02T00:00:00.000Z',
      isMain: true,
      agentType: 'codex',
      containerConfig: {
        model: 'gpt-5.4',
        reasoningEffort: 'high',
      },
    };
    setRegisteredGroup('dc:admin', mainGroup);
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify({ 'dc:admin': '2026-04-02T13:00:00.000Z' }),
    );
    const fakeChannel = createFakeChannel('dc:admin');
    const { repository, service } = createSessionService();
    repository.getLiveSession.mockReturnValue('active');
    const groups = { 'dc:admin': mainGroup };
    const commandService = createChannelCommandService({
      channels: [fakeChannel],
      getRegisteredGroups: () => groups,
      queue: {
        closeStdin: vi.fn(),
        getStatuses: () => [
          {
            jid: 'dc:admin',
            status: 'processing',
            elapsedMs: 3200,
            pendingMessages: false,
            pendingTasks: 1,
          },
        ],
      } as never,
      sessionService: service,
    });

    await commandService.handleInboundCommand('dc:admin', {
      id: 'm3',
      chat_jid: 'dc:admin',
      sender: 'u1',
      sender_name: 'user',
      content: '/status',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(fakeChannel.sent[0]).toContain('NanoClaw Admin Status');
    expect(fakeChannel.sent[0]).toContain('Version: `');
    expect(fakeChannel.sent[0]).toContain('Restarted: `');
    expect(fakeChannel.sent[0]).toContain('agent=`codex`');
    expect(fakeChannel.sent[0]).toContain('Session: `active`');
    expect(fakeChannel.sent[0]).toContain('Pending: messages=`no`, tasks=`1`');
  });

  it('switches admin claude runtime to ollama preset', async () => {
    const mainGroup: RegisteredGroup = {
      name: 'Admin',
      folder: 'discord_main',
      trigger: '@admin',
      added_at: '2026-04-02T00:00:00.000Z',
      isMain: true,
      agentType: 'codex',
    };
    setRegisteredGroup('dc:admin', mainGroup);
    const fakeChannel = createFakeChannel('dc:admin');
    const { service } = createSessionService();
    const closeStdin = vi.fn();
    const groups = { 'dc:admin': mainGroup };
    const commandService = createChannelCommandService({
      channels: [fakeChannel],
      getRegisteredGroups: () => groups,
      queue: { closeStdin } as never,
      sessionService: service,
    });

    await commandService.handleInboundCommand('dc:admin', {
      id: 'm4',
      chat_jid: 'dc:admin',
      sender: 'u1',
      sender_name: 'user',
      content: '/model claude ollama',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(groups['dc:admin'].agentType).toBe('claude-code');
    expect(groups['dc:admin'].containerConfig?.providerPreset).toBe('ollama');
    expect(groups['dc:admin'].containerConfig?.model).toBe(
      'qwen3.5:35b-a3b-coding-nvfp4',
    );
    expect(mockEnsureOllamaServerRunning).toHaveBeenCalled();
    expect(mockWriteModelSwitchHandoff).toHaveBeenCalled();
    expect(fakeChannel.sent[0]).toContain('provider=`ollama`');
  });

  it('lets claude rooms change only the claude model preset', async () => {
    const claudeGroup: RegisteredGroup = {
      name: 'Claude Room',
      folder: 'discord_claude',
      trigger: '@claude',
      added_at: '2026-04-02T00:00:00.000Z',
      agentType: 'claude-code',
      containerConfig: {
        providerPreset: 'anthropic',
        model: 'sonnet',
      },
    };
    setRegisteredGroup('dc:claude', claudeGroup);
    const fakeChannel = createFakeChannel('dc:claude');
    const { service } = createSessionService();
    const closeStdin = vi.fn();
    const groups = { 'dc:claude': claudeGroup };
    const commandService = createChannelCommandService({
      channels: [fakeChannel],
      getRegisteredGroups: () => groups,
      queue: { closeStdin } as never,
      sessionService: service,
    });

    await commandService.handleInboundCommand('dc:claude', {
      id: 'm5',
      chat_jid: 'dc:claude',
      sender: 'u1',
      sender_name: 'user',
      content: '/model ollama',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(groups['dc:claude'].agentType).toBe('claude-code');
    expect(groups['dc:claude'].containerConfig?.providerPreset).toBe('ollama');
    expect(groups['dc:claude'].containerConfig?.model).toBe(
      'qwen3.5:35b-a3b-coding-nvfp4',
    );

    await commandService.handleInboundCommand('dc:claude', {
      id: 'm6',
      chat_jid: 'dc:claude',
      sender: 'u1',
      sender_name: 'user',
      content: '/model opus',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(groups['dc:claude'].containerConfig?.providerPreset).toBe(
      'anthropic',
    );
    expect(groups['dc:claude'].containerConfig?.model).toBe('opus');
    expect(closeStdin).toHaveBeenCalledWith('dc:claude');
  });

  it('accepts trigger-prefixed model commands in claude rooms', async () => {
    const claudeGroup: RegisteredGroup = {
      name: 'Claude Room',
      folder: 'discord_claude',
      trigger: '@nanoclaw_admin',
      added_at: '2026-04-02T00:00:00.000Z',
      agentType: 'claude-code',
      containerConfig: {
        providerPreset: 'anthropic',
        model: 'sonnet',
      },
    };
    setRegisteredGroup('dc:claude', claudeGroup);
    const fakeChannel = createFakeChannel('dc:claude');
    const { service } = createSessionService();
    const closeStdin = vi.fn();
    const groups = { 'dc:claude': claudeGroup };
    const commandService = createChannelCommandService({
      channels: [fakeChannel],
      getRegisteredGroups: () => groups,
      queue: { closeStdin } as never,
      sessionService: service,
    });

    const handled = await commandService.handleInboundCommand('dc:claude', {
      id: 'm7',
      chat_jid: 'dc:claude',
      sender: 'u1',
      sender_name: 'user',
      content: '@nanoclaw_admin /model ollama',
      timestamp: new Date().toISOString(),
    } as NewMessage);

    expect(handled).toBe(true);
    expect(groups['dc:claude'].containerConfig?.providerPreset).toBe('ollama');
    expect(groups['dc:claude'].containerConfig?.model).toBe(
      'qwen3.5:35b-a3b-coding-nvfp4',
    );
    expect(closeStdin).toHaveBeenCalledWith('dc:claude');
  });
});
