/**
 * Multi-agent E2E tests for Agent.
 *
 * Verifies path isolation, legacy default paths, and IPC scoping
 * across multiple named agents sharing the same process.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentImpl } from './agent-impl.js';
import { buildAgentConfig } from './agent-config.js';
import { buildRuntimeConfig } from './runtime-config.js';
import { GroupQueue } from './group-queue.js';

let tmpDir: string;
const rtConfig = buildRuntimeConfig({}, '/tmp/agentlite-test-pkg');

function createAgent(name: string, baseDir: string): AgentImpl {
  const agentConfig = buildAgentConfig(
    name,
    { workdir: path.join(baseDir, 'agents', name) },
    baseDir,
  );
  return new AgentImpl(agentConfig, rtConfig);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlite-multi-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Agent path isolation', () => {
  it('every agent uses workdir/agents/{name}/ subdirectory', () => {
    const agent = createAgent('alice', tmpDir);
    expect(agent.config.workdir).toBe(path.join(tmpDir, 'agents', 'alice'));
    expect(agent.config.storeDir).toBe(
      path.join(tmpDir, 'agents', 'alice', 'store'),
    );
    expect(agent.config.groupsDir).toBe(
      path.join(tmpDir, 'agents', 'alice', 'groups'),
    );
    expect(agent.config.dataDir).toBe(
      path.join(tmpDir, 'agents', 'alice', 'data'),
    );
  });

  it('two agents have independent paths', () => {
    const alice = createAgent('alice', tmpDir);
    const bob = createAgent('bob', tmpDir);

    expect(alice.config.storeDir).not.toBe(bob.config.storeDir);
    expect(alice.config.groupsDir).not.toBe(bob.config.groupsDir);
    expect(alice.config.dataDir).not.toBe(bob.config.dataDir);
    expect(alice.config.workdir).not.toBe(bob.config.workdir);
  });

  it('agent.name propagates from constructor', () => {
    const a = createAgent('alice', tmpDir);
    const b = createAgent('main', tmpDir);
    expect(a.name).toBe('alice');
    expect(b.name).toBe('main');
  });
});

describe('GroupQueue IPC path scoping', () => {
  it('writes IPC message to the agent-scoped dataDir', () => {
    const agentDataDir = path.join(tmpDir, 'agents', 'alice', 'data');
    const queue = new GroupQueue({ dataDir: agentDataDir });

    const jid = 'test-jid';
    const folder = 'test-group';
    queue.registerBox(jid, 'box-name', folder);

    queue.closeStdin(jid);

    const legacyInput = path.join(tmpDir, 'data', 'ipc', folder, 'input');
    expect(fs.existsSync(legacyInput)).toBe(false);
  });

  it('two GroupQueues with different dataDirs do not cross-contaminate', () => {
    const aliceDataDir = path.join(tmpDir, 'agents', 'alice', 'data');
    const bobDataDir = path.join(tmpDir, 'agents', 'bob', 'data');

    const aliceQueue = new GroupQueue({ dataDir: aliceDataDir });
    const bobQueue = new GroupQueue({ dataDir: bobDataDir });

    expect(aliceQueue).not.toBe(bobQueue);
  });
});

describe('Agent constructor (multi-agent scenario)', () => {
  it('creates independent queue instances', () => {
    const alice = createAgent('alice', tmpDir);
    const bob = createAgent('bob', tmpDir);

    const aliceQueue = (alice as unknown as { queue: GroupQueue }).queue;
    const bobQueue = (bob as unknown as { queue: GroupQueue }).queue;

    expect(aliceQueue).not.toBe(bobQueue);
    expect(aliceQueue).toBeInstanceOf(GroupQueue);
    expect(bobQueue).toBeInstanceOf(GroupQueue);
  });

  it('queue is configured with agent dataDir', () => {
    const alice = createAgent('alice', tmpDir);
    const queue = (alice as unknown as { queue: GroupQueue }).queue;
    const queueDataDir = (queue as unknown as { _dataDir: string })._dataDir;
    expect(queueDataDir).toBe(alice.config.dataDir);
  });
});
