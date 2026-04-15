import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../box-runtime.js', async () => {
  const actual =
    await vi.importActual<typeof import('../box-runtime.js')>(
      '../box-runtime.js',
    );
  return {
    ...actual,
    cleanupOrphans: vi.fn(async () => {}),
  };
});

import { AgentImpl } from '../agent/agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from '../agent/config.js';
import { buildRuntimeConfig } from '../runtime-config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import type { RegisteredGroup } from '../types.js';

import { AcpOutboundClient } from './client.js';
import { ACP_NOTICE_SENDER } from './notice.js';

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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAgent(name: string, tmpDir: string): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });
  return new AgentImpl(config, runtimeConfig, {
    acp: {
      peers: [
        {
          name: 'fake-peer',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      ],
    },
  });
}

async function callAction(
  agent: AgentImpl,
  groupFolder: string,
  name: string,
  payload?: Record<string, unknown>,
  chatJid?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const info = agent.actionsHttp.getInfo();
  if (!info) {
    throw new Error('No LAN IP available for ACP action tests');
  }
  const minted = agent.actionsHttp.mintContainerToken(groupFolder, false);
  if (!minted) {
    throw new Error('Failed to mint ACP action token');
  }
  const res = await fetch(`${info.url}/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${minted.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      payload: payload ?? {},
      ...(chatJid ? { chatJid } : {}),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function installFakePeer(agent: AgentImpl): {
  promptDeferred: Deferred<{ stopReason: string }>;
  fakeConnection: {
    newSession: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
} {
  if (!agent.acpClient) {
    throw new Error('ACP client was not initialized');
  }

  const promptDeferred = deferred<{ stopReason: string }>();
  let sessionCounter = 0;
  const acpClient = agent.acpClient as unknown as {
    ensurePeerReady: (peer: {
      connection: unknown;
      agentInfo: unknown;
      child: unknown;
    }) => Promise<void>;
    sessions: Map<
      string,
      { accumulator: { text: string[]; toolCalls: unknown[] } | null }
    >;
  };

  const fakeConnection = {
    newSession: vi.fn(async () => ({
      sessionId: `peer-session-${++sessionCounter}`,
    })),
    prompt: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const session = acpClient.sessions.get(sessionId);
      session?.accumulator?.text.push('hello from peer');
      session?.accumulator?.toolCalls.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      });
      return promptDeferred.promise;
    }),
    cancel: vi.fn(async () => {
      promptDeferred.resolve({ stopReason: 'cancelled' });
    }),
  };

  acpClient.ensurePeerReady = vi.fn(async (peer) => {
    peer.connection = fakeConnection;
    peer.agentInfo = { name: 'fake-peer', version: '1.0.0' };
    peer.child = {
      killed: false,
      kill: vi.fn(),
    };
  });

  return { promptDeferred, fakeConnection };
}

function extractArtifactPath(notice: string): string {
  const match = notice.match(/\/workspace\/ipc\/acp\/runs\/[^\s]+\.json/);
  if (!match) {
    throw new Error(`ACP notice did not contain an artifact path: ${notice}`);
  }
  return match[0];
}

function readArtifactFromNotice(
  agent: AgentImpl,
  groupFolder: string,
  notice: string,
): Record<string, unknown> {
  const containerPath = extractArtifactPath(notice);
  const relativePath = containerPath.replace('/workspace/ipc/', '');
  const hostPath = path.join(
    resolveGroupIpcPath(groupFolder, agent.config.dataDir),
    relativePath,
  );
  return JSON.parse(fs.readFileSync(hostPath, 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('AcpOutboundClient integration', () => {
  let tmpDir: string;
  const agents: AgentImpl[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-acp-'));
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      await agent.stop();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('fires acp_prompt in the background and injects a completion notice with an artifact path', async () => {
    const agent = createAgent('acp-success', tmpDir);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const { promptDeferred, fakeConnection } = installFakePeer(agent);
    const queueSpy = vi.spyOn(agent.queue, 'enqueueMessageCheck');

    const newSession = await callAction(
      agent,
      'team',
      'acp_new_session',
      { peer: 'fake-peer' },
      'team@g.us',
    );
    expect(newSession.status).toBe(200);
    const sessionId = (newSession.json.result as { session_id: string })
      .session_id;

    const prompt = await callAction(
      agent,
      'team',
      'acp_prompt',
      {
        session_id: sessionId,
        prompt: [{ type: 'text', text: 'write a haiku' }],
      },
      'team@g.us',
    );
    expect(prompt.status).toBe(200);
    expect(prompt.json.result).toEqual({ ok: true });
    expect(fakeConnection.prompt).toHaveBeenCalledTimes(1);

    promptDeferred.resolve({ stopReason: 'end_turn' });

    await vi.waitFor(() => {
      expect(queueSpy).toHaveBeenCalledWith('team@g.us');
      const notices = agent.db.getMessagesSince(
        'team@g.us',
        '',
        agent.config.assistantName,
      );
      expect(notices).toHaveLength(1);
    });

    const notices = agent.db.getMessagesSince(
      'team@g.us',
      '',
      agent.config.assistantName,
    );
    expect(notices[0]?.sender).toBe(ACP_NOTICE_SENDER);
    expect(notices[0]?.content).toContain(`session ${sessionId}`);

    const artifact = readArtifactFromNotice(agent, 'team', notices[0]!.content);
    expect(artifact).toMatchObject({
      session_id: sessionId,
      peer: 'fake-peer',
      status: 'completed',
      stop_reason: 'end_turn',
      text: 'hello from peer',
      tool_call_count: 1,
    });
    expect(artifact.tool_calls).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
      }),
    ]);
    expect(artifact.text_bytes).toBeGreaterThan(0);
  });

  it('rejects a second acp_prompt while the same session already has an in-flight prompt', async () => {
    const agent = createAgent('acp-overlap', tmpDir);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const { promptDeferred } = installFakePeer(agent);

    const newSession = await callAction(
      agent,
      'team',
      'acp_new_session',
      { peer: 'fake-peer' },
      'team@g.us',
    );
    const sessionId = (newSession.json.result as { session_id: string })
      .session_id;

    const firstPrompt = await callAction(
      agent,
      'team',
      'acp_prompt',
      {
        session_id: sessionId,
        prompt: [{ type: 'text', text: 'first' }],
      },
      'team@g.us',
    );
    expect(firstPrompt.status).toBe(200);

    const secondPrompt = await callAction(
      agent,
      'team',
      'acp_prompt',
      {
        session_id: sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      },
      'team@g.us',
    );
    expect(secondPrompt.status).toBe(500);
    expect(secondPrompt.json.error).toContain(
      'already has an in-flight prompt',
    );

    promptDeferred.resolve({ stopReason: 'cancelled' });
    await vi.waitFor(() => {
      expect(
        agent.db.getMessagesSince('team@g.us', '', agent.config.assistantName),
      ).toHaveLength(1);
    });
  });

  it('writes a cancelled artifact and injects a cancelled notice after acp_cancel', async () => {
    const agent = createAgent('acp-cancel', tmpDir);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const { fakeConnection } = installFakePeer(agent);

    const newSession = await callAction(
      agent,
      'team',
      'acp_new_session',
      { peer: 'fake-peer' },
      'team@g.us',
    );
    const sessionId = (newSession.json.result as { session_id: string })
      .session_id;

    const prompt = await callAction(
      agent,
      'team',
      'acp_prompt',
      {
        session_id: sessionId,
        prompt: [{ type: 'text', text: 'cancel me' }],
      },
      'team@g.us',
    );
    expect(prompt.status).toBe(200);

    const cancel = await callAction(
      agent,
      'team',
      'acp_cancel',
      { session_id: sessionId },
      'team@g.us',
    );
    expect(cancel.status).toBe(200);
    expect(cancel.json.result).toEqual({ ok: true });
    expect(fakeConnection.cancel).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      const notices = agent.db.getMessagesSince(
        'team@g.us',
        '',
        agent.config.assistantName,
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.content).toContain('cancelled');
    });

    const notice = agent.db.getMessagesSince(
      'team@g.us',
      '',
      agent.config.assistantName,
    )[0]!;
    const artifact = readArtifactFromNotice(agent, 'team', notice.content);
    expect(artifact).toMatchObject({
      session_id: sessionId,
      status: 'cancelled',
      stop_reason: 'cancelled',
    });
  });

  it('falls back to a unique folder mapping when chatJid is absent', async () => {
    const agent = createAgent('acp-routing', tmpDir);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const { fakeConnection } = installFakePeer(agent);

    const newSession = await callAction(agent, 'team', 'acp_new_session', {
      peer: 'fake-peer',
    });
    expect(newSession.status).toBe(200);
    expect(fakeConnection.newSession).toHaveBeenCalledTimes(1);
  });

  it('rejects acp_new_session when completion notice routing is ambiguous', async () => {
    const agent = createAgent('acp-ambiguous', tmpDir);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team-1@g.us', TEAM_GROUP);
    await agent.registerGroup('team-2@g.us', {
      ...TEAM_GROUP,
      name: 'Team 2',
    });

    installFakePeer(agent);

    const newSession = await callAction(agent, 'team', 'acp_new_session', {
      peer: 'fake-peer',
    });
    expect(newSession.status).toBe(500);
    expect(newSession.json.error).toContain(
      'cannot resolve ACP completion notice target',
    );
  });

  it('marks abandoned artifacts failed on startup and sweeps old artifacts', () => {
    const dataDir = path.join(tmpDir, 'data');
    const groupsDir = path.join(tmpDir, 'groups');
    const runsDir = path.join(
      resolveGroupIpcPath('team', dataDir),
      'acp',
      'runs',
    );
    fs.mkdirSync(runsDir, { recursive: true });

    const abandonedPath = path.join(runsDir, 'abandoned.json');
    fs.writeFileSync(
      abandonedPath,
      JSON.stringify(
        {
          session_id: 'session-abandoned',
          peer: 'fake-peer',
          status: 'running',
          started_at: '2026-04-14T00:00:00.000Z',
          text: '',
          tool_calls: [],
          text_bytes: 0,
          tool_call_count: 0,
        },
        null,
        2,
      ),
      'utf-8',
    );

    const expiredPath = path.join(runsDir, 'expired.json');
    fs.writeFileSync(
      expiredPath,
      JSON.stringify(
        {
          session_id: 'session-expired',
          peer: 'fake-peer',
          status: 'completed',
          stop_reason: 'end_turn',
          started_at: '2026-04-01T00:00:00.000Z',
          completed_at: '2026-04-01T00:10:00.000Z',
          text: 'old',
          tool_calls: [],
          text_bytes: 3,
          tool_call_count: 0,
        },
        null,
        2,
      ),
      'utf-8',
    );
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(expiredPath, oldTime / 1000, oldTime / 1000);

    new AcpOutboundClient({
      peers: [],
      groupsDir,
      dataDir,
      resolveCallerChatJid: () => 'team@g.us',
      injectNotice: async () => {},
    });

    const recovered = JSON.parse(
      fs.readFileSync(abandonedPath, 'utf-8'),
    ) as Record<string, unknown>;
    expect(recovered).toMatchObject({
      status: 'failed',
      stop_reason: 'abandoned',
      error: 'Host restarted before ACP prompt completed',
    });
    expect(fs.existsSync(expiredPath)).toBe(false);
  });
});
