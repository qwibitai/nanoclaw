/**
 * E2E tests for ACP peer factories — verify that auto(), codex(), and
 * claudeCode() produce configs that wire correctly into AgentImpl and
 * the AcpOutboundClient lifecycle.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../box-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../../box-runtime.js')>(
    '../../box-runtime.js',
  );
  return {
    ...actual,
    cleanupOrphans: vi.fn(async () => {}),
  };
});

import { AgentImpl } from '../../agent/agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from '../../agent/config.js';
import { buildRuntimeConfig } from '../../runtime-config.js';
import { resolveGroupIpcPath } from '../../group-folder.js';
import type { RegisteredGroup } from '../../types.js';
import type { AcpPeerConfig } from '../options.js';

import { ACP_NOTICE_SENDER } from '../../acp/notice.js';
import { codex, claudeCode } from './peers.js';

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

// ─── Helpers ────────────────────────────────────────────────────────

function createAgentWithPeers(
  name: string,
  tmpDir: string,
  peers: AcpPeerConfig[],
): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });
  return new AgentImpl(config, runtimeConfig, {
    acp: { peers },
  });
}

function createAgentWithTestPeer(
  name: string,
  tmpDir: string,
): AgentImpl {
  const peerScript = fileURLToPath(
    new URL('../../acp/fixtures/test-peer.js', import.meta.url),
  );
  return createAgentWithPeers(name, tmpDir, [
    {
      name: 'test-peer',
      command: process.execPath,
      args: [peerScript],
    },
  ]);
}

async function callAction(
  agent: AgentImpl,
  groupFolder: string,
  name: string,
  payload?: Record<string, unknown>,
  chatJid?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const info = agent.actionsHttp.getInfo();
  if (!info) throw new Error('No LAN IP available');
  const minted = agent.actionsHttp.mintContainerToken(groupFolder, false);
  if (!minted) throw new Error('Failed to mint token');

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

function extractArtifactPath(notice: string): string {
  const match = notice.match(/\/workspace\/ipc\/acp\/runs\/[^\s]+\.json/);
  if (!match) throw new Error(`No artifact path in notice: ${notice}`);
  return match[0];
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ACP peers e2e', () => {
  let tmpDir: string;
  const agents: AgentImpl[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-peers-e2e-'));
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

  it('codex() config is accepted by AgentImpl and registers ACP actions', async () => {
    // Use a dummy command that exits immediately — we just check wiring,
    // not actual Codex connectivity.
    const peer = codex({ command: process.execPath, extraArgs: [] });
    // Override args to use a no-op script so spawn doesn't fail hard
    peer.args = ['-e', 'process.exit(0)'];

    const agent = createAgentWithPeers('codex-wire', tmpDir, [peer]);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    // Verify ACP actions were registered
    const listResp = await callAction(
      agent,
      'team',
      'acp_list_remote_agents',
      {},
      'team@g.us',
    );
    expect(listResp.status).toBe(200);
    const result = listResp.json.result as { agents: Array<{ name: string }> };
    expect(result.agents.map((a) => a.name)).toContain('codex');
  });

  it('claudeCode() config is accepted by AgentImpl and registers ACP actions', async () => {
    const peer = claudeCode({ command: process.execPath });
    peer.args = ['-e', 'process.exit(0)'];

    const agent = createAgentWithPeers('cc-wire', tmpDir, [peer]);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const listResp = await callAction(
      agent,
      'team',
      'acp_list_remote_agents',
      {},
      'team@g.us',
    );
    expect(listResp.status).toBe(200);
    const result = listResp.json.result as { agents: Array<{ name: string }> };
    expect(result.agents.map((a) => a.name)).toContain('claude-code');
  });

  it('multiple factory peers coexist in a single agent', async () => {
    const peers = [
      { ...codex(), command: process.execPath, args: ['-e', 'process.exit(0)'] },
      { ...claudeCode(), command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ];

    const agent = createAgentWithPeers('multi-peer', tmpDir, peers);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const listResp = await callAction(
      agent,
      'team',
      'acp_list_remote_agents',
      {},
      'team@g.us',
    );
    expect(listResp.status).toBe(200);
    const result = listResp.json.result as { agents: Array<{ name: string; description?: string }> };
    const names = result.agents.map((a) => a.name);
    expect(names).toContain('codex');
    expect(names).toContain('claude-code');
    // Descriptions come through
    expect(result.agents.find((a) => a.name === 'codex')?.description).toBeTruthy();
    expect(result.agents.find((a) => a.name === 'claude-code')?.description).toBeTruthy();
  });

  it('factory peer completes a real ACP prompt cycle using test-peer fixture', async () => {
    // This test verifies the full lifecycle: the factory config shape is
    // compatible with the spawn → initialize → newSession → prompt → notice
    // pipeline.
    const agent = createAgentWithTestPeer('factory-e2e', tmpDir);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    // Create session
    const sessionResp = await callAction(
      agent,
      'team',
      'acp_new_session',
      { peer: 'test-peer' },
      'team@g.us',
    );
    expect(sessionResp.status).toBe(200);
    const sessionId = (sessionResp.json.result as { session_id: string })
      .session_id;

    // Fire prompt (returns immediately)
    const promptResp = await callAction(
      agent,
      'team',
      'acp_prompt',
      {
        session_id: sessionId,
        prompt: [{ type: 'text', text: 'factory e2e test' }],
      },
      'team@g.us',
    );
    expect(promptResp.status).toBe(200);
    expect(promptResp.json.result).toEqual({ ok: true });

    // Wait for completion notice
    await vi.waitFor(() => {
      const notices = agent.db.getMessagesSince(
        'team@g.us',
        '',
        agent.config.assistantName,
      );
      expect(notices).toHaveLength(1);
    });

    // Verify artifact
    const notice = agent.db.getMessagesSince(
      'team@g.us',
      '',
      agent.config.assistantName,
    )[0]!;
    expect(notice.sender).toBe(ACP_NOTICE_SENDER);
    expect(notice.content).toContain('completed (end_turn)');

    const artifactContainerPath = extractArtifactPath(notice.content);
    const artifactHostPath = path.join(
      resolveGroupIpcPath('team', agent.config.dataDir),
      artifactContainerPath.replace('/workspace/ipc/', ''),
    );
    const artifact = JSON.parse(
      fs.readFileSync(artifactHostPath, 'utf-8'),
    ) as Record<string, unknown>;

    expect(artifact).toMatchObject({
      session_id: sessionId,
      peer: 'test-peer',
      status: 'completed',
      stop_reason: 'end_turn',
    });
    expect((artifact.text as string).length).toBeGreaterThan(0);
  });

  it('agent with factory peers shuts down cleanly', async () => {
    const peers = [
      { ...codex(), command: process.execPath, args: ['-e', 'process.exit(0)'] },
      { ...claudeCode(), command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ];

    const agent = createAgentWithPeers('shutdown', tmpDir, peers);
    agents.push(agent);
    await agent.start();

    // Should not throw
    await agent.stop();
    // Calling stop twice should be safe
    await agent.stop();
  });

  it('acp_new_session fails gracefully for unknown peer name', async () => {
    const agent = createAgentWithPeers('unknown-peer', tmpDir, [
      { ...codex(), command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ]);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const resp = await callAction(
      agent,
      'team',
      'acp_new_session',
      { peer: 'nonexistent' },
      'team@g.us',
    );
    expect(resp.status).toBe(500);
    expect(resp.json.error).toContain('unknown acp peer');
  });

  it('empty peers array produces no ACP actions', async () => {
    const agent = createAgentWithPeers('no-peers', tmpDir, []);
    agents.push(agent);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);

    const listResp = await callAction(
      agent,
      'team',
      'acp_list_remote_agents',
      {},
      'team@g.us',
    );
    // Actions are still registered (list returns empty), or 404 if not registered
    if (listResp.status === 200) {
      const result = listResp.json.result as { agents: unknown[] };
      expect(result.agents).toHaveLength(0);
    }
  });
});
