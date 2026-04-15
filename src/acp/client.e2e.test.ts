import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../box-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../box-runtime.js')>(
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

function createAgent(name: string, tmpDir: string): AgentImpl {
  const config = buildAgentConfig({
    agentId: `${name}00000000`.slice(0, 8),
    ...resolveSerializableAgentSettings(
      name,
      { workdir: path.join(tmpDir, 'agents', name) },
      tmpDir,
    ),
  });

  const peerScript = fileURLToPath(
    new URL('./fixtures/test-peer.js', import.meta.url),
  );

  return new AgentImpl(config, runtimeConfig, {
    acp: {
      peers: [
        {
          name: 'test-peer',
          command: process.execPath,
          args: [peerScript],
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
    throw new Error('No LAN IP available for ACP e2e test');
  }
  const minted = agent.actionsHttp.mintContainerToken(groupFolder, false);
  if (!minted) {
    throw new Error('Failed to mint action token');
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

function extractArtifactPath(notice: string): string {
  const match = notice.match(/\/workspace\/ipc\/acp\/runs\/[^\s]+\.json/);
  if (!match) {
    throw new Error(`ACP notice did not contain artifact path: ${notice}`);
  }
  return match[0];
}

describe('ACP background prompt e2e', () => {
  let tmpDir: string;
  let agent: AgentImpl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-acp-e2e-'));
    agent = createAgent('acp-e2e', tmpDir);
    await agent.start();
    await agent.registerGroup('team@g.us', TEAM_GROUP);
  });

  afterEach(async () => {
    await agent.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('spawns a real ACP peer, returns immediately, and writes the completion artifact', async () => {
    const sessionResp = await callAction(
      agent,
      'team',
      'acp_new_session',
      { peer: 'test-peer' },
      'team@g.us',
    );
    expect(sessionResp.status).toBe(200);
    const sessionId = (
      sessionResp.json.result as { session_id: string }
    ).session_id;

    const startedAt = Date.now();
    const promptResp = await callAction(
      agent,
      'team',
      'acp_prompt',
      {
        session_id: sessionId,
        prompt: [{ type: 'text', text: 'run for e2e' }],
      },
      'team@g.us',
    );
    const promptDurationMs = Date.now() - startedAt;

    expect(promptResp.status).toBe(200);
    expect(promptResp.json.result).toEqual({ ok: true });
    expect(promptDurationMs).toBeLessThan(250);
    expect(
      agent.db.getMessagesSince('team@g.us', '', agent.config.assistantName),
    ).toHaveLength(0);

    await vi.waitFor(() => {
      expect(
        agent.db.getMessagesSince('team@g.us', '', agent.config.assistantName),
      ).toHaveLength(1);
    });

    const notice = agent.db.getMessagesSince(
      'team@g.us',
      '',
      agent.config.assistantName,
    )[0]!;
    expect(notice.sender).toBe(ACP_NOTICE_SENDER);
    expect(notice.content).toContain(`session ${sessionId}`);
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
      text: 'real peer says hello and finished the run.',
      tool_call_count: 1,
    });
    expect(artifact.tool_calls).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'real-tool-1',
      }),
    ]);
  });
});
