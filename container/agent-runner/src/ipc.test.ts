/**
 * Unit tests for the container-side IPC helpers. We point the IPC
 * directory at a fresh sandbox before importing the module so the
 * module-level WORKSPACE constants resolve to the test dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('agent-runner IPC', () => {
  let sandbox: string;
  let ipcDir: string;
  let closeSentinel: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ipc-'));
    process.env.NANOCLAW_IPC_DIR = sandbox;
    ipcDir = path.join(sandbox, 'input');
    closeSentinel = path.join(ipcDir, '_close');
    fs.mkdirSync(ipcDir, { recursive: true });
    // Reset the module cache so the dynamic import picks up the new env.
    vi.resetModules();
  });

  afterEach(() => {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* ignore */
    }
    delete process.env.NANOCLAW_IPC_DIR;
  });

  it('MessageStream yields pushed messages in order and ends on end()', async () => {
    const { MessageStream } = await import('./ipc.js');
    const stream = new MessageStream();
    stream.push('a');
    stream.push('b');
    stream.end();
    const collected: string[] = [];
    for await (const msg of stream) {
      collected.push(
        typeof msg.message.content === 'string' ? msg.message.content : '',
      );
    }
    expect(collected).toEqual(['a', 'b']);
  });

  it('shouldClose consumes the _close sentinel when present', async () => {
    const { shouldClose } = await import('./ipc.js');
    fs.writeFileSync(closeSentinel, '');
    expect(shouldClose()).toBe(true);
    // Sentinel is consumed on first call
    expect(fs.existsSync(closeSentinel)).toBe(false);
    expect(shouldClose()).toBe(false);
  });

  it('drainIpcInput returns messages, sorted, and deletes the source files', async () => {
    const { drainIpcInput } = await import('./ipc.js');
    fs.writeFileSync(
      path.join(ipcDir, '2.json'),
      JSON.stringify({ type: 'message', text: 'second' }),
    );
    fs.writeFileSync(
      path.join(ipcDir, '1.json'),
      JSON.stringify({ type: 'message', text: 'first' }),
    );
    const messages = drainIpcInput();
    expect(messages).toEqual(['first', 'second']);
    expect(fs.readdirSync(ipcDir)).toEqual([]);
  });

  it('drainIpcInput skips malformed files but still removes them', async () => {
    const { drainIpcInput } = await import('./ipc.js');
    fs.writeFileSync(path.join(ipcDir, 'bad.json'), '{ not json');
    fs.writeFileSync(
      path.join(ipcDir, 'ok.json'),
      JSON.stringify({ type: 'message', text: 'hi' }),
    );
    const messages = drainIpcInput();
    expect(messages).toEqual(['hi']);
    expect(fs.readdirSync(ipcDir)).toEqual([]);
  });

  it('drainIpcInput ignores entries without a text field', async () => {
    const { drainIpcInput } = await import('./ipc.js');
    fs.writeFileSync(
      path.join(ipcDir, 'nope.json'),
      JSON.stringify({ type: 'notification' }),
    );
    expect(drainIpcInput()).toEqual([]);
  });

  it('waitForIpcMessage resolves with null when _close arrives', async () => {
    const { waitForIpcMessage } = await import('./ipc.js');
    setTimeout(() => fs.writeFileSync(closeSentinel, ''), 20);
    const result = await waitForIpcMessage();
    expect(result).toBeNull();
  });

  it('waitForIpcMessage resolves with joined text when a message arrives', async () => {
    const { waitForIpcMessage } = await import('./ipc.js');
    setTimeout(() => {
      fs.writeFileSync(
        path.join(ipcDir, 'a.json'),
        JSON.stringify({ type: 'message', text: 'hi' }),
      );
    }, 20);
    const result = await waitForIpcMessage();
    expect(result).toBe('hi');
  });
});
