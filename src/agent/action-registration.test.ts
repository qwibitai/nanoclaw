import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { createAgentLite } from '../api/sdk.js';
import type { Agent } from '../api/agent.js';
import type { AgentLite } from '../api/sdk.js';
import type { ActionContext } from '../api/action.js';
import type { ActionsHttp } from './actions-http.js';

// The test reaches into AgentImpl's `actionsHttp` field which isn't on
// the public Agent interface. Cast through this helper instead of `any`.
type AgentWithHttp = Agent & { actionsHttp: ActionsHttp };

// These tests exercise the `agent.action()` overload resolution and
// dispatch path end-to-end through the in-process HTTP server, without
// spawning a container. They're the cheapest form of verification for
// the four signature forms that mirror MCP's `server.tool()`.

describe('agent.action() registration', () => {
  let platform: AgentLite;
  let agent: Agent;
  let token: string | undefined;
  let url: string | undefined;

  beforeEach(async () => {
    platform = await createAgentLite({
      workdir: `/tmp/agentlite-action-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    agent = platform.createAgent('action-test');
    await agent.start();
    // Mint a token for an imaginary "test-group" so we can exercise /call
    // directly via fetch.
    const http = (agent as AgentWithHttp).actionsHttp;
    const info = http.getInfo();
    if (!info) {
      throw new Error('No LAN IP available — can not run action tests');
    }
    url = info.url;
    const minted = http.mintContainerToken('test-group', false);
    token = minted?.token;
  });

  afterEach(async () => {
    await agent.stop();
  });

  async function call(name: string, payload?: Record<string, unknown>) {
    const res = await fetch(`${url}/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, payload }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  async function search(query: string, maxResults?: number) {
    const res = await fetch(`${url}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    });
    const json = (await res.json()) as { actions: Array<Record<string, unknown>> };
    return json.actions;
  }

  describe('overload (name, cb) — zero-args, no description', () => {
    it('invokes the callback with only ctx', async () => {
      let seen: ActionContext | undefined;
      agent.action('probe', (ctx) => {
        seen = ctx;
        return { ok: true };
      });
      const res = await call('probe');
      expect(res.status).toBe(200);
      expect(res.json.result).toEqual({ ok: true });
      expect(seen?.sourceGroup).toBe('test-group');
      expect(seen?.isMain).toBe(false);
    });

    it('does not appear in search (no schema, no description)', async () => {
      agent.action('probe', () => null);
      const actions = await search('select:probe');
      expect(actions.length).toBe(1);
      expect(actions[0].name).toBe('probe');
      expect(actions[0].description).toBeUndefined();
      expect(actions[0].inputSchema).toBeUndefined();
    });
  });

  describe('overload (name, description, cb)', () => {
    it('stores the description and still has ctx-only callback', async () => {
      agent.action('ping', 'Health check', () => 'pong');
      const res = await call('ping');
      expect(res.json.result).toBe('pong');
      const [entry] = await search('select:ping');
      expect(entry.description).toBe('Health check');
      expect(entry.inputSchema).toBeUndefined();
    });
  });

  describe('overload (name, inputSchema, cb) — schema, no description', () => {
    it('infers args from the zod shape and validates', async () => {
      agent.action(
        'greet',
        { name: z.string() },
        (args) => ({ greeting: `hello ${args.name}` }),
      );
      const ok = await call('greet', { name: 'Alice' });
      expect(ok.status).toBe(200);
      expect(ok.json.result).toEqual({ greeting: 'hello Alice' });

      const bad = await call('greet', { name: 42 });
      expect(bad.status).toBe(400);
    });

    it('emits JSON Schema on /search without a description', async () => {
      agent.action('greet', { name: z.string() }, () => null);
      const [entry] = await search('select:greet');
      expect(entry.description).toBeUndefined();
      expect(entry.inputSchema).toBeDefined();
      const schema = entry.inputSchema as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties).toHaveProperty('name');
    });
  });

  describe('overload (name, description, inputSchema, cb) — full MCP form', () => {
    it('stores all fields and enforces validation', async () => {
      agent.action(
        'search_crm',
        'Look up a customer by query terms',
        { query: z.string(), limit: z.number().optional() },
        async ({ query, limit }) => ({
          results: [`match for ${query}`],
          requested: limit ?? null,
        }),
      );

      const res = await call('search_crm', { query: 'acme', limit: 5 });
      expect(res.status).toBe(200);
      expect(res.json.result).toEqual({
        results: ['match for acme'],
        requested: 5,
      });

      const [entry] = await search('select:search_crm');
      expect(entry.description).toBe('Look up a customer by query terms');
      const schema = entry.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).toHaveProperty('query');
      expect(schema.properties).toHaveProperty('limit');
      expect(schema.required).toEqual(['query']);
    });

    it('required-substring search finds the action', async () => {
      agent.action(
        'search_crm',
        'Look up a customer',
        { query: z.string() },
        async ({ query }) => ({ q: query }),
      );
      const matches = await search('+crm lookup');
      expect(matches.map((a) => a.name)).toContain('search_crm');
    });
  });

  describe('reserved name rejection', () => {
    it('throws on reserved built-in names', () => {
      expect(() => agent.action('schedule_task', () => null)).toThrow(
        /reserved/,
      );
      expect(() => agent.action('search_actions', () => null)).toThrow(
        /reserved/,
      );
      expect(() => agent.action('call_action', () => null)).toThrow(/reserved/);
    });

    it('accepts names that merely share a prefix with reserved ones', () => {
      expect(() =>
        agent.action('schedule_task_helper', () => null),
      ).not.toThrow();
      expect(() => agent.action('search_actions_v2', () => null)).not.toThrow();
    });
  });

  describe('late registration', () => {
    it('actions registered after start() are immediately callable', async () => {
      // Already started in beforeEach. Register now.
      agent.action('late', () => 'late-result');
      const res = await call('late');
      expect(res.status).toBe(200);
      expect(res.json.result).toBe('late-result');
    });

    it('actions can be re-registered (last write wins)', async () => {
      agent.action('flip', () => 'first');
      agent.action('flip', () => 'second');
      const res = await call('flip');
      expect(res.json.result).toBe('second');
    });
  });
});
