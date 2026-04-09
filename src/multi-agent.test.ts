/**
 * Multi-agent tests — verifies the two-level API:
 * AgentLite creates multiple Agents with isolated state.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentImpl } from './agent-impl.js';
import {
  buildAgentConfig,
  resolveSerializableAgentSettings,
} from './agent-config.js';
import { buildRuntimeConfig } from './runtime-config.js';

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
  return new AgentImpl(config, rtConfig);
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

describe('Multi-agent isolation', () => {
  it('two agents have independent names', () => {
    const alice = createAgent('alice');
    const bob = createAgent('bob');
    expect(alice.name).toBe('alice');
    expect(bob.name).toBe('bob');
  });

  it('two agents retain their provided ids', () => {
    const alice = createAgent('alice');
    const bob = createAgent('bob');

    expect(alice.id).toBe('alice000');
    expect(bob.id).toBe('bob00000');
  });

  it('two agents have independent workdir paths', () => {
    const alice = createAgent('alice');
    const bob = createAgent('bob');

    expect(alice.config.workDir).toContain('alice');
    expect(bob.config.workDir).toContain('bob');
    expect(alice.config.workDir).not.toBe(bob.config.workDir);
    expect(alice.config.storeDir).not.toBe(bob.config.storeDir);
    expect(alice.config.groupsDir).not.toBe(bob.config.groupsDir);
    expect(alice.config.dataDir).not.toBe(bob.config.dataDir);
  });

  it('addChannel rejects before start', async () => {
    const alice = createAgent('alice');
    const mockFactory = () => ({});

    await expect(alice.addChannel('test', mockFactory as any)).rejects.toThrow(
      'Call start() before addChannel()',
    );
  });

  it('agents can be created and deleted independently', () => {
    const agents = new Map<string, AgentImpl>();

    const alice = createAgent('alice');
    const bob = createAgent('bob');
    const charlie = createAgent('charlie');

    agents.set('alice', alice);
    agents.set('bob', bob);
    agents.set('charlie', charlie);

    expect(agents.size).toBe(3);

    // Delete bob
    agents.delete('bob');
    expect(agents.size).toBe(2);
    expect(agents.has('alice')).toBe(true);
    expect(agents.has('bob')).toBe(false);
    expect(agents.has('charlie')).toBe(true);
  });

  it('agent configs are immutable and independent', () => {
    const alice = createAgent('alice');
    const bob = createAgent('bob');

    // Default assistant name for both
    expect(alice.config.assistantName).toBe('Andy');
    expect(bob.config.assistantName).toBe('Andy');

    // But paths are different
    expect(alice.config.workDir).not.toBe(bob.config.workDir);
  });

  it('custom assistant names per agent', () => {
    const aliceConfig = buildAgentConfig({
      agentId: 'alice001',
      ...resolveSerializableAgentSettings(
        'alice',
        { name: 'Alice', workdir: path.join(tmpDir, 'agents', 'alice') },
        tmpDir,
      ),
    });
    const bobConfig = buildAgentConfig({
      agentId: 'bob00001',
      ...resolveSerializableAgentSettings(
        'bob',
        { name: 'Bob', workdir: path.join(tmpDir, 'agents', 'bob') },
        tmpDir,
      ),
    });

    const alice = new AgentImpl(aliceConfig, rtConfig);
    const bob = new AgentImpl(bobConfig, rtConfig);

    expect(alice.config.assistantName).toBe('Alice');
    expect(bob.config.assistantName).toBe('Bob');
    expect(alice.config.triggerPattern.test('@Alice hello')).toBe(true);
    expect(alice.config.triggerPattern.test('@Bob hello')).toBe(false);
    expect(bob.config.triggerPattern.test('@Bob hello')).toBe(true);
  });

  it('shared RuntimeConfig across agents', () => {
    const alice = createAgent('alice');
    const bob = createAgent('bob');

    // Both share the same runtime config reference
    expect(alice.runtimeConfig).toBe(bob.runtimeConfig);
    expect(alice.runtimeConfig.boxImage).toBe(bob.runtimeConfig.boxImage);
  });
});
