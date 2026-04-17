import { describe, expect, it, vi } from 'vitest';

import { callEgoWakeUp, type McpClientHandle } from './system-prompt.js';
import { createMockDeps } from './system-prompt-test-harness.js';

const workspaceGroup = '/workspace/group';

describe('callEgoWakeUp', () => {
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipped'));
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
      createMcpClient: vi
        .fn()
        .mockRejectedValue(new Error('Connection refused')),
      log,
    });

    const result = await callEgoWakeUp(deps, workspaceGroup);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'));
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('wake_up'));
  });
});
