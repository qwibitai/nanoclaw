import { describe, it, expect } from 'vitest';

import { buildMcpRuntimeConfig } from './mcp-runtime.js';

describe('buildMcpRuntimeConfig', () => {
  it('returns null when input is null', () => {
    expect(buildMcpRuntimeConfig(null)).toBeNull();
  });

  it('strips source and resolves node .js entry into container path', () => {
    const out = buildMcpRuntimeConfig({
      demo: {
        source: '/host/demo',
        command: 'node',
        args: ['index.js', '--flag'],
      },
    });
    expect(out).toEqual({
      demo: {
        command: 'node',
        args: ['/home/node/.claude/mcp/demo/index.js', '--flag'],
        env: undefined,
      },
    });
  });

  it('injects --experimental-transform-types for node .ts entry', () => {
    const out = buildMcpRuntimeConfig({
      ts: {
        source: '/host/ts',
        command: 'node',
        args: ['server.ts'],
      },
    });
    expect(out!.ts.args).toEqual([
      '--experimental-transform-types',
      '/home/node/.claude/mcp/ts/server.ts',
    ]);
  });

  it('leaves absolute node entry arg unchanged', () => {
    const out = buildMcpRuntimeConfig({
      abs: {
        source: '/host/abs',
        command: 'node',
        args: ['/usr/local/bin/thing.js'],
      },
    });
    expect(out!.abs.args).toEqual(['/usr/local/bin/thing.js']);
  });

  it('passes non-node commands through without resolving args', () => {
    const out = buildMcpRuntimeConfig({
      py: {
        source: '/host/py',
        command: 'python',
        args: ['main.py'],
      },
      npx: {
        source: '/host/npx',
        command: 'npx',
        args: ['some-cli'],
      },
    });
    expect(out!.py.args).toEqual(['main.py']);
    expect(out!.npx.args).toEqual(['some-cli']);
  });

  it('preserves env', () => {
    const out = buildMcpRuntimeConfig({
      e: {
        source: '/host/e',
        command: 'node',
        args: ['x.js'],
        env: { FOO: 'bar' },
      },
    });
    expect(out!.e.env).toEqual({ FOO: 'bar' });
  });

  it('handles multiple servers with mixed .ts and .js node entries', () => {
    const out = buildMcpRuntimeConfig({
      ts: { source: '/host/ts', command: 'node', args: ['index.ts'] },
      js: { source: '/host/js', command: 'node', args: ['index.js'] },
    });

    expect(out!.ts.args).toEqual([
      '--experimental-transform-types',
      '/home/node/.claude/mcp/ts/index.ts',
    ]);
    expect(out!.js.args).toEqual(['/home/node/.claude/mcp/js/index.js']);
  });

  it('keeps node commands with no args unchanged', () => {
    const out = buildMcpRuntimeConfig({
      noargs: { source: '/host/noargs', command: 'node' },
    });

    expect(out).toEqual({
      noargs: { command: 'node', args: undefined, env: undefined },
    });
  });

  it('keeps npx ts runner args relative to the package command', () => {
    const out = buildMcpRuntimeConfig({
      tool: {
        source: '/host/tool',
        command: 'npx',
        args: ['--yes', 'tsx', 'server.ts'],
      },
    });

    expect(out!.tool.args).toEqual(['--yes', 'tsx', 'server.ts']);
  });
});
