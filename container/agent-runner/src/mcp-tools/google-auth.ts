/**
 * Google auth diagnostic MCP tools.
 *
 * NanoClaw v2 does NOT hold raw Google OAuth tokens. The OneCLI gateway
 * (HTTPS_PROXY) intercepts outbound requests to *.googleapis.com and
 * injects `Authorization: Bearer <real-token>` from the OneCLI vault.
 * Agents never see the token value.
 *
 * These tools exist purely to let an agent confirm — at runtime, from
 * inside its container — that the OneCLI proxy is wired and that the
 * operator has connected a Google account with the expected scopes.
 * They are a foundation for downstream Google-API skills (Gmail,
 * Calendar, Sheets, Contacts) so each skill does not re-implement the
 * same connectivity probe.
 *
 * No credential is read here. No env var is read here. No vault API is
 * called. The probe is just an HTTPS GET — if OneCLI is wired and the
 * agent's secret-mode is `all` (or has the relevant secret assigned),
 * the call succeeds; otherwise the gateway returns an error response
 * with a `connect_url` per the onecli-gateway container skill.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

// Exported for tests; production callers go through the MCP handlers.
export const TOKENINFO_URL = 'https://www.googleapis.com/oauth2/v3/tokeninfo';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

// Internal seam so tests can inject a mock without monkey-patching globalThis.fetch.
let _fetch: FetchLike = (input, init) => fetch(input, init);

export function __setFetchForTesting(f: FetchLike | null): void {
  _fetch = f ?? ((input, init) => fetch(input, init));
}

async function probeUserinfo(): Promise<
  { ok: true; email?: string; subject?: string } | { ok: false; status: number; body: string }
> {
  // OneCLI proxy injects the bearer header for requests matching its
  // Google host-pattern. We deliberately send NO Authorization header
  // ourselves — the agent must not handle credentials.
  const res = await _fetch(USERINFO_URL, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 500) };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: true,
    email: typeof data.email === 'string' ? data.email : undefined,
    subject: typeof data.sub === 'string' ? data.sub : undefined,
  };
}

async function probeTokeninfo(): Promise<
  { ok: true; scopes: string[]; expiresIn?: number } | { ok: false; status: number; body: string }
> {
  // tokeninfo wants the access_token as a query param OR header. With
  // OneCLI in front, we pass a placeholder query value; the gateway
  // rewrites it. If the gateway is not wired, Google rejects the
  // placeholder with 400, which is the signal the operator needs to
  // run `/add-google-auth` (or whatever the install skill is named).
  const url = `${TOKENINFO_URL}?access_token=onecli-managed`;
  const res = await _fetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 500) };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const scopeStr = typeof data.scope === 'string' ? data.scope : '';
  const scopes = scopeStr.split(/\s+/).filter(Boolean);
  const expiresIn =
    typeof data.expires_in === 'string'
      ? Number(data.expires_in)
      : typeof data.expires_in === 'number'
        ? data.expires_in
        : undefined;
  return { ok: true, scopes, expiresIn };
}

export const checkGoogleAuth: McpToolDefinition = {
  tool: {
    name: 'check_google_auth',
    description:
      'Verify the agent has working Google OAuth via the OneCLI proxy. Calls googleapis.com/oauth2/v3/userinfo with no Authorization header — the OneCLI gateway injects the bearer. Returns the connected account email on success, or the upstream error (with status) on failure so the agent can surface the OneCLI connect URL to the operator.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    try {
      const r = await probeUserinfo();
      if (r.ok) {
        const who = r.email ?? r.subject ?? '(unknown)';
        return ok(`Google auth OK — connected as ${who}.`);
      }
      return err(
        `Google userinfo returned ${r.status}. ${r.body || '(empty body)'} ` +
          `— if this is 401/403, the OneCLI gateway has no Google credential for this agent. ` +
          `Run '/add-google-auth' or open http://127.0.0.1:10254 → Apps → Google to connect.`,
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

export const listGoogleScopes: McpToolDefinition = {
  tool: {
    name: 'list_google_scopes',
    description:
      'List the OAuth scopes currently granted on the OneCLI-managed Google token for this agent. Useful for checking before attempting a Gmail/Calendar/Sheets/Contacts call that needs a specific scope.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  async handler() {
    try {
      const r = await probeTokeninfo();
      if (r.ok) {
        if (r.scopes.length === 0) return ok('No scopes reported by tokeninfo.');
        const expiry = r.expiresIn !== undefined ? ` (access token expires in ${r.expiresIn}s)` : '';
        return ok(`Granted scopes${expiry}:\n${r.scopes.map((s) => `  - ${s}`).join('\n')}`);
      }
      return err(
        `Google tokeninfo returned ${r.status}. ${r.body || '(empty body)'} ` +
          `— if 400 with 'invalid_token', the OneCLI gateway is not rewriting the access_token param for this agent.`,
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([checkGoogleAuth, listGoogleScopes]);
