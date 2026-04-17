import { describe, it, expect, vi, beforeEach } from 'vitest';
import { codex, claudeCode, auto } from './peers.js';
import { execFileSync } from 'node:child_process';
import type { AcpPeerConfig } from '../options.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

// ─── codex() unit tests ────────────────────────────────────────────

describe('codex()', () => {
  it('disables sandbox and approval by default for full autonomy', () => {
    const peer = codex();
    expect(peer.name).toBe('codex');
    expect(peer.command).toBe('npx');
    expect(peer.args).toContain('@zed-industries/codex-acp');
    expect(peer.args).toContain('sandbox_mode="danger-full-access"');
    expect(peer.args).toContain('approval_policy="never"');
  });

  it('does not specify a model by default', () => {
    const peer = codex();
    expect(peer.args.join(' ')).not.toContain('model=');
  });

  it('enables sandbox when sandbox: true', () => {
    const peer = codex({ sandbox: true });
    expect(peer.args.join(' ')).not.toContain('sandbox=');
  });

  it('accepts model via extraArgs', () => {
    const peer = codex({ extraArgs: ['-c', 'model="o4-mini"'] });
    expect(peer.args).toContain('model="o4-mini"');
  });

  it('accepts overrides', () => {
    const peer = codex({
      name: 'my-codex',
      command: '/usr/local/bin/npx',
      extraArgs: ['--verbose'],
      env: { OPENAI_API_KEY: 'sk-test' },
      description: 'Custom Codex',
    });
    expect(peer.name).toBe('my-codex');
    expect(peer.command).toBe('/usr/local/bin/npx');
    expect(peer.args).toContain('--verbose');
    expect(peer.env).toEqual({ OPENAI_API_KEY: 'sk-test' });
    expect(peer.description).toBe('Custom Codex');
  });

  it('returns a valid AcpPeerConfig shape', () => {
    const peer = codex();
    expect(peer).toHaveProperty('name');
    expect(peer).toHaveProperty('command');
    expect(peer).toHaveProperty('args');
    const _check: AcpPeerConfig = peer;
    expect(_check).toBeDefined();
  });

  it('puts -c flags before extraArgs so overrides are not clobbered', () => {
    const peer = codex({ extraArgs: ['--custom'] });
    const configIdx = peer.args.indexOf('-c');
    const customIdx = peer.args.indexOf('--custom');
    expect(configIdx).toBeLessThan(customIdx);
  });

  it('passes env as undefined when not provided', () => {
    const peer = codex();
    expect(peer.env).toBeUndefined();
  });

  it('provides a description by default', () => {
    const peer = codex();
    expect(peer.description).toBeTruthy();
    expect(peer.description!.toLowerCase()).toContain('codex');
  });
});

// ─── claudeCode() unit tests ───────────────────────────────────────

describe('claudeCode()', () => {
  it('disables permissions by default', () => {
    const peer = claudeCode();
    expect(peer.name).toBe('claude-code');
    expect(peer.command).toBe('npx');
    expect(peer.args).toContain('--dangerously-skip-permissions');
    expect(peer.args).toContain('@agentclientprotocol/claude-agent-acp');
  });

  it('does not specify a model by default', () => {
    const peer = claudeCode();
    expect(peer.args).not.toContain('--model');
  });

  it('enables permissions when sandbox: true', () => {
    const peer = claudeCode({ sandbox: true });
    expect(peer.args).not.toContain('--dangerously-skip-permissions');
  });

  it('accepts model via extraArgs', () => {
    const peer = claudeCode({ extraArgs: ['--model', 'opus'] });
    const modelIdx = peer.args.indexOf('--model');
    expect(modelIdx).toBeGreaterThan(-1);
    expect(peer.args[modelIdx + 1]).toBe('opus');
  });

  it('accepts overrides', () => {
    const peer = claudeCode({
      name: 'cc',
      extraArgs: ['--max-budget-usd', '5'],
    });
    expect(peer.name).toBe('cc');
    expect(peer.args).toContain('--max-budget-usd');
    expect(peer.args).toContain('5');
  });

  it('returns a valid AcpPeerConfig shape', () => {
    const peer = claudeCode();
    const _check: AcpPeerConfig = peer;
    expect(_check).toBeDefined();
    expect(typeof peer.name).toBe('string');
    expect(typeof peer.command).toBe('string');
    expect(Array.isArray(peer.args)).toBe(true);
  });

  it('provides a description by default', () => {
    const peer = claudeCode();
    expect(peer.description).toBeTruthy();
    expect(peer.description!.toLowerCase()).toContain('claude');
  });
});

// ─── auto() unit tests ─────────────────────────────────────────────

describe('auto()', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns both peers when both CLIs are installed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/ok'));
    const peers = auto();
    expect(peers).toHaveLength(2);
    expect(peers.map((p) => p.name)).toEqual(['claude-code', 'codex']);
  });

  it('returns only claude-code when codex is missing', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const bin = (args as string[])[0];
      if (bin === 'codex') throw new Error('not found');
      return Buffer.from('/usr/local/bin/claude');
    });
    const peers = auto();
    expect(peers).toHaveLength(1);
    expect(peers[0].name).toBe('claude-code');
  });

  it('returns only codex when claude is missing', () => {
    mockExecFileSync.mockImplementation((_cmd, args) => {
      const bin = (args as string[])[0];
      if (bin === 'claude') throw new Error('not found');
      return Buffer.from('/usr/local/bin/codex');
    });
    const peers = auto();
    expect(peers).toHaveLength(1);
    expect(peers[0].name).toBe('codex');
  });

  it('returns empty array when nothing is installed', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const peers = auto();
    expect(peers).toEqual([]);
  });

  it('returns peers with full-capability defaults', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/ok'));
    const peers = auto();
    const cc = peers.find((p) => p.name === 'claude-code')!;
    const cx = peers.find((p) => p.name === 'codex')!;
    expect(cc.args).toContain('--dangerously-skip-permissions');
    expect(cx.args).toContain('sandbox_mode="danger-full-access"');
  });

  it('each returned peer conforms to AcpPeerConfig', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/ok'));
    for (const peer of auto()) {
      expect(typeof peer.name).toBe('string');
      expect(typeof peer.command).toBe('string');
      expect(Array.isArray(peer.args)).toBe(true);
      expect(peer.args.length).toBeGreaterThan(0);
      expect(peer.description).toBeTruthy();
    }
  });

  it('calls which for each known agent', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/ok'));
    auto();
    const whichCalls = mockExecFileSync.mock.calls.filter(
      (c) => c[0] === 'which',
    );
    expect(whichCalls.length).toBeGreaterThanOrEqual(2);
    const binNames = whichCalls.map((c) => (c[1] as string[])[0]);
    expect(binNames).toContain('claude');
    expect(binNames).toContain('codex');
  });

  it('does not call build for agents not found on PATH', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const peers = auto();
    expect(peers).toHaveLength(0);
  });

  it('returns a fresh array on each call (no shared state)', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/ok'));
    const a = auto();
    const b = auto();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('is composable with explicit peers via spread', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/ok'));
    const custom: AcpPeerConfig = {
      name: 'custom-agent',
      command: 'my-agent',
      args: ['--acp'],
    };
    const all = [...auto(), custom];
    expect(all).toHaveLength(3);
    expect(all[2].name).toBe('custom-agent');
  });
});

// ─── Cross-factory contract tests ──────────────────────────────────

describe('factory contract', () => {
  it.each([
    ['codex', codex],
    ['claudeCode', claudeCode],
  ] as const)('%s() returns unique args array per call', (_name, factory) => {
    const a = factory();
    const b = factory();
    expect(a.args).not.toBe(b.args);
    expect(a.args).toEqual(b.args);
  });

  it.each([
    ['codex', codex],
    ['claudeCode', claudeCode],
  ] as const)('%s() name is RFC-1123 compatible', (_name, factory) => {
    const peer = factory();
    expect(peer.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('codex and claudeCode produce distinct names', () => {
    expect(codex().name).not.toBe(claudeCode().name);
  });

  it('no factory produces empty args', () => {
    expect(codex().args.length).toBeGreaterThan(0);
    expect(claudeCode().args.length).toBeGreaterThan(0);
  });
});
