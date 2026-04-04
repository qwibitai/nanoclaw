import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('workspace constants', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults WORKSPACE_ROOT to /workspace', async () => {
    delete process.env.NANOCLAW_WORKSPACE_ROOT;
    const { WORKSPACE_ROOT, IPC_DIR } = await import('./workspace.js');
    expect(WORKSPACE_ROOT).toBe('/workspace');
    expect(IPC_DIR).toBe(path.join('/workspace', 'ipc'));
  });

  it('respects NANOCLAW_WORKSPACE_ROOT override', async () => {
    process.env.NANOCLAW_WORKSPACE_ROOT = '/tmp/test-workspace';
    const { WORKSPACE_ROOT, IPC_DIR } = await import('./workspace.js');
    expect(WORKSPACE_ROOT).toBe('/tmp/test-workspace');
    expect(IPC_DIR).toBe(path.join('/tmp/test-workspace', 'ipc'));
    delete process.env.NANOCLAW_WORKSPACE_ROOT;
  });
});
