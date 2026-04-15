import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { ActionsHttp } from './actions-http.js';
import type {
  ActionContext,
  RegisteredAction,
} from '../api/action.js';

// ─── Test helpers ──────────────────────────────────────────────────

type ActionMap = Map<string, RegisteredAction>;

function makeAction(
  opts: Partial<RegisteredAction> & {
    handler: RegisteredAction['handler'];
  },
): RegisteredAction {
  return {
    description: opts.description,
    inputSchema: opts.inputSchema,
    handler: opts.handler,
  };
}

async function post(
  url: string,
  path: '/search' | '/call',
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// ActionsHttp binds to the first non-loopback IPv4 interface. On machines
// with no LAN interface the server starts disabled and every test is a
// no-op. These tests require a host with at least one LAN IP — true for
// virtually every dev machine. If you hit skip behavior in CI, provision
// a Wi-Fi/virtual interface before running.

describe('ActionsHttp', () => {
  let actions: ActionMap;
  let server: ActionsHttp;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    actions = new Map();
    server = new ActionsHttp(() => actions);
    const info = await server.start();
    if (!info) throw new Error('No LAN IP available for tests');
    baseUrl = info.url;
    const minted = server.mintContainerToken('whatsapp_main', true);
    if (!minted) throw new Error('mintContainerToken returned null');
    token = minted.token;
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('auth', () => {
    it('rejects requests without Authorization header', async () => {
      const res = await post(baseUrl, '/search', { query: '' });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe('unauthorized');
    });

    it('rejects requests with a bogus token', async () => {
      const res = await post(baseUrl, '/search', { query: '' }, 'fake-token');
      expect(res.status).toBe(401);
    });

    it('accepts requests with a valid minted token', async () => {
      const res = await post(baseUrl, '/search', { query: '' }, token);
      expect(res.status).toBe(200);
    });

    it('returns 405 for non-POST methods', async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(405);
    });

    it('returns 404 for unknown URLs', async () => {
      const res = await post(baseUrl, '/call', {}, token);
      // /call with no name → not found for "unknown action: "
      expect(res.status).toBe(404);
    });
  });

  describe('/search query grammar', () => {
    beforeEach(() => {
      actions.set(
        'search_crm',
        makeAction({
          description: 'Look up a customer in the CRM',
          inputSchema: { query: z.string() },
          handler: async () => ({}),
        }),
      );
      actions.set(
        'post_invoice',
        makeAction({
          description: 'Create an invoice for a customer',
          inputSchema: { customerId: z.string(), amount: z.number() },
          handler: async () => ({}),
        }),
      );
      actions.set(
        'ping',
        makeAction({
          description: 'Health check',
          handler: async () => 'pong',
        }),
      );
    });

    it('empty query returns no results', async () => {
      const res = await post(baseUrl, '/search', { query: '' }, token);
      expect(res.status).toBe(200);
      expect(res.json.actions).toEqual([]);
    });

    it('select mode fetches by exact name in list order', async () => {
      const res = await post(
        baseUrl,
        '/search',
        { query: 'select:ping,search_crm' },
        token,
      );
      expect(res.status).toBe(200);
      const list = res.json.actions as Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
      expect(list.map((a) => a.name)).toEqual(['ping', 'search_crm']);
      expect(list[0].description).toBe('Health check');
      expect(list[1].description).toBe('Look up a customer in the CRM');
    });

    it('select mode silently drops unknown names', async () => {
      const res = await post(
        baseUrl,
        '/search',
        { query: 'select:ping,nonexistent,post_invoice' },
        token,
      );
      const list = res.json.actions as Array<{ name: string }>;
      expect(list.map((a) => a.name)).toEqual(['ping', 'post_invoice']);
    });

    it('keyword mode ranks by substring hits (name weighted 2x description)', async () => {
      const res = await post(
        baseUrl,
        '/search',
        { query: 'invoice' },
        token,
      );
      const list = res.json.actions as Array<{ name: string }>;
      // "post_invoice" has "invoice" in name (score 2); "search_crm" has 0
      expect(list[0].name).toBe('post_invoice');
    });

    it('required-substring filter with + prefix', async () => {
      actions.set(
        'invoice_void',
        makeAction({
          description: 'Void an invoice',
          handler: async () => ({}),
        }),
      );
      const res = await post(
        baseUrl,
        '/search',
        { query: '+invoice void' },
        token,
      );
      const list = res.json.actions as Array<{ name: string }>;
      // Both invoice_void and post_invoice contain "invoice" in name;
      // invoice_void ranks higher because "void" also appears in its name.
      expect(list.map((a) => a.name)).toContain('invoice_void');
      expect(list[0].name).toBe('invoice_void');
    });

    it('honors max_results cap', async () => {
      const res = await post(
        baseUrl,
        '/search',
        { query: 'select:ping,search_crm,post_invoice', max_results: 2 },
        token,
      );
      const list = res.json.actions as Array<{ name: string }>;
      expect(list.length).toBe(2);
    });

    it('emits JSON Schema from zod inputSchema', async () => {
      const res = await post(
        baseUrl,
        '/search',
        { query: 'select:search_crm' },
        token,
      );
      const action = (res.json.actions as Array<Record<string, unknown>>)[0];
      expect(action.inputSchema).toBeDefined();
      const schema = action.inputSchema as {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.type).toBe('object');
      expect(schema.properties).toHaveProperty('query');
      expect(schema.required).toContain('query');
    });

    it('omits inputSchema when the action has no zod shape', async () => {
      const res = await post(baseUrl, '/search', { query: 'select:ping' }, token);
      const action = (res.json.actions as Array<Record<string, unknown>>)[0];
      expect(action.name).toBe('ping');
      expect(action.inputSchema).toBeUndefined();
    });
  });

  describe('/call dispatch', () => {
    it('returns 404 for unknown action names', async () => {
      const res = await post(
        baseUrl,
        '/call',
        { name: 'does_not_exist' },
        token,
      );
      expect(res.status).toBe(404);
      expect(res.json.error).toContain('unknown action');
    });

    it('invokes the handler with validated args and returns the result', async () => {
      actions.set(
        'greet',
        makeAction({
          inputSchema: { name: z.string() },
          handler: async (args) => ({ greeting: `hello ${args.name}` }),
        }),
      );
      const res = await post(
        baseUrl,
        '/call',
        { name: 'greet', payload: { name: 'Alice' } },
        token,
      );
      expect(res.status).toBe(200);
      expect(res.json.result).toEqual({ greeting: 'hello Alice' });
    });

    it('rejects payloads that fail zod validation with 400', async () => {
      actions.set(
        'greet',
        makeAction({
          inputSchema: { name: z.string() },
          handler: async () => ({}),
        }),
      );
      const res = await post(
        baseUrl,
        '/call',
        { name: 'greet', payload: { name: 123 } },
        token,
      );
      expect(res.status).toBe(400);
      expect(String(res.json.error)).toContain('greet');
    });

    it('skips validation when no inputSchema is registered', async () => {
      actions.set(
        'echo',
        makeAction({
          handler: async (args) => ({ received: args }),
        }),
      );
      const res = await post(
        baseUrl,
        '/call',
        { name: 'echo', payload: { anything: 'goes' } },
        token,
      );
      expect(res.status).toBe(200);
      // No-schema actions get ctx-only callbacks — the wrapper in
      // agent-impl.ts passes only ctx. The test shim here uses a raw
      // RegisteredAction so the handler does receive args directly.
      expect(res.json.result).toEqual({ received: { anything: 'goes' } });
    });

    it('surfaces handler throws as 500 with error message', async () => {
      actions.set(
        'broken',
        makeAction({
          handler: async () => {
            throw new Error('database offline');
          },
        }),
      );
      const res = await post(baseUrl, '/call', { name: 'broken' }, token);
      expect(res.status).toBe(500);
      expect(res.json.error).toBe('database offline');
    });

    it('ctx.sourceGroup comes from the token binding (tamper-proof)', async () => {
      let captured: ActionContext | undefined;
      actions.set(
        'inspect',
        makeAction({
          handler: async (_args, ctx) => {
            captured = ctx;
            return null;
          },
        }),
      );
      // Spoof a different groupFolder in the request body — it should be ignored.
      await post(
        baseUrl,
        '/call',
        {
          name: 'inspect',
          payload: { sourceGroup: 'attacker_group', isMain: false },
          chatJid: '120@g.us',
        },
        token,
      );
      expect(captured?.sourceGroup).toBe('whatsapp_main');
      expect(captured?.isMain).toBe(true);
      expect(captured?.jid).toBe('120@g.us');
    });

    it('handler return value of undefined becomes null in response', async () => {
      actions.set(
        'silent',
        makeAction({
          handler: async () => undefined,
        }),
      );
      const res = await post(baseUrl, '/call', { name: 'silent' }, token);
      expect(res.status).toBe(200);
      expect(res.json.result).toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('mintContainerToken returns null after stop()', async () => {
      await server.stop();
      const minted = server.mintContainerToken('foo', false);
      expect(minted).toBeNull();
    });

    it('getInfo returns null after stop()', async () => {
      await server.stop();
      expect(server.getInfo()).toBeNull();
    });

    it('multiple tokens bind independently', async () => {
      const t2 = server.mintContainerToken('other_group', false);
      expect(t2).not.toBeNull();
      let captured: ActionContext | undefined;
      actions.set(
        'inspect',
        makeAction({
          handler: async (_args, ctx) => {
            captured = ctx;
            return null;
          },
        }),
      );
      await post(baseUrl, '/call', { name: 'inspect' }, t2!.token);
      expect(captured?.sourceGroup).toBe('other_group');
      expect(captured?.isMain).toBe(false);
    });

    it('rejects requests authorized with a stale token after stop', async () => {
      const info = server.getInfo()!;
      await server.stop();
      // Server is gone — fetch should fail to connect
      await expect(
        fetch(`${info.url}/search`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: '' }),
        }),
      ).rejects.toThrow();
    });
  });
});
