import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { validateToken } from './auth.js';
import type { Frame, RequestFrame } from './protocol.js';

export class ManagementServer {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private port: number;
  private handlers: Record<string, (params: any) => Promise<any>>;
  private authenticatedClients = new Set<WebSocket>();

  constructor(config: {
    port: number;
    handlers: Record<string, (params: any) => Promise<any>>;
  }) {
    this.port = config.port;
    this.handlers = config.handlers;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url === '/health' || req.url === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (req.url === '/readyz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ready: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws) => {
        let authenticated = false;
        const authTimeout = setTimeout(() => {
          if (!authenticated) ws.close(4001, 'auth timeout');
        }, 5000);

        ws.on('message', async (data) => {
          let frame: Frame;
          try {
            frame = JSON.parse(data.toString());
          } catch {
            ws.close(4000, 'invalid frame');
            return;
          }

          if (!authenticated) {
            if (frame.type === 'auth' && 'token' in frame) {
              if (validateToken((frame as { token: string }).token)) {
                authenticated = true;
                this.authenticatedClients.add(ws);
                clearTimeout(authTimeout);
                ws.send(JSON.stringify({ type: 'auth', ok: true }));
              } else {
                ws.close(4001, 'unauthorized');
              }
            } else {
              ws.close(4001, 'auth required');
            }
            return;
          }

          if (frame.type === 'req') {
            const req = frame as RequestFrame;
            const handler = this.handlers[req.method];
            if (!handler) {
              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: req.id,
                  ok: false,
                  error: `unknown method: ${req.method}`,
                }),
              );
              return;
            }
            try {
              const result = await handler(req.params);
              ws.send(
                JSON.stringify({ type: 'res', id: req.id, ok: true, result }),
              );
            } catch (err: unknown) {
              const message =
                err instanceof Error ? err.message : 'internal error';
              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: req.id,
                  ok: false,
                  error: message,
                }),
              );
            }
          }
        });

        ws.on('close', () => {
          clearTimeout(authTimeout);
          this.authenticatedClients.delete(ws);
        });
      });

      this.httpServer.listen(this.port, () => resolve());
    });
  }

  pushEvent(event: string, payload: Record<string, unknown>): void {
    const frame = JSON.stringify({ type: 'event', event, payload });
    for (const ws of this.authenticatedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.authenticatedClients) ws.close(1000);
    this.authenticatedClients.clear();
    return new Promise((resolve) => {
      this.wss?.close(() => {
        this.httpServer?.close(() => resolve());
      });
    });
  }
}
