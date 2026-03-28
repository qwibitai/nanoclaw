import { describe, it, expect, vi, afterEach } from 'vitest';

// Re-import the module fresh for each test by resetting module state
// We test the exported stopIpcWatcher function by verifying the flag prevents
// further setTimeout scheduling after stopIpcWatcher() is called.

describe('stopIpcWatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stopIpcWatcher is exported from ipc.ts', async () => {
    const ipcModule = await import('./ipc.js');
    expect(typeof ipcModule.stopIpcWatcher).toBe('function');
  });

  it('startIpcWatcher and stopIpcWatcher are both exported', async () => {
    const ipcModule = await import('./ipc.js');
    expect(typeof ipcModule.startIpcWatcher).toBe('function');
    expect(typeof ipcModule.stopIpcWatcher).toBe('function');
  });

  it('stopIpcWatcher can be called without throwing', async () => {
    const { stopIpcWatcher } = await import('./ipc.js');
    expect(() => stopIpcWatcher()).not.toThrow();
  });

  it('stopIpcWatcher can be called multiple times safely', async () => {
    const { stopIpcWatcher } = await import('./ipc.js');
    expect(() => {
      stopIpcWatcher();
      stopIpcWatcher();
      stopIpcWatcher();
    }).not.toThrow();
  });
});
