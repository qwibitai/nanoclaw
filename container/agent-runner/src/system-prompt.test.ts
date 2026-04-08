import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import {
  renderSystemPrompt,
  buildReplacements,
  callEgoWakeUp,
  runSessionTail,
  type SystemPromptDeps,
  type McpClientHandle,
} from './system-prompt.js';

function createMockDeps(overrides: Partial<SystemPromptDeps> = {}): SystemPromptDeps {
  return {
    readFile: vi.fn().mockReturnValue(null),
    execSubprocess: vi.fn().mockResolvedValue(null),
    createMcpClient: vi.fn().mockResolvedValue(null),
    loadMcpConfig: vi.fn().mockReturnValue({}),
    log: vi.fn(),
    ...overrides,
  };
}

// ─── renderSystemPrompt ───────────────────────────────────────

describe('renderSystemPrompt', () => {
  it('replaces a single placeholder', () => {
    const result = renderSystemPrompt('Hello {{NAME}}!', { NAME: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('replaces multiple placeholders', () => {
    const template = '{{SOUL}}\n---\n{{IDENTITY}}\n---\n{{VOICE}}';
    const result = renderSystemPrompt(template, {
      SOUL: 'soul content',
      IDENTITY: 'identity content',
      VOICE: 'voice content',
    });
    expect(result).toBe('soul content\n---\nidentity content\n---\nvoice content');
  });

  it('removes unfilled placeholders', () => {
    const result = renderSystemPrompt('A {{SOUL}} B {{MISSING}} C', { SOUL: 'x' });
    expect(result).toBe('A x B  C');
  });

  it('collapses consecutive blank lines (3+ → 2)', () => {
    const result = renderSystemPrompt('A\n\n\n\nB', {});
    expect(result).toBe('A\n\nB');
  });

  it('collapses empty separator sections (---\\n\\n---)', () => {
    const result = renderSystemPrompt('Above\n\n---\n\n{{MISSING}}\n\n---\n\nBelow', {});
    expect(result).toBe('Above\n\n---\n\nBelow');
  });

  it('handles empty replacements — removes all placeholders', () => {
    const template = '{{SOUL}}\n\n---\n\n{{IDENTITY}}';
    const result = renderSystemPrompt(template, {});
    expect(result).not.toContain('{{');
  });

  it('returns template as-is when no placeholders exist', () => {
    const template = 'Plain text with no placeholders.';
    const result = renderSystemPrompt(template, {});
    expect(result).toBe('Plain text with no placeholders.');
  });

  it('inserts multi-line content correctly', () => {
    const template = 'Before\n{{SOUL}}\nAfter';
    const multiLine = 'Line 1\nLine 2\nLine 3';
    const result = renderSystemPrompt(template, { SOUL: multiLine });
    expect(result).toBe('Before\nLine 1\nLine 2\nLine 3\nAfter');
  });
});

// ─── buildReplacements ───────────────────────────────────────

describe('buildReplacements', () => {
  const workspaceGroup = '/workspace/group';
  const workspaceGlobal = '/workspace/global';

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

    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);
    expect(result.SOUL).toBe('soul');
    expect(result.IDENTITY).toBe('identity');
    expect(result.VOICE).toBe('voice');
    expect(result.USER).toBe('user');
    expect(result.MEMORY).toBe('memory');
  });

  it('gracefully skips missing identity files', async () => {
    const readFile = vi.fn().mockReturnValue(null);
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);
    expect(result.SOUL).toBeUndefined();
    expect(result.IDENTITY).toBeUndefined();
  });

  it('reads today and yesterday memory files with correct date format', async () => {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.endsWith(`${today}.md`)) return 'today notes';
      if (filePath.endsWith(`${yesterday}.md`)) return 'yesterday notes';
      return null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);
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
      // session-tail script existence check
      if (filePath.includes('session-tail')) return 'script exists';
      return null;
    });

    const deps = createMockDeps({ execSubprocess, createMcpClient, loadMcpConfig, readFile });
    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);

    expect(result.SESSION_TAIL).toBe('tail output');
    expect(result.WAKE_UP).toBe('wake up result');
  });

  it('includes GLOBAL_CLAUDE when isMain is false', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath === path.join(workspaceGlobal, 'CLAUDE.md')) return 'global claude';
      return null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(deps, { isMain: false }, workspaceGroup, workspaceGlobal);
    expect(result.GLOBAL_CLAUDE).toBe('global claude');
  });

  it('excludes GLOBAL_CLAUDE when isMain is true', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (filePath === path.join(workspaceGlobal, 'CLAUDE.md')) return 'global claude';
      return null;
    });
    const deps = createMockDeps({ readFile });

    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);
    expect(result.GLOBAL_CLAUDE).toBeUndefined();
  });

  it('returns partial results when session-tail fails', async () => {
    const readFile = vi.fn().mockImplementation((filePath: string) => {
      if (path.basename(filePath) === 'SOUL.md') return 'soul content';
      return null;
    });
    const execSubprocess = vi.fn().mockResolvedValue(null);
    const deps = createMockDeps({ readFile, execSubprocess });

    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);
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
    const createMcpClient = vi.fn().mockRejectedValue(new Error('connection refused'));
    const deps = createMockDeps({ readFile, loadMcpConfig, createMcpClient });

    const result = await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);
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

    await buildReplacements(deps, { isMain: true }, workspaceGroup, workspaceGlobal);

    const summaryCall = log.mock.calls.find(
      (c: string[]) => c[0].includes('replacements:'),
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall![0]).toContain('SOUL');
    expect(summaryCall![0]).toContain('USER');
  });
});

// ─── callEgoWakeUp ───────────────────────────────────────────

describe('callEgoWakeUp', () => {
  const workspaceGroup = '/workspace/group';

  it('returns text from successful MCP wake_up call', async () => {
    const mockClient: McpClientHandle = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'I am awake' }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const deps = createMockDeps({
      loadMcpConfig: vi.fn().mockReturnValue({
        ego: { command: 'python', args: ['-m', 'ego_mcp'] },
      }),
      createMcpClient: vi.fn().mockResolvedValue(mockClient),
    });

    const result = await callEgoWakeUp(deps, workspaceGroup);
    expect(result).toBe('I am awake');
    expect(mockClient.close).toHaveBeenCalled();
  });

  it('returns null and logs when ego server not configured', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      loadMcpConfig: vi.fn().mockReturnValue({}),
      log,
    });

    const result = await callEgoWakeUp(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('skipped'),
    );
  });

  it('returns null and logs when mcp-servers.json does not exist', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      loadMcpConfig: vi.fn().mockReturnValue({}),
      log,
    });

    const result = await callEgoWakeUp(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('returns null and logs when MCP client connection fails', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      loadMcpConfig: vi.fn().mockReturnValue({
        ego: { command: 'python', args: ['-m', 'ego_mcp'] },
      }),
      createMcpClient: vi.fn().mockRejectedValue(new Error('Connection refused')),
      log,
    });

    const result = await callEgoWakeUp(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Connection refused'),
    );
  });

  it('returns null and logs when callTool returns no text content', async () => {
    const log = vi.fn();
    const mockClient: McpClientHandle = {
      callTool: vi.fn().mockResolvedValue({ content: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const deps = createMockDeps({
      loadMcpConfig: vi.fn().mockReturnValue({
        ego: { command: 'python', args: ['-m', 'ego_mcp'] },
      }),
      createMcpClient: vi.fn().mockResolvedValue(mockClient),
      log,
    });

    const result = await callEgoWakeUp(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('wake_up'),
    );
  });
});

// ─── runSessionTail ──────────────────────────────────────────

describe('runSessionTail', () => {
  const workspaceGroup = '/workspace/group';

  it('returns stdout from successful subprocess execution', async () => {
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess: vi.fn().mockResolvedValue('session tail output'),
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBe('session tail output');
  });

  it('returns null and logs when session-tail.py does not exist', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      readFile: vi.fn().mockReturnValue(null),
      log,
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('skipped'),
    );
  });

  it('returns null and logs when subprocess returns error', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess: vi.fn().mockRejectedValue(new Error('exit code 1')),
      log,
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('returns null and logs when stdout is empty', async () => {
    const log = vi.fn();
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess: vi.fn().mockResolvedValue(''),
      log,
    });

    const result = await runSessionTail(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('empty'),
    );
  });

  it('passes correct arguments and environment', async () => {
    const execSubprocess = vi.fn().mockResolvedValue('output');
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess,
    });

    await runSessionTail(deps, workspaceGroup);

    expect(execSubprocess).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['--last', '12', '--no-trim']),
      expect.objectContaining({ NANOCLAW_GROUP_DIR: workspaceGroup }),
      expect.any(Number),
    );
  });

  it('uses SESSION_TAIL_LINES env to change line count', async () => {
    const execSubprocess = vi.fn().mockResolvedValue('output');
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess,
    });

    await runSessionTail(deps, workspaceGroup, 30);

    expect(execSubprocess).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['--last', '30', '--no-trim']),
      expect.objectContaining({ NANOCLAW_GROUP_DIR: workspaceGroup }),
      expect.any(Number),
    );
  });

  it('defaults to 12 lines when no lines argument provided', async () => {
    const execSubprocess = vi.fn().mockResolvedValue('output');
    const deps = createMockDeps({
      readFile: vi.fn().mockImplementation((filePath: string) => {
        if (filePath.includes('session-tail')) return 'script exists';
        return null;
      }),
      execSubprocess,
    });

    await runSessionTail(deps, workspaceGroup);

    expect(execSubprocess).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['--last', '12', '--no-trim']),
      expect.any(Object),
      expect.any(Number),
    );
  });
});
