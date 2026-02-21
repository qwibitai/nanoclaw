import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { readIpcJsonFile } from './ipc.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readIpcJsonFile security', () => {
  it('parses valid JSON from a regular file', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'message.json');
    fs.writeFileSync(file, JSON.stringify({ type: 'message', chatJid: 'x@g.us', text: 'hi' }));

    expect(readIpcJsonFile(file)).toEqual({
      type: 'message',
      chatJid: 'x@g.us',
      text: 'hi',
    });
  });

  it('rejects symbolic links', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify({ ok: true }));
    const symlink = path.join(dir, 'link.json');

    try {
      fs.symlinkSync(target, symlink);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return;
      throw err;
    }

    expect(() => readIpcJsonFile(symlink)).toThrow(/regular file/i);
  });

  it('rejects oversized IPC files', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'oversized.json');
    const payload = `{"blob":"${'x'.repeat(1024 * 1024)}"}`; // > 1 MiB with JSON framing
    fs.writeFileSync(file, payload);

    expect(() => readIpcJsonFile(file)).toThrow(/exceeds/i);
  });
});
