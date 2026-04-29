import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyPingResult, waitForSocket } from './agent-ping.js';

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
  });
});

describe('waitForSocket', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncw-wait-socket-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true immediately when the socket already exists', async () => {
    const sock = path.join(tmpDir, 'cli.sock');
    fs.writeFileSync(sock, '');
    const start = Date.now();
    expect(await waitForSocket(sock, 5_000)).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('returns false when the socket never appears within the timeout', async () => {
    const sock = path.join(tmpDir, 'never.sock');
    expect(await waitForSocket(sock, 400)).toBe(false);
  });

  it('returns true when the socket appears mid-poll', async () => {
    const sock = path.join(tmpDir, 'late.sock');
    setTimeout(() => fs.writeFileSync(sock, ''), 250);
    expect(await waitForSocket(sock, 3_000)).toBe(true);
  });
});
