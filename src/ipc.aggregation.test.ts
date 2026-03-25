import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { startIpcWatcher } from './ipc.js';
import { DATA_DIR } from './config.js';

// This test uses the real IPC watcher function but mocks deps.sendMessage to capture calls.

describe('IPC aggregation', () => {
  const group = 'testgroup';
  const ipcDir = path.join(DATA_DIR, 'ipc', group, 'messages');
  beforeEach(() => {
    // Clean directory
    try {
      fs.rmSync(path.join(DATA_DIR, 'ipc'), { recursive: true, force: true });
    } catch {}
    fs.mkdirSync(ipcDir, { recursive: true });
  });

  it('synthesizes multiple messages into one when SWARM_POLICY=synthesize', async () => {
    const sent: Array<{ jid: string; text: string }> = [];
    const deps = {
      sendMessage: async (jid: string, text: string) => {
        sent.push({ jid, text });
      },
      registeredGroups: () => ({ 'tg:123': { folder: group, name: 'G', trigger: '@Andy' } }),
      registerGroup: () => {},
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    };

    // create two IPC messages targeting same chat
    const a = { type: 'message', chatJid: 'tg:123', text: 'Result A' };
    const b = { type: 'message', chatJid: 'tg:123', text: 'Result B' };
    fs.writeFileSync(path.join(ipcDir, '1.json'), JSON.stringify(a));
    fs.writeFileSync(path.join(ipcDir, '2.json'), JSON.stringify(b));

    // Start watcher (it will process once then schedule next run)
    startIpcWatcher(deps);

    // Wait a moment
    await new Promise((r) => setTimeout(r, 200));

    expect(sent.length).toBe(1);
    expect(sent[0].jid).toBe('tg:123');
    expect(sent[0].text).toContain('Synthesized');
  });
});
