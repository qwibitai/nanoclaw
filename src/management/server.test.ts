import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ManagementServer } from './server.js';
import { createHandlers } from './handlers.js';
import type { AgentRunner } from './agent-runner.js';

function createMockRunner(): AgentRunner {
  const emitter = new EventEmitter();
  const mock = Object.assign(emitter, {
    spawn: async () => ({ sessionKey: 'mock', startedAt: new Date() }),
    sendMessage: async () => {},
    kill: async () => {},
    killAll: async () => {},
    getSession: () => undefined,
    on: emitter.on.bind(emitter),
  });
  Object.defineProperty(mock, 'activeCount', {
    get: () => 0,
    enumerable: true,
  });
  return mock as unknown as AgentRunner;
}

describe('ManagementServer', () => {
  let server: ManagementServer;
  const PORT = 18799; // test port — avoids conflict with default 18789

  beforeAll(async () => {
    process.env.MANAGEMENT_TOKEN = 'test-token';
    const runner = createMockRunner();
    const handlers = createHandlers(runner);
    server = new ManagementServer({ port: PORT, handlers });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('should reject connection without auth', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'req',
            id: '1',
            method: 'health',
            params: {},
          }),
        );
      });
      ws.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
    });
  });

  it('should accept connection with valid auth', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const response = await new Promise<any>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
      });
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(response.type).toBe('auth');
    expect(response.ok).toBe(true);
    ws.close();
  });

  it('should reject connection with invalid auth', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'wrong-token' }));
      });
      ws.on('close', (code) => {
        expect(code).toBe(4001);
        resolve();
      });
    });
  });

  it('should respond to health request after auth', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    // First: authenticate
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
      });
      ws.once('message', () => resolve()); // consume auth response
    });

    // Second: send health request and wait for response
    ws.send(
      JSON.stringify({ type: 'req', id: 'h1', method: 'health', params: {} }),
    );
    const response = await new Promise<any>((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(response.id).toBe('h1');
    expect(response.ok).toBe(true);
    expect(response.result.status).toBe('ok');
    expect(typeof response.result.uptime).toBe('number');
    ws.close();
  });

  it('should return error for unknown method', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
      });
      ws.once('message', () => resolve());
    });

    ws.send(
      JSON.stringify({
        type: 'req',
        id: 'u1',
        method: 'nonexistent',
        params: {},
      }),
    );
    const response = await new Promise<any>((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    expect(response.id).toBe('u1');
    expect(response.ok).toBe(false);
    expect(response.error).toContain('unknown method');
    ws.close();
  });

  it('should respond to HTTP health endpoint', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('should respond to HTTP readyz endpoint', async () => {
    const res = await fetch(`http://localhost:${PORT}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(true);
  });

  it('should return 404 for unknown HTTP paths', async () => {
    const res = await fetch(`http://localhost:${PORT}/unknown`);
    expect(res.status).toBe(404);
  });

  it('should push events to authenticated clients', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);

    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: 'test-token' }));
      });
      ws.once('message', () => resolve());
    });

    const eventPromise = new Promise<any>((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    server.pushEvent('chat.delta', {
      sessionKey: 'test',
      content: 'hello',
    });

    const event = await eventPromise;
    expect(event.type).toBe('event');
    expect(event.event).toBe('chat.delta');
    expect(event.payload.content).toBe('hello');
    ws.close();
  });

  it('should close connection on invalid JSON', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send('not valid json{{{');
      });
      ws.on('close', (code) => {
        expect(code).toBe(4000);
        resolve();
      });
    });
  });
});
