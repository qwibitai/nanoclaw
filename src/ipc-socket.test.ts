import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NdjsonParser } from './ipc-socket.js';
import { logger } from './logger.js';

// --- NdjsonParser unit tests ---

describe('NdjsonParser', () => {
  it('parses a complete JSON line', () => {
    const parser = new NdjsonParser();
    const results = parser.feed('{"type":"message","text":"hello"}\n');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: 'message', text: 'hello' });
  });

  it('handles partial data across multiple feeds', () => {
    const parser = new NdjsonParser();
    expect(parser.feed('{"type":"mes')).toHaveLength(0);
    expect(parser.feed('sage"}\n')).toHaveLength(1);
  });

  it('handles multiple messages in a single feed', () => {
    const parser = new NdjsonParser();
    const results = parser.feed('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ a: 1 });
    expect(results[1]).toEqual({ b: 2 });
    expect(results[2]).toEqual({ c: 3 });
  });

  it('skips invalid JSON lines and logs a warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parser = new NdjsonParser();
    const results = parser.feed('not json\n{"valid":true}\n');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ valid: true });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatchObject({ line: 'not json' });
    warnSpy.mockRestore();
  });

  it('skips empty lines', () => {
    const parser = new NdjsonParser();
    const results = parser.feed('\n\n{"a":1}\n\n');
    expect(results).toHaveLength(1);
  });

  it('handles data without trailing newline', () => {
    const parser = new NdjsonParser();
    expect(parser.feed('{"partial":true}')).toHaveLength(0);
    // Completes when newline arrives
    const results = parser.feed('\n');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ partial: true });
  });

  it('handles split UTF-8 data', () => {
    const parser = new NdjsonParser();
    // Split in the middle of a JSON key
    expect(parser.feed('{"ke')).toHaveLength(0);
    expect(parser.feed('y":"value"}\n')).toHaveLength(1);
  });

  it('handles rapid sequential messages', () => {
    const parser = new NdjsonParser();
    for (let i = 0; i < 100; i++) {
      const results = parser.feed(`{"i":${i}}\n`);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ i });
    }
  });

  it('handles mixed valid and invalid lines', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const parser = new NdjsonParser();
    const results = parser.feed(
      '{"a":1}\ngarbage\n{"b":2}\n{broken\n{"c":3}\n',
    );
    expect(results).toHaveLength(3);
    expect(results.map((r: any) => Object.keys(r)[0])).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toMatchObject({ line: 'garbage' });
    expect(warnSpy.mock.calls[1][0]).toMatchObject({ line: '{broken' });
    warnSpy.mockRestore();
  });
});

// --- Socket integration tests ---
// These test the NDJSON-over-socket pattern used by IpcSocketServer.
// They use raw net.Server/net.Socket to avoid mocking resolveGroupIpcPath.

describe('Socket integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-sock-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends and receives NDJSON over socket', async () => {
    const socketPath = path.join(tmpDir, 'test.sock');
    const receivedMessages: object[] = [];

    const server = net.createServer((socket) => {
      const parser = new NdjsonParser();
      socket.on('data', (raw) => {
        receivedMessages.push(...parser.feed(raw.toString()));
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });

    client.write(JSON.stringify({ type: 'message', text: 'first' }) + '\n');
    client.write(
      JSON.stringify({ type: 'schedule_task', prompt: 'do thing' }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(receivedMessages).toHaveLength(2);
    expect(receivedMessages[0]).toEqual({ type: 'message', text: 'first' });

    client.destroy();
    server.close();
  });

  it('broadcasts to multiple clients', async () => {
    const socketPath = path.join(tmpDir, 'broadcast.sock');
    const connections = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client1 = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });
    const client2 = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(connections.size).toBe(2);

    const received1: string[] = [];
    const received2: string[] = [];
    client1.on('data', (data) => received1.push(data.toString()));
    client2.on('data', (data) => received2.push(data.toString()));

    const payload = JSON.stringify({ type: 'close' }) + '\n';
    for (const conn of connections) conn.write(payload);

    await new Promise((r) => setTimeout(r, 50));
    expect(received1.join('')).toBe(payload);
    expect(received2.join('')).toBe(payload);

    client1.destroy();
    client2.destroy();
    server.close();
  });

  it('handles client disconnect', async () => {
    const socketPath = path.join(tmpDir, 'disc.sock');
    const connections = new Set<net.Socket>();

    const server = net.createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => resolve(sock));
      sock.on('error', reject);
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(connections.size).toBe(1);

    client.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(connections.size).toBe(0);

    server.close();
  });
});
