/**
 * Paraclaw web UI server.
 *
 * Thin Node http surface over:
 *   - NanoClaw's central v2.db (agent_groups table) — read-only
 *   - The Parachute attach helpers in src/parachute/vault-mcp.ts — write
 *   - The `parachute` CLI for token minting (shells out)
 *
 * Static-serves the built UI bundle from ../ui/dist when present; otherwise
 * just exposes /api/*. In dev, run vite separately on port 5173 with the
 * proxy in vite.config.ts pointing back to this server.
 *
 * Auth model for v1: server runs locally, binds 127.0.0.1, no auth.
 * Anyone with shell access to your laptop can act as you. Phase B replaces
 * with vault OAuth handshake.
 */
// MUST be first — chdirs to project root so NanoClaw's config.ts resolves
// DATA_DIR / GROUPS_DIR correctly regardless of where the server was invoked.
import './bootstrap.js';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { DATA_DIR, GROUPS_DIR } from '../../../src/config.js';
import {
  attachVaultToGroup,
  detachVaultFromGroup,
  readVaultAttachment,
  DEFAULT_VAULT_MCP_NAME,
} from '../../../src/parachute/vault-mcp.js';
import type { VaultScope } from '../../../src/parachute/types.js';

const CENTRAL_DB_PATH = path.join(DATA_DIR, 'v2.db');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(__dirname, '../../ui/dist');
const PORT = Number(process.env.PARACLAW_WEB_PORT ?? 4944);
const HOST = process.env.PARACLAW_WEB_BIND ?? '127.0.0.1';

interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

interface AgentGroupView extends AgentGroupRow {
  vault: ReturnType<typeof readVaultAttachment>;
}

function getDb(): Database.Database {
  if (!fs.existsSync(CENTRAL_DB_PATH)) {
    throw new Error(
      `central db not found at ${CENTRAL_DB_PATH} — has NanoClaw been initialized? Run \`pnpm setup\` or \`pnpm dev\` first.`,
    );
  }
  return new Database(CENTRAL_DB_PATH, { readonly: true });
}

function listAgentGroups(): AgentGroupView[] {
  const db = getDb();
  try {
    const rows = db
      .prepare(
        'SELECT id, name, folder, agent_provider, created_at FROM agent_groups ORDER BY created_at DESC',
      )
      .all() as AgentGroupRow[];
    return rows.map((r) => ({
      ...r,
      vault: readVaultAttachment(r.folder),
    }));
  } finally {
    db.close();
  }
}

function getAgentGroup(folder: string): AgentGroupView | null {
  const db = getDb();
  try {
    const row = db
      .prepare(
        'SELECT id, name, folder, agent_provider, created_at FROM agent_groups WHERE folder = ?',
      )
      .get(folder) as AgentGroupRow | undefined;
    if (!row) return null;
    return { ...row, vault: readVaultAttachment(row.folder) };
  } finally {
    db.close();
  }
}

/**
 * Shell out to `parachute vault tokens create`. Captures stdout, parses the
 * `pvt_…` line. Used by the attach flow so the user never types/pastes a
 * raw token through the UI.
 */
function mintVaultToken(opts: {
  scope: VaultScope;
  label: string;
}): Promise<{ token: string; label: string }> {
  return new Promise((resolve, reject) => {
    const args = ['vault', 'tokens', 'create', '--scope', opts.scope, '--label', opts.label];
    const proc = spawn('parachute', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `parachute vault tokens create exited ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      // Output shape (vault 0.3.x):
      //   Created token for vault "<vault>":
      //     Token:      pvt_...
      //     Permission: ...
      //     Scopes:     ...
      const m = stdout.match(/Token:\s+(pvt_[A-Za-z0-9_-]+)/);
      if (!m) {
        reject(new Error(`could not parse pvt_… from CLI output:\n${stdout}`));
        return;
      }
      resolve({ token: m[1], label: opts.label });
    });
  });
}

// --- HTTP plumbing -----------------------------------------------------------

const json = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const error = (res: http.ServerResponse, status: number, message: string): void =>
  json(res, status, { error: message });

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

const VALID_SCOPES: VaultScope[] = ['vault:read', 'vault:write', 'vault:admin'];

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    json(res, 200, {
      service: 'paraclaw-web-server',
      version: '0.0.1',
      data_dir: DATA_DIR,
      groups_dir: GROUPS_DIR,
    });
    return;
  }

  if (pathname === '/api/groups' && method === 'GET') {
    try {
      const groups = listAgentGroups();
      json(res, 200, { groups });
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // /api/groups/:folder/...
  const groupRoute = pathname.match(/^\/api\/groups\/([^/]+)(\/.*)?$/);
  if (groupRoute) {
    const folder = decodeURIComponent(groupRoute[1]);
    const sub = groupRoute[2] ?? '';

    const group = getAgentGroup(folder);
    if (!group) {
      error(res, 404, `agent group not found: ${folder}`);
      return;
    }

    if (sub === '' && method === 'GET') {
      json(res, 200, { group });
      return;
    }

    // POST /api/groups/:folder/attach-vault
    if (sub === '/attach-vault' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          scope?: string;
          vaultBaseUrl?: string;
          tokenLabel?: string;
          mcpName?: string;
          token?: string; // optional — if absent, server mints via CLI
        }>(req);
        const scope = (body.scope ?? 'vault:read') as VaultScope;
        if (!VALID_SCOPES.includes(scope)) {
          error(res, 400, `invalid scope: ${scope}`);
          return;
        }
        const vaultBaseUrl = body.vaultBaseUrl ?? 'http://127.0.0.1:1940/vault/default';
        const tokenLabel = body.tokenLabel ?? `claw-${folder}`;

        let token = body.token;
        if (!token) {
          const minted = await mintVaultToken({ scope, label: tokenLabel });
          token = minted.token;
        }

        attachVaultToGroup({
          folder,
          vaultBaseUrl,
          vaultToken: token,
          scope,
          tokenLabel,
          mcpName: body.mcpName,
        });

        // Re-read so the response reflects the persisted state.
        const updated = getAgentGroup(folder);
        json(res, 200, { group: updated, mintedToken: !body.token });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // POST /api/groups/:folder/detach-vault
    if (sub === '/detach-vault' && method === 'POST') {
      try {
        const body = await readJsonBody<{ mcpName?: string }>(req);
        detachVaultFromGroup(folder, body.mcpName ?? DEFAULT_VAULT_MCP_NAME);
        const updated = getAgentGroup(folder);
        json(res, 200, { group: updated });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    error(res, 405, `method not allowed: ${method} ${pathname}`);
    return;
  }

  error(res, 404, `not found: ${pathname}`);
}

// --- Static file serving (built UI) -----------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  if (!fs.existsSync(UI_DIST)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      'UI bundle not found at ' +
        UI_DIST +
        '\n\nIn dev: run `pnpm --filter @paraclaw/web-ui dev` and open http://localhost:5173/.\n' +
        'In prod: run `pnpm --filter @paraclaw/web-ui build` first.',
    );
    return;
  }

  // Map / → index.html. Strip leading slash.
  let rel = urlPath.replace(/^\/+/, '') || 'index.html';

  // Path traversal guard.
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  let abs = path.join(UI_DIST, rel);
  // SPA fallback — any unknown route under root falls back to index.html so
  // BrowserRouter routes resolve.
  if (!fs.existsSync(abs)) {
    abs = path.join(UI_DIST, 'index.html');
    rel = 'index.html';
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
  const stream = fs.createReadStream(abs);
  res.writeHead(200, { 'content-type': mime });
  stream.pipe(res);
}

// --- Server ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url.pathname);
      return;
    }
    error(res, 405, `method not allowed: ${req.method} ${url.pathname}`);
  } catch (err) {
    if (!res.headersSent) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`paraclaw-web listening on http://${HOST}:${PORT}`);
  console.log(`  data_dir:   ${DATA_DIR}`);
  console.log(`  groups_dir: ${GROUPS_DIR}`);
  if (fs.existsSync(UI_DIST)) {
    console.log(`  ui:         serving from ${UI_DIST}`);
  } else {
    console.log(`  ui:         (not built — run pnpm --filter @paraclaw/web-ui build, or dev separately on :5173)`);
  }
});
