/**
 * ActionsHttp — self-contained HTTP transport for custom actions.
 *
 * Owns the http.Server, the bearer-token map, LAN-IP discovery, token
 * minting, and the /search and /call endpoints. The container-side MCP
 * shim (container/agent-runner/src/ipc-mcp-stdio.ts) issues authenticated
 * POSTs here, and the registered handlers run in-process on the host
 * with closure access to the Agent instance that registered them.
 *
 * Network note: BoxLite guests cannot reach host 127.0.0.1 but they
 * can reach the host's LAN IP when security.networkEnabled is set.
 * This server picks the first non-loopback IPv4 interface and binds
 * there on a kernel-assigned port.
 *
 * Trust model: sourceGroup and isMain come from the token → binding
 * lookup (tamper-proof). jid is container-supplied and should be
 * treated as an assertion.
 */

import crypto from 'crypto';
import http from 'http';
import os from 'os';

import { z } from 'zod';

import type {
  ActionContext,
  ActionLog,
  RegisteredAction,
} from '../api/action.js';
import { logger } from '../logger.js';

interface TokenBinding {
  groupFolder: string;
  isMain: boolean;
}

export interface ActionsHttpInfo {
  url: string;
  host: string;
  port: number;
}

export class ActionsHttp {
  private server: http.Server | null = null;
  private info: ActionsHttpInfo | null = null;
  private tokens = new Map<string, TokenBinding>();

  constructor(private getActions: () => Map<string, RegisteredAction>) {}

  getInfo(): ActionsHttpInfo | null {
    return this.info;
  }

  async start(): Promise<ActionsHttpInfo | null> {
    const ip = discoverLanIp();
    if (!ip) {
      logger.warn(
        'No non-loopback IPv4 interface found; action HTTP server disabled',
      );
      return null;
    }

    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        logger.error({ err }, 'Action HTTP server handler crashed');
        try {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        } catch {
          /* ignore */
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, ip, () => resolve());
    });
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Action HTTP server failed to bind');
    }
    this.info = {
      url: `http://${ip}:${addr.port}`,
      host: ip,
      port: addr.port,
    };
    logger.info(
      { url: this.info.url },
      'Action HTTP server started (LAN bound)',
    );
    return this.info;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.info = null;
    this.tokens.clear();
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
  }

  /**
   * Mint a fresh bearer token for a container spawn, bound to the
   * container's tamper-proof identity. Caller passes the returned
   * url and token to the container as env vars. Returns null if
   * the HTTP server isn't running.
   */
  mintContainerToken(
    groupFolder: string,
    isMain: boolean,
  ): { url: string; token: string } | null {
    if (!this.info) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(token, { groupFolder, isMain });
    return { url: this.info.url, token };
  }

  private authorize(req: http.IncomingMessage): TokenBinding | null {
    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const token = match[1]!.trim();
    return this.tokens.get(token) ?? null;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const binding = this.authorize(req);
    if (!binding) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const body = await readBody(req);
    let payload: Record<string, unknown>;
    try {
      payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    const url = req.url ?? '/';
    if (url === '/search') {
      const query = typeof payload.query === 'string' ? payload.query : '';
      const maxResults =
        typeof payload.max_results === 'number' && payload.max_results > 0
          ? Math.floor(payload.max_results)
          : 5;
      const results = searchActions(this.getActions(), query, maxResults);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ actions: results }));
      return;
    }

    if (url === '/call') {
      const name = typeof payload.name === 'string' ? payload.name : '';
      let actionPayload: Record<string, unknown> =
        payload.payload && typeof payload.payload === 'object'
          ? (payload.payload as Record<string, unknown>)
          : {};
      const entry = this.getActions().get(name);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown action: ${name}` }));
        return;
      }
      // Validate against the zod shape if one was registered
      if (entry.inputSchema) {
        const parsed = z.object(entry.inputSchema).safeParse(actionPayload);
        if (!parsed.success) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `invalid payload for action "${name}": ${parsed.error.message}`,
            }),
          );
          return;
        }
        actionPayload = parsed.data as Record<string, unknown>;
      }
      const chatJid =
        typeof payload.chatJid === 'string' ? payload.chatJid : undefined;
      const log = logger.child({
        customAction: name,
        sourceGroup: binding.groupFolder,
      }) as unknown as ActionLog;
      const ctx: ActionContext = {
        jid: chatJid,
        sourceGroup: binding.groupFolder,
        isMain: binding.isMain,
        log,
      };
      try {
        const result = await entry.handler(actionPayload, ctx);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: result ?? null }));
      } catch (err) {
        logger.warn({ action: name, err }, 'Custom action handler threw');
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      return;
    }

    res.writeHead(404);
    res.end();
  }
}

// ─── Module-private helpers ───────────────────────────────────────

function discoverLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

interface ActionSearchResult {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function emitAction(name: string, entry: RegisteredAction): ActionSearchResult {
  const out: ActionSearchResult = { name };
  if (entry.description !== undefined) out.description = entry.description;
  if (entry.inputSchema !== undefined) {
    try {
      out.inputSchema = z.toJSONSchema(z.object(entry.inputSchema));
    } catch (err) {
      logger.warn(
        { action: name, err },
        'Failed to convert zod shape to JSON Schema',
      );
    }
  }
  return out;
}

function scoreAction(
  name: string,
  entry: RegisteredAction,
  terms: string[],
): number {
  if (terms.length === 0) return 0;
  const hay = (name + ' ' + (entry.description ?? '')).toLowerCase();
  const lowerName = name.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (lowerName.includes(term)) score += 2;
    else if (hay.includes(term)) score += 1;
  }
  return score;
}

/**
 * Matches Claude Code's ToolSearch query grammar.
 *   "select:a,b"  → exact name lookup, results in list order
 *   "+foo bar"    → "foo" required as substring in name; rank by "bar"
 *   "foo bar"     → keyword search, rank by substring hits
 * Results capped to maxResults. Empty query returns [].
 */
export function searchActions(
  actions: Map<string, RegisteredAction>,
  query: string,
  maxResults: number,
): ActionSearchResult[] {
  const trimmed = query.trim();

  if (trimmed.startsWith('select:')) {
    const names = trimmed
      .slice('select:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out: ActionSearchResult[] = [];
    for (const name of names) {
      const entry = actions.get(name);
      if (entry) out.push(emitAction(name, entry));
      if (out.length >= maxResults) break;
    }
    return out;
  }

  if (!trimmed) return [];

  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const required: string[] = [];
  const ranking: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith('+') && tok.length > 1) required.push(tok.slice(1));
    else ranking.push(tok);
  }

  const rankTerms = ranking.length > 0 ? ranking : required;
  const scored: Array<{
    name: string;
    entry: RegisteredAction;
    score: number;
  }> = [];
  for (const [name, entry] of actions) {
    const lowerName = name.toLowerCase();
    if (required.length > 0 && !required.every((r) => lowerName.includes(r))) {
      continue;
    }
    const score = scoreAction(name, entry, rankTerms);
    if (score > 0 || required.length > 0) {
      scored.push({ name, entry, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return scored
    .slice(0, maxResults)
    .map(({ name, entry }) => emitAction(name, entry));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const maxBytes = 1024 * 1024;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('request body exceeds 1MB');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
