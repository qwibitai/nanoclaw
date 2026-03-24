import { describe, it, expect } from 'vitest';
import type { WebAccessConfig } from './types.js';

/**
 * Tests for WebFetch/WebSearch attenuation logic.
 *
 * The actual functions live in container/agent-runner/src/index.ts.
 * We duplicate the pure logic here so the root vitest config can run them.
 * If the implementation diverges, these tests should be updated to match.
 */

function buildAllowedTools(webAccess?: WebAccessConfig): string[] {
  return [
    'Bash',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    ...(webAccess?.webSearch !== false ? ['WebSearch'] : []),
    ...(webAccess?.webFetch !== false ? ['WebFetch'] : []),
    'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
    'TodoWrite', 'ToolSearch', 'Skill',
    'NotebookEdit',
    'mcp__nanoclaw__*',
  ];
}

function createWebFetchAllowlistHook(allowlist: string[]) {
  return async (input: { tool_input?: { url?: string } }) => {
    const url = input.tool_input?.url ?? '';
    const allowed = allowlist.some((pattern) => url.startsWith(pattern));
    if (!allowed) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
        },
        reason: `WebFetch blocked: ${url} is not in the allowlist`,
      };
    }
    return {};
  };
}

describe('buildAllowedTools', () => {
  it('includes WebFetch and WebSearch by default (no config)', () => {
    const tools = buildAllowedTools();
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('WebSearch');
  });

  it('includes WebFetch and WebSearch when both are true', () => {
    const tools = buildAllowedTools({ webFetch: true, webSearch: true });
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('WebSearch');
  });

  it('excludes WebFetch when webFetch is false', () => {
    const tools = buildAllowedTools({ webFetch: false });
    expect(tools).not.toContain('WebFetch');
    expect(tools).toContain('WebSearch');
  });

  it('excludes WebSearch when webSearch is false', () => {
    const tools = buildAllowedTools({ webSearch: false });
    expect(tools).toContain('WebFetch');
    expect(tools).not.toContain('WebSearch');
  });

  it('excludes both when both are false', () => {
    const tools = buildAllowedTools({ webFetch: false, webSearch: false });
    expect(tools).not.toContain('WebFetch');
    expect(tools).not.toContain('WebSearch');
  });

  it('includes both when config is empty object', () => {
    const tools = buildAllowedTools({});
    expect(tools).toContain('WebFetch');
    expect(tools).toContain('WebSearch');
  });

  it('always includes core tools regardless of webAccess config', () => {
    const tools = buildAllowedTools({ webFetch: false, webSearch: false });
    expect(tools).toContain('Bash');
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('Task');
  });
});

describe('createWebFetchAllowlistHook', () => {
  it('allows URLs matching the allowlist', async () => {
    const hook = createWebFetchAllowlistHook(['https://api.example.com/']);
    const result = await hook({ tool_input: { url: 'https://api.example.com/data' } });
    expect(result).toEqual({});
  });

  it('blocks URLs not in the allowlist', async () => {
    const hook = createWebFetchAllowlistHook(['https://api.example.com/']);
    const result = await hook({ tool_input: { url: 'https://evil.com/steal' } });
    expect(result.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(result.reason).toContain('not in the allowlist');
  });

  it('blocks when URL is missing', async () => {
    const hook = createWebFetchAllowlistHook(['https://api.example.com/']);
    const result = await hook({ tool_input: {} });
    expect(result.hookSpecificOutput).toBeDefined();
    expect((result as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('matches multiple allowlist entries', async () => {
    const hook = createWebFetchAllowlistHook([
      'https://api.example.com/',
      'https://docs.example.com/',
    ]);

    const r1 = await hook({ tool_input: { url: 'https://api.example.com/v1' } });
    expect(r1).toEqual({});

    const r2 = await hook({ tool_input: { url: 'https://docs.example.com/guide' } });
    expect(r2).toEqual({});

    const r3 = await hook({ tool_input: { url: 'https://other.com/' } });
    expect(r3.hookSpecificOutput).toBeDefined();
  });

  it('uses prefix matching (not exact match)', async () => {
    const hook = createWebFetchAllowlistHook(['https://api.example.com/v1']);
    const result = await hook({ tool_input: { url: 'https://api.example.com/v1/users' } });
    expect(result).toEqual({});
  });

  it('blocks empty allowlist', async () => {
    const hook = createWebFetchAllowlistHook([]);
    const result = await hook({ tool_input: { url: 'https://any.com/' } });
    expect(result.hookSpecificOutput).toBeDefined();
  });
});
