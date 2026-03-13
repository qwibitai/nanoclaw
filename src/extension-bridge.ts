/**
 * Extension Bridge Server
 *
 * WebSocket server that bridges NanoClaw container agents to the Chrome extension.
 * The agent (inside a container) sends commands via a Unix-domain or TCP socket,
 * and this bridge forwards them to the Chrome extension over WebSocket.
 *
 * Architecture:
 *   Container Agent  ──(HTTP POST)──▸  Bridge Server  ──(WebSocket)──▸  Chrome Extension
 *   Container Agent  ◂──(HTTP Response)──  Bridge Server  ◂──(WebSocket)──  Chrome Extension
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from './logger.js';

const log = logger.child({ module: 'extension-bridge' });

const BRIDGE_PORT = parseInt(process.env.EXTENSION_BRIDGE_PORT || '3002', 10);

let extensionSocket: WebSocket | null = null;
let commandId = 0;
const pendingCommands = new Map<
  number,
  { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();

/** Start the bridge server */
export function startExtensionBridge(): void {
  const server = http.createServer(handleHttpRequest);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    log.info('Chrome extension connected');
    extensionSocket = ws;

    ws.on('message', (raw) => {
      let msg: { type: string; id?: number; success?: boolean; data?: unknown; error?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'result' && msg.id !== undefined) {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(msg.id);
          pending.resolve({
            success: msg.success,
            data: msg.data,
            error: msg.error,
          });
        }
      } else if (msg.type === 'pong') {
        // keepalive response
      }
    });

    ws.on('close', () => {
      log.info('Chrome extension disconnected');
      if (extensionSocket === ws) extensionSocket = null;
      // Reject all pending commands
      for (const [id, pending] of pendingCommands) {
        clearTimeout(pending.timer);
        pending.resolve({ success: false, error: 'Extension disconnected' });
        pendingCommands.delete(id);
      }
    });

    ws.on('error', (err) => {
      log.error({ err }, 'Extension WebSocket error');
    });

    // Start keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));
  });

  server.listen(BRIDGE_PORT, '0.0.0.0', () => {
    log.info({ port: BRIDGE_PORT }, 'Extension bridge server started');
  });
}

/**
 * Send a command to the Chrome extension and wait for the result.
 * Called by container agents via HTTP POST to the bridge.
 */
function sendCommand(
  action: string,
  params: Record<string, unknown>,
  timeout = 60000
): Promise<unknown> {
  return new Promise((resolve) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      resolve({
        success: false,
        error: 'Chrome extension not connected. Install the NanoClaw extension and click Connect.',
      });
      return;
    }

    const id = ++commandId;
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      resolve({ success: false, error: `Command timeout (${timeout}ms)` });
    }, timeout);

    pendingCommands.set(id, { resolve, timer });

    extensionSocket.send(
      JSON.stringify({ type: 'command', id, action, params })
    );
  });
}

/**
 * HTTP handler for container agent requests.
 * POST /command { action, params } -> { success, data, error }
 * GET /status -> { connected: boolean }
 */
function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  // CORS for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        connected: extensionSocket?.readyState === WebSocket.OPEN,
      })
    );
    return;
  }

  if (req.method === 'POST' && req.url === '/command') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { action, params, timeout } = JSON.parse(body);
        if (!action) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Missing action' }));
          return;
        }
        const result = await sendCommand(action, params || {}, timeout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
