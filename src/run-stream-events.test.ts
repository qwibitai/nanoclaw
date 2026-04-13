/**
 * Tests for streaming agent events derived from raw SDK messages.
 * The container forwards every SDK message as sdk_message.
 * The host derives curated events (run.tool, run.subagent, etc.) from these.
 */
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
import type {
  RunSdkMessageEvent,
  RunToolEvent,
  RunToolProgressEvent,
  RunSubagentEvent,
  RunStatusEvent,
} from './api/events.js';
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
      return jid === 'mock:stream';
    },
    async setTyping(): Promise<void> {},
  };
}

function setupAgent(): AgentImpl {
  const agent = createAgent('stream-test');
  agent._setDbForTests(db);
  agent._setRegisteredGroups({ 'mock:stream': MAIN_GROUP });
  (agent as unknown as { _started: boolean })._started = true;
  const channel = createMockChannel();
  (
    agent as unknown as { channels: Map<string, Channel> }
  ).channels.set('mock', channel);

  db.storeChatMetadata(
    'mock:stream',
    '2026-04-13T00:00:00.000Z',
    'Stream Test Chat',
  );
  db.storeMessage({
    id: 'msg-1',
    chat_jid: 'mock:stream',
    sender: 'user1',
    sender_name: 'User 1',
    content: 'do something',
    timestamp: '2026-04-13T00:00:01.000Z',
    is_from_me: false,
  });

  return agent;
}

// ── Helpers to build sdk_message ContainerEvents ────────────────

function sdkMsg(sdkType: string, message: unknown, sdkSubtype?: string) {
  return { type: 'sdk_message' as const, sdkType, sdkSubtype, message };
}

describe('run.sdk_message (raw passthrough)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-stream-'));
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

  it('emits run.sdk_message for every SDK message type', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.({ type: 'state', state: 'active' });
        await onOutput?.(sdkMsg('assistant', { uuid: 'a1', message: { content: [] } }));
        await onOutput?.(sdkMsg('tool_progress', { tool_name: 'Bash', tool_use_id: 't1', elapsed_time_seconds: 1 }));
        await onOutput?.(sdkMsg('stream_event', { event: { type: 'content_block_delta' } }));
        await onOutput?.(sdkMsg('rate_limit_event', { rate_limit_info: { status: 'allowed' } }));
        await onOutput?.(sdkMsg('system', { subtype: 'init', session_id: 's1' }, 'init'));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunSdkMessageEvent[] = [];
    agent.on('run.sdk_message', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(5);
    expect(events.map((e) => e.sdkType)).toEqual([
      'assistant',
      'tool_progress',
      'stream_event',
      'rate_limit_event',
      'system',
    ]);
    for (const evt of events) {
      expect(evt.agentId).toBe(agent.id);
      expect(evt.jid).toBe('mock:stream');
      expect(typeof evt.timestamp).toBe('string');
      expect(evt.message).toBeDefined();
    }
  });

  it('preserves sdkSubtype for system messages', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('system', { subtype: 'status', status: 'compacting' }, 'status'));
        await onOutput?.(sdkMsg('system', { subtype: 'compact_boundary' }, 'compact_boundary'));
        await onOutput?.(sdkMsg('system', { subtype: 'files_persisted' }, 'files_persisted'));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunSdkMessageEvent[] = [];
    agent.on('run.sdk_message', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events.map((e) => e.sdkSubtype)).toEqual([
      'status',
      'compact_boundary',
      'files_persisted',
    ]);
  });

  it('passes the full raw message object unchanged', async () => {
    const agent = setupAgent();
    const rawMsg = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', utilization: 0.85 },
      uuid: 'uuid-123',
      session_id: 'sess-456',
    };

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('rate_limit_event', rawMsg));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunSdkMessageEvent[] = [];
    agent.on('run.sdk_message', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events[0].message).toEqual(rawMsg);
  });
});

describe('run.tool (derived from sdk_message)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-stream-'));
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

  it('derives run.tool from assistant message tool_use blocks', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('assistant', {
          uuid: 'a1',
          message: {
            content: [
              { type: 'text', text: 'Let me check...' },
              { type: 'tool_use', name: 'Bash', id: 'tool-abc', input: { command: 'ls -la' } },
              { type: 'tool_use', name: 'Read', id: 'tool-def', input: { file_path: '/tmp/x' } },
            ],
          },
        }));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunToolEvent[] = [];
    agent.on('run.tool', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'tool-abc',
    });
    expect(events[0].input).toContain('ls -la');
    expect(events[1]).toMatchObject({
      toolName: 'Read',
      toolUseId: 'tool-def',
    });
  });

  it('truncates tool input to 500 chars', async () => {
    const agent = setupAgent();
    const longInput = { data: 'x'.repeat(1000) };

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('assistant', {
          uuid: 'a1',
          message: {
            content: [
              { type: 'tool_use', name: 'Write', id: 'tool-long', input: longInput },
            ],
          },
        }));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunToolEvent[] = [];
    agent.on('run.tool', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events[0].input!.length).toBe(500);
  });
});

describe('run.tool_progress (derived from sdk_message)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-stream-'));
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

  it('derives run.tool_progress from tool_progress SDK message', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('tool_progress', {
          tool_name: 'Bash',
          tool_use_id: 'tool-789',
          elapsed_time_seconds: 5.2,
        }));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunToolProgressEvent[] = [];
    agent.on('run.tool_progress', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      toolName: 'Bash',
      toolUseId: 'tool-789',
      elapsedSeconds: 5.2,
    });
  });
});

describe('run.subagent (derived from sdk_message)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-stream-'));
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

  it('derives full subagent lifecycle from task system messages', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('system', {
          subtype: 'task_started',
          task_id: 'task-1',
          description: 'Researching API docs',
        }, 'task_started'));
        await onOutput?.(sdkMsg('system', {
          subtype: 'task_progress',
          task_id: 'task-1',
          description: 'Researching API docs',
          last_tool_name: 'WebFetch',
          summary: 'Found 3 endpoints',
        }, 'task_progress'));
        await onOutput?.(sdkMsg('system', {
          subtype: 'task_notification',
          task_id: 'task-1',
          status: 'completed',
          summary: 'Documented all 3 endpoints',
        }, 'task_notification'));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunSubagentEvent[] = [];
    agent.on('run.subagent', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.subtype)).toEqual(['started', 'progress', 'completed']);
    expect(events[0]).toMatchObject({ taskId: 'task-1', description: 'Researching API docs' });
    expect(events[1]).toMatchObject({ lastToolName: 'WebFetch', summary: 'Found 3 endpoints' });
    expect(events[2]).toMatchObject({ summary: 'Documented all 3 endpoints' });
  });

  it('derives subagent failed from task_notification', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('system', {
          subtype: 'task_notification',
          task_id: 'task-2',
          status: 'failed',
          summary: 'Out of memory',
        }, 'task_notification'));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunSubagentEvent[] = [];
    agent.on('run.subagent', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subtype: 'failed', summary: 'Out of memory' });
  });
});

describe('run.status (derived from sdk_message)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-stream-'));
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

  it('derives run.status from system/status SDK message', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.(sdkMsg('system', {
          subtype: 'status',
          status: 'compacting',
        }, 'status'));
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: null };
      },
    );

    const events: RunStatusEvent[] = [];
    agent.on('run.status', (evt) => events.push(evt));

    await agent.processGroupMessages('mock:stream');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      jid: 'mock:stream',
      status: 'compacting',
    });
  });
});

describe('mixed streaming events', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-stream-'));
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

  it('emits all event types from a realistic sequence', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        await onOutput?.({ type: 'state', state: 'active' });
        // assistant with tool_use
        await onOutput?.(sdkMsg('assistant', {
          uuid: 'a1',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', id: 't-1', input: { file_path: '/README.md' } },
            ],
          },
        }));
        // tool progress
        await onOutput?.(sdkMsg('tool_progress', {
          tool_name: 'Read', tool_use_id: 't-1', elapsed_time_seconds: 0.5,
        }));
        // subagent
        await onOutput?.(sdkMsg('system', {
          subtype: 'task_started', task_id: 'sub-1', description: 'Checking tests',
        }, 'task_started'));
        // stream_event (partial token)
        await onOutput?.(sdkMsg('stream_event', {
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        }));
        // status
        await onOutput?.(sdkMsg('system', {
          subtype: 'status', status: 'compacting',
        }, 'status'));
        // subagent completed
        await onOutput?.(sdkMsg('system', {
          subtype: 'task_notification', task_id: 'sub-1', status: 'completed', summary: 'Tests pass',
        }, 'task_notification'));
        // result — container emits both sdk_message and backward-compat result
        await onOutput?.(sdkMsg('result', { subtype: 'success', result: 'All done!' }));
        await onOutput?.({ type: 'result', result: 'All done!' });
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: 'All done!' };
      },
    );

    const rawEvents: RunSdkMessageEvent[] = [];
    const toolEvents: RunToolEvent[] = [];
    const progressEvents: RunToolProgressEvent[] = [];
    const subagentEvents: RunSubagentEvent[] = [];
    const statusEvents: RunStatusEvent[] = [];

    agent.on('run.sdk_message', (evt) => rawEvents.push(evt));
    agent.on('run.tool', (evt) => toolEvents.push(evt));
    agent.on('run.tool_progress', (evt) => progressEvents.push(evt));
    agent.on('run.subagent', (evt) => subagentEvents.push(evt));
    agent.on('run.status', (evt) => statusEvents.push(evt));

    const result = await agent.processGroupMessages('mock:stream');

    expect(result).toBe(true);

    // Raw events: all 7 sdk_messages (result comes as both sdk_message + backward-compat)
    expect(rawEvents).toHaveLength(7);
    expect(rawEvents.map((e) => e.sdkType)).toEqual([
      'assistant',
      'tool_progress',
      'system',
      'stream_event',
      'system',
      'system',
      'result',
    ]);

    // Curated events derived from raw
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].toolName).toBe('Read');
    expect(progressEvents).toHaveLength(1);
    expect(subagentEvents).toHaveLength(2);
    expect(statusEvents).toHaveLength(1);
  });

  it('sdk_message also fires for result events (dual emission)', async () => {
    const agent = setupAgent();

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _rc, _onProcess, onOutput) => {
        // The container emits both sdk_message and result for SDK result messages
        await onOutput?.(sdkMsg('result', { subtype: 'success', result: 'done' }));
        await onOutput?.({ type: 'result', result: 'done' });
        await onOutput?.({ type: 'state', state: 'stopped', reason: 'exit', exitCode: 0 });
        return { status: 'success', result: 'done' };
      },
    );

    const rawEvents: RunSdkMessageEvent[] = [];
    agent.on('run.sdk_message', (evt) => rawEvents.push(evt));

    await agent.processGroupMessages('mock:stream');

    // sdk_message fires for the result SDK message
    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0].sdkType).toBe('result');
    expect(rawEvents[0].message.result).toBe('done');
  });
});
