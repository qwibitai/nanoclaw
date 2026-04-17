import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { buildReplacements, type McpClientHandle } from './system-prompt.js';
import { createMockDeps } from './system-prompt-test-harness.js';

const workspaceGroup = '/workspace/group';
const workspaceGlobal = '/workspace/global';

describe('buildReplacements', () => {
  it('reads all identity files when present', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      const name = path.basename(filePath);
      const map: Record<string, string> = {
        'SOUL.md': 'soul',
        'IDENTITY.md': 'identity',
        'VOICE.md': 'voice',
        'USER.md': 'user',
        'MEMORY.md': 'memory',
      };
      return map[name] ?? null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.SOUL).toBe('soul');
    expect(result.IDENTITY).toBe('identity');
    expect(result.VOICE).toBe('voice');
    expect(result.USER).toBe('user');
    expect(result.MEMORY).toBe('memory');
  });

  it('gracefully skips missing identity files', async () => {
    const readFile = vi.fn().mockReturnValue(null);
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.SOUL).toBeUndefined();
    expect(result.IDENTITY).toBeUndefined();
  });

  it('reads today and yesterday memory files with correct date format', async () => {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .split('T')[0];

    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.endsWith(`${today}.md`)) return 'today notes';
      if (filePath.endsWith(`${yesterday}.md`)) return 'yesterday notes';
      return null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.TODAY_MEMORY).toBe('today notes');
    expect(result.YESTERDAY_MEMORY).toBe('yesterday notes');
  });

  it('runs session-tail and ego wake_up in parallel', async () => {
    const callOrder: string[] = [];
    const execSubprocess = vi.fn().mockImplementation(async () => {
      callOrder.push('session-tail');
      return 'tail output';
    });
    const mockClient: McpClientHandle = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'wake up result' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const createMcpClient = vi.fn().mockImplementation(async () => {
      callOrder.push('ego-mcp');
      return mockClient;
    });
    const loadMcpConfig = vi.fn().mockReturnValue({
      ego: { command: 'python', args: ['-m', 'ego_mcp'] },
    });
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes('session-tail')) return 'script exists';
      return null;
    });

    const deps = createMockDeps({
      execSubprocess,
      createMcpClient,
      loadMcpConfig,
      readFile,
    });
    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );

    expect(result.SESSION_TAIL).toBe('tail output');
    expect(result.WAKE_UP).toBe('wake up result');
  });

  it('includes GLOBAL_CLAUDE when isMain is false', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath === path.join(workspaceGlobal, 'CLAUDE.md'))
        return 'global claude';
      return null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(
      deps,
      { isMain: false },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.GLOBAL_CLAUDE).toBe('global claude');
  });

  it('excludes GLOBAL_CLAUDE when isMain is true', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath === path.join(workspaceGlobal, 'CLAUDE.md'))
        return 'global claude';
      return null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.GLOBAL_CLAUDE).toBeUndefined();
  });

  it('returns partial results when session-tail fails', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (path.basename(filePath) === 'SOUL.md') return 'soul content';
      return null;
    });
    const execSubprocess = vi.fn().mockResolvedValue(null);
    const deps = createMockDeps({ readFile, execSubprocess });

    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.SOUL).toBe('soul content');
    expect(result.SESSION_TAIL).toBeUndefined();
  });

  it('returns partial results when ego wake_up fails', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (path.basename(filePath) === 'SOUL.md') return 'soul content';
      return null;
    });
    const loadMcpConfig = vi.fn().mockReturnValue({
      ego: { command: 'python', args: ['-m', 'ego_mcp'] },
    });
    const createMcpClient = vi
      .fn()
      .mockRejectedValue(new Error('connection refused'));
    const deps = createMockDeps({ readFile, loadMcpConfig, createMcpClient });

    const result = await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );
    expect(result.SOUL).toBe('soul content');
    expect(result.WAKE_UP).toBeUndefined();
  });

  it('logs a summary of filled and skipped replacements', async () => {
    const log = vi.fn();
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (path.basename(filePath) === 'SOUL.md') return 'soul';
      if (path.basename(filePath) === 'USER.md') return 'user';
      return null;
    });
    const deps = createMockDeps({ readFile, log });

    await buildReplacements(
      deps,
      { isMain: true },
      workspaceGroup,
      workspaceGlobal,
    );

    const summaryCall = log.mock.calls.find((c: string[]) =>
      c[0].includes('replacements:'),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toContain('SOUL');
    expect(summaryCall![0]).toContain('USER');
  });
});
