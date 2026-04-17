import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeIpcFile } from './ipc-writer.js';

describe('writeIpcFile', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-writer-'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes a JSON file into the requested directory', () => {
    const name = writeIpcFile(sandbox, { type: 'message', text: 'hi' });
    const filepath = path.join(sandbox, name);
    expect(fs.existsSync(filepath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    expect(parsed).toEqual({ type: 'message', text: 'hi' });
  });

  it('returns a unique .json filename', () => {
    const a = writeIpcFile(sandbox, { a: 1 });
    const b = writeIpcFile(sandbox, { b: 2 });
    expect(a).not.toBe(b);
    expect(a.endsWith('.json')).toBe(true);
    expect(b.endsWith('.json')).toBe(true);
  });

  it('creates the directory if it does not exist', () => {
    const nested = path.join(sandbox, 'deep', 'nested');
    writeIpcFile(nested, { x: true });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('does not leave a .tmp file behind on success', () => {
    writeIpcFile(sandbox, { ok: 1 });
    const entries = fs.readdirSync(sandbox);
    expect(entries.every((e) => !e.endsWith('.tmp'))).toBe(true);
  });
});
