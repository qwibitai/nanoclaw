/**
 * Shared test infrastructure for WebSocket IPC tests.
 * Provides mock WebSocket classes and helpers for authenticated message sending.
 */
import { EventEmitter } from 'events';
import { vi } from 'vitest';

import type { WsIpcServer } from '../ws-server.js';

/** Fake WebSocket that mimics ws.WebSocket for testing */
export function createFakeWs() {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
  ws.readyState = 1; // OPEN
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.ping = vi.fn();
  ws.terminate = vi.fn();
  return ws;
}

export type FakeWs = ReturnType<typeof createFakeWs>;

/**
 * Send an authenticated message through a WsIpcServer.
 * Creates a token, connects a fake WS, authenticates, sends the data,
 * and waits for async processing to complete.
 */
export async function sendAuthenticatedMessage(
  server: WsIpcServer,
  wss: EventEmitter,
  data: { type: string; [key: string]: unknown },
  sourceGroup: string,
  chatJid: string,
  isMain: boolean,
  role: 'agent' | 'mcp' = 'agent',
): Promise<FakeWs> {
  const token = server.createToken(sourceGroup, chatJid, isMain);
  const ws = createFakeWs();
  wss.emit('connection', ws, {});

  // Authenticate
  ws.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'auth', token, role })),
  );

  // Send the actual message
  ws.emit('message', Buffer.from(JSON.stringify(data)));

  // Wait for async processing
  await new Promise<void>((r) => queueMicrotask(r));
  await new Promise((r) => setTimeout(r, 10));

  return ws;
}
