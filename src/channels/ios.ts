import http from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { getPublicHealthStatus } from '../health.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  handleDataApi,
  watchDevTasks,
  watchScheduledTasks,
  watchWorkFiles,
} from './ios-data-api.js';
import { handleDashboardApi } from './dashboard-api.js';
import { handleDashboardPage } from './dashboard-page.js';
import { handleDashboardAssets } from './dashboard-assets.js';
import { handleMealPlanPage } from './meal-plan-page.js';

// Use dynamic import for ws since it's an ESM/CJS package
let WebSocketServer: any;

const DEFAULT_PORT = 3100;

/**
 * Whether a request's remote address is on Tailscale or loopback.
 *
 * The dashboard has no application-layer auth — its threat model is
 * "Tailscale is the access boundary". This function enforces that boundary
 * in code so the assumption holds even if the host's network topology
 * changes (LAN exposure, IPv6 from ISP, port forwarding, guest devices).
 *
 * Allowed sources:
 *   - Loopback: 127.0.0.0/8, ::1, ::ffff:127.0.0.1
 *   - Tailscale IPv4 CGNAT: 100.64.0.0/10  (100.64.x.x – 100.127.x.x)
 *   - Tailscale IPv6 ULA:   fd7a:115c:a1e0::/48
 */
function isAllowedSource(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;

  // Strip IPv4-mapped IPv6 prefix (e.g. "::ffff:100.66.147.90")
  const addr = remoteAddress.replace(/^::ffff:/, '');

  // Loopback
  if (addr === '::1' || addr.startsWith('127.')) return true;

  // Tailscale IPv4 CGNAT: 100.64.0.0/10
  const ipv4Match = addr.match(/^(\d+)\.(\d+)\./);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1], 10);
    const b = parseInt(ipv4Match[2], 10);
    if (a === 100 && b >= 64 && b <= 127) return true;
  }

  // Tailscale IPv6 ULA: fd7a:115c:a1e0::/48
  if (addr.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;

  return false;
}

export interface IosChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ConnectedClient {
  ws: any; // WebSocket instance
  deviceId: string;
  jid: string;
}

export class IosChannel implements Channel {
  name = 'ios';

  private server: http.Server | null = null;
  private wss: any = null; // WebSocketServer
  private clients = new Map<string, ConnectedClient>();
  private port: number;
  private token: string;
  private opts: IosChannelOpts;
  private stopTasksWatcher: (() => void) | null = null;
  private stopDevTasksWatcher: (() => void) | null = null;
  private stopScheduledTasksWatcher: (() => void) | null = null;

  constructor(port: number, token: string, opts: IosChannelOpts) {
    this.port = port;
    this.token = token;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Dynamically import ws
    const wsModule = await import('ws');
    WebSocketServer = wsModule.WebSocketServer;

    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws: any, req: http.IncomingMessage) => {
      this.handleWsConnection(ws, req);
    });

    // Watch initiatives and ideas-and-nits files, push changes to all clients
    this.stopTasksWatcher = watchWorkFiles((content, fileType) => {
      this.broadcastToAll({ type: 'tasks_updated', content, fileType });
    });

    // Watch dev-tasks directory, broadcast structured JSON
    this.stopDevTasksWatcher = watchDevTasks((tasks) => {
      this.broadcastToAll({ type: 'dev_tasks_updated', tasks });
    });

    // Register scheduled tasks broadcast (SQLite-based, no filesystem watcher)
    this.stopScheduledTasksWatcher = watchScheduledTasks((tasks) => {
      this.broadcastToAll({ type: 'scheduled_tasks_updated', tasks });
    });

    return new Promise<void>((resolve) => {
      // Bind to 0.0.0.0 so Tailscale clients can reach us. The actual
      // access boundary is enforced per-request in handleHttp() via
      // isAllowedSource() — only loopback and Tailscale addresses pass.
      this.server!.listen(this.port, '0.0.0.0', () => {
        logger.info(
          { port: this.port },
          'iOS channel listening on 0.0.0.0 (HTTP locked to Tailscale + loopback)',
        );
        console.log(`\n  iOS channel: http://0.0.0.0:${this.port}`);
        console.log(`  WebSocket:   ws://0.0.0.0:${this.port}/ws`);
        console.log(`  HTTP locked to Tailscale (100.64.0.0/10) + loopback\n`);
        resolve();
      });
    });
  }

  private handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Source check: enforce the "Tailscale is the access layer" assumption
    // in code, not just at the network level. Anything outside Tailscale +
    // loopback is rejected before any handler runs. Defense in depth — even
    // if the host's network changes (LAN exposure, IPv6 from ISP, port
    // forwarding), the dashboard stays inaccessible to non-Tailscale clients.
    const remote = req.socket.remoteAddress;
    if (!isAllowedSource(remote)) {
      logger.warn(
        { remote, url: req.url, method: req.method },
        'Rejected non-Tailscale request',
      );
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    // No CORS headers — FamBot is a native app making direct HTTP requests,
    // not a browser. Removing wildcard CORS prevents cross-origin exfiltration
    // from malicious websites on the home network.

    // Public pages (no auth — Tailscale boundary enforced above)
    if (handleDashboardPage(req, res)) {
      return;
    }
    if (handleDashboardAssets(req, res)) {
      return;
    }
    if (handleDashboardApi(req, res)) {
      return;
    }
    if (handleMealPlanPage(req, res)) {
      return;
    }

    if (req.method === 'GET' && req.url === '/api/health') {
      const health = getPublicHealthStatus();
      const code = health.status === 'ok' ? 200 : 503;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/message') {
      this.handlePostMessage(req, res);
      return;
    }

    // Data API: calendar, tasks
    if (handleDataApi(req, res, this.token)) {
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  private handlePostMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Auth check
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (token !== this.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { deviceId, text, senderName } = data;

        if (!deviceId || !text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing deviceId or text' }));
          return;
        }

        const jid = `ios:${deviceId}`;
        const timestamp = new Date().toISOString();
        const msgId = `ios-${Date.now()}`;

        // Store chat metadata
        this.opts.onChatMetadata(
          jid,
          timestamp,
          senderName || 'iOS User',
          'ios',
          false,
        );

        // Check if group is registered
        const group = this.opts.registeredGroups()[jid];
        if (!group) {
          logger.debug({ jid }, 'Message from unregistered iOS device');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'received', registered: false }));
          return;
        }

        // Deliver message to router
        this.opts.onMessage(jid, {
          id: msgId,
          chat_jid: jid,
          sender: deviceId,
          sender_name: senderName || 'iOS User',
          content: `@${ASSISTANT_NAME} ${text}`,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { jid, sender: senderName || 'iOS User' },
          'iOS message stored',
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'received', registered: true }));
      } catch (err) {
        logger.error({ err }, 'Failed to parse iOS message');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleWsConnection(ws: any, req: http.IncomingMessage): void {
    const url = new URL(req.url || '', `http://localhost:${this.port}`);
    const token = url.searchParams.get('token') || '';
    const deviceId = url.searchParams.get('deviceId') || '';

    if (token !== this.token) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (!deviceId) {
      ws.close(4002, 'Missing deviceId');
      return;
    }

    const jid = `ios:${deviceId}`;
    this.clients.set(jid, { ws, deviceId, jid });

    logger.info({ jid, deviceId }, 'iOS client connected via WebSocket');

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'message' && msg.text) {
          const timestamp = new Date().toISOString();
          const msgId = `ios-${Date.now()}`;

          this.opts.onChatMetadata(
            jid,
            timestamp,
            msg.senderName || 'iOS User',
            'ios',
            false,
          );

          const group = this.opts.registeredGroups()[jid];
          if (!group) {
            ws.send(
              JSON.stringify({ type: 'error', error: 'Device not registered' }),
            );
            return;
          }

          this.opts.onMessage(jid, {
            id: msgId,
            chat_jid: jid,
            sender: deviceId,
            sender_name: msg.senderName || 'iOS User',
            content: `@${ASSISTANT_NAME} ${msg.text}`,
            timestamp,
            is_from_me: false,
          });

          logger.info({ jid }, 'iOS WebSocket message stored');

          // Broadcast user message to OTHER connected clients for real-time sync
          const echoPayload = JSON.stringify({
            type: 'message',
            text: msg.text,
            from: 'user',
            senderName: msg.senderName || 'iOS User',
          });
          for (const [clientJid, client] of this.clients.entries()) {
            if (clientJid !== jid && client.ws.readyState === 1) {
              try {
                client.ws.send(echoPayload);
              } catch {
                // ignore
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to parse iOS WebSocket message');
      }
    });

    ws.on('close', () => {
      this.clients.delete(jid);
      logger.info({ jid }, 'iOS client disconnected');
    });

    ws.on('error', (err: Error) => {
      logger.error({ jid, err: err.message }, 'iOS WebSocket error');
      this.clients.delete(jid);
    });

    // Send welcome
    ws.send(JSON.stringify({ type: 'connected', assistant: ASSISTANT_NAME }));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Broadcast bot responses to ALL connected iOS clients so every
    // device sees the reply in real time (not just the one that asked).
    const payload = JSON.stringify({
      type: 'message',
      text,
      from: 'assistant',
    });
    let sent = 0;
    for (const client of this.clients.values()) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(payload);
          sent++;
        } catch (err) {
          logger.error({ jid: client.jid, err }, 'Failed to send iOS message');
        }
      }
    }
    if (sent === 0) {
      logger.warn({ jid }, 'No iOS clients connected, message not delivered');
    } else {
      logger.info({ jid, sent, length: text.length }, 'iOS message broadcast');
    }
  }

  /** Broadcast a JSON payload to every connected iOS client. */
  private broadcastToAll(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(data);
        } catch {
          // ignore individual send failures
        }
      }
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ios:');
  }

  async disconnect(): Promise<void> {
    if (this.stopTasksWatcher) {
      this.stopTasksWatcher();
      this.stopTasksWatcher = null;
    }
    if (this.stopDevTasksWatcher) {
      this.stopDevTasksWatcher();
      this.stopDevTasksWatcher = null;
    }
    if (this.stopScheduledTasksWatcher) {
      this.stopScheduledTasksWatcher();
      this.stopScheduledTasksWatcher = null;
    }

    for (const client of this.clients.values()) {
      client.ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    logger.info('iOS channel stopped');
  }

  getConnectedDeviceIds(): string[] {
    return Array.from(this.clients.values()).map((c) => c.deviceId);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Broadcast typing to ALL connected iOS clients
    const payload = JSON.stringify({ type: 'typing', isTyping });
    for (const client of this.clients.values()) {
      if (client.ws.readyState === 1) {
        try {
          client.ws.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }
}

registerChannel('ios', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['IOS_CHANNEL_TOKEN', 'IOS_CHANNEL_PORT']);
  const token =
    process.env.IOS_CHANNEL_TOKEN || envVars.IOS_CHANNEL_TOKEN || '';
  if (!token) {
    logger.warn('iOS: IOS_CHANNEL_TOKEN not set');
    return null;
  }
  const port = parseInt(
    process.env.IOS_CHANNEL_PORT ||
      envVars.IOS_CHANNEL_PORT ||
      String(DEFAULT_PORT),
    10,
  );
  return new IosChannel(port, token, opts);
});
