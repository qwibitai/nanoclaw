// src/health.test.ts
import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { HEALTH_SOCKET_PATH } from './config.js';
import { startHealthServer } from './health.js';

const tmpSock = path.join(os.tmpdir(), `nanoclaw-health-test-${process.pid}.sock`);

afterEach(() => {
  fs.rmSync(tmpSock, { force: true });
});

function readSocket(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      let buf = '';
      client.on('data', (d) => { buf += d.toString(); });
      client.on('end', () => resolve(buf));
      client.on('error', reject);
    });
    client.on('error', reject);
  });
}

describe('HEALTH_SOCKET_PATH config', () => {
  it('is a string (empty when env var unset)', () => {
    expect(typeof HEALTH_SOCKET_PATH).toBe('string');
  });
});

describe('startHealthServer', () => {
  it('responds with JSON containing status ok', async () => {
    const srv = startHealthServer(tmpSock, () => ({
      channelsConnected: ['telegram'],
      dbOk: true,
      registeredGroupsCount: 2,
    }));

    const raw = await readSocket(tmpSock);
    await srv.stop();

    const status = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(status.status).toBe('ok');
    expect(status.channelsConnected).toEqual(['telegram']);
    expect(status.dbOk).toBe(true);
    expect(status.registeredGroupsCount).toBe(2);
    expect(typeof status.version).toBe('string');
    expect(typeof status.uptimeMs).toBe('number');
    expect(status.uptimeMs as number).toBeGreaterThanOrEqual(0);
  });

  it('handles concurrent connections independently', async () => {
    const srv = startHealthServer(tmpSock, () => ({
      channelsConnected: [],
      dbOk: true,
      registeredGroupsCount: 0,
    }));

    const [a, b] = await Promise.all([readSocket(tmpSock), readSocket(tmpSock)]);
    await srv.stop();

    expect((JSON.parse(a.trim()) as Record<string, unknown>).status).toBe('ok');
    expect((JSON.parse(b.trim()) as Record<string, unknown>).status).toBe('ok');
  });

  it('stop() cleans up the socket file', async () => {
    const srv = startHealthServer(tmpSock, () => ({
      channelsConnected: [],
      dbOk: false,
      registeredGroupsCount: 0,
    }));
    await srv.stop();
    expect(fs.existsSync(tmpSock)).toBe(false);
  });

  it('recovers from a stale socket file left by a previous crash', async () => {
    fs.writeFileSync(tmpSock, '');
    const srv = startHealthServer(tmpSock, () => ({
      channelsConnected: [],
      dbOk: true,
      registeredGroupsCount: 0,
    }));
    const raw = await readSocket(tmpSock);
    await srv.stop();
    expect((JSON.parse(raw.trim()) as Record<string, unknown>).status).toBe('ok');
  });
});
