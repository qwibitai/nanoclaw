/**
 * Peer Channel — NanoClaw-to-NanoClaw structured data exchange.
 *
 * Each instance with peer config runs a lightweight HTTP server.
 * Peers exchange messages directly over HTTPS without a broker.
 *
 * Config (in .env):
 *   PEER_NAME=alice                           — name of this instance
 *   PEER_API_PORT=7843                        — inbound HTTP server port
 *   PEER_API_TOKEN=secret                     — shared Bearer token
 *   PEER_TARGETS=bob=https://bob.host:7843    — comma-separated name=url pairs
 *
 * JID format: peer_{name}@nanoclaw (e.g. peer_bob@nanoclaw)
 * Each configured peer gets a registered group auto-provisioned at connect().
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';

import {
  ASSISTANT_NAME,
  PEER_API_PORT,
  PEER_API_TOKEN,
  PEER_NAME,
  PEER_TARGETS,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

export interface PeerTarget {
  name: string;
  url: string;
}

/** Parse "bob=https://url,carol=https://url2" into target objects. */
export function parsePeerTargets(raw: string): PeerTarget[] {
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf('=');
      if (idx < 1) {
        logger.warn({ entry }, 'Peer target entry has no "=" separator, skipping');
        return null;
      }
      const name = entry.slice(0, idx).trim().toLowerCase();
      const url = entry.slice(idx + 1).trim();
      if (!name || !url) {
        logger.warn({ entry }, 'Peer target entry missing name or url, skipping');
        return null;
      }
      return { name, url };
    })
    .filter((t): t is PeerTarget => t !== null);
}

/** Convert a peer name to its JID. */
function peerJid(name: string): string {
  return `peer_${name}@nanoclaw`;
}

/** Extract peer name from a JID. Returns null if not a peer JID. */
function jidToPeerName(jid: string): string | null {
  const m = jid.match(/^peer_(.+)@nanoclaw$/);
  return m ? m[1] : null;
}

/** Make a JSON HTTP/HTTPS POST to url with body, return {ok, status, body}. */
async function postJson(
  url: string,
  token: string,
  body: object,
  timeoutMs = 10000,
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (!timedOut) resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, body: data });
      });
    });
    req.on('error', (err) => {
      if (!timedOut) resolve({ ok: false, status: 0, body: err.message });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      resolve({ ok: false, status: 0, body: 'timeout' });
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

export class PeerChannel implements Channel {
  name = 'peer';

  private server: http.Server | null = null;
  private connected = false;
  private targets: PeerTarget[] = [];
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    this.targets = parsePeerTargets(PEER_TARGETS);
  }

  async connect(): Promise<void> {
    // Auto-provision a registered group for each configured peer target.
    // This ensures the orchestrator routes inbound peer messages correctly.
    for (const target of this.targets) {
      const jid = peerJid(target.name);
      const existing = this.opts.registeredGroups()[jid];
      if (!existing && this.opts.registerGroup) {
        const group: RegisteredGroup = {
          name: `Peer: ${target.name}`,
          folder: `peer_${target.name}`,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
        };
        this.opts.registerGroup(jid, group);
        logger.info({ jid, folder: group.folder }, '[PEER] Auto-registered peer group');
      }
      // Notify orchestrator of this peer chat so it appears in the DB.
      this.opts.onChatMetadata(jid, new Date().toISOString(), `Peer: ${target.name}`, 'peer', false);
    }

    await this.startServer();
    this.connected = true;
    logger.info(
      { port: PEER_API_PORT, name: PEER_NAME, peers: this.targets.map((t) => t.name) },
      `[PEER] Server listening on port ${PEER_API_PORT}`,
    );
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.error({ port: PEER_API_PORT }, '[PEER] Port already in use — check PEER_API_PORT');
        }
        reject(err);
      });

      this.server.listen(PEER_API_PORT, '0.0.0.0', () => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '';

    // Health check — no auth required
    if (req.method === 'GET' && url === '/peer/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: PEER_NAME }));
      return;
    }

    // Inbound message from another NanoClaw instance
    if (req.method === 'POST' && url === '/peer/message') {
      // Validate Bearer token
      const auth = req.headers['authorization'] || '';
      if (!PEER_API_TOKEN || auth !== `Bearer ${PEER_API_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const msg = JSON.parse(body) as {
            from?: string;
            content?: string;
            id?: string;
            ts?: string;
          };
          if (!msg.from || !msg.content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing from or content' }));
            return;
          }

          const chatJid = peerJid(msg.from);
          const ts = msg.ts || new Date().toISOString();
          const id = msg.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          logger.info({ from: msg.from, chars: msg.content.length }, `[PEER] Inbound message from ${msg.from}`);

          this.opts.onMessage(chatJid, {
            id,
            chat_jid: chatJid,
            sender: chatJid,
            sender_name: msg.from,
            content: msg.content,
            timestamp: ts,
            is_from_me: false,
            is_bot_message: false,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          logger.warn({ err }, '[PEER] Failed to parse inbound message');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const peerName = jidToPeerName(jid);
    if (!peerName) {
      logger.warn({ jid }, '[PEER] sendMessage called with non-peer JID');
      return;
    }

    const target = this.targets.find((t) => t.name === peerName);
    if (!target) {
      logger.warn({ jid, peerName }, '[PEER] No target URL configured for peer');
      return;
    }

    const body = {
      from: PEER_NAME,
      content: text,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
    };

    logger.info({ to: peerName, chars: text.length }, `[PEER] Sending message to ${peerName}`);
    const result = await postJson(`${target.url}/peer/message`, PEER_API_TOKEN, body);
    if (!result.ok) {
      logger.warn({ to: peerName, status: result.status, body: result.body }, '[PEER] Failed to send message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@nanoclaw');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

registerChannel('peer', (opts: ChannelOpts): PeerChannel | null => {
  // Only activate when PEER_NAME and PEER_API_TOKEN are configured.
  if (!PEER_NAME || !PEER_API_TOKEN) return null;
  return new PeerChannel(opts);
});
