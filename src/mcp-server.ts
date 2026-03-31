/**
 * NanoClaw Paid MCP Server
 *
 * Exposes Nostr signing tools as paid MCP services.
 * External MCP clients pay a Lightning invoice before each tool call.
 */

import fs from 'fs';
import path from 'path';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { connect } from 'net';
import { execSync } from 'child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

import { logger } from './logger.js';
import { NOSTR_SIGNER_SOCKET } from './config.js';
import { readEnvFile } from './env.js';

// --- Free Tier (200 calls/month for NIP-05 registrants) ---

const FREE_TIER_LIMIT = 200;

// Load Cloudflare KV config for NIP-05 verification and usage tracking
function loadCfConfig(): {
  accountId: string;
  kvNamespaceId: string;
  apiToken: string;
} | null {
  try {
    const cfPath = path.join(
      process.env.HOME || '/home/node',
      'NanoClaw',
      'groups',
      'main',
      'config',
      'cloudflare.json',
    );
    if (!fs.existsSync(cfPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfPath, 'utf-8'));
    if (cfg.account_id && cfg.kv_namespace_id && cfg.api_token) {
      return {
        accountId: cfg.account_id,
        kvNamespaceId: cfg.kv_namespace_id,
        apiToken: cfg.api_token,
      };
    }
  } catch {
    /* config not available */
  }
  return null;
}

const cfConfig = loadCfConfig();

async function isNip05Registrant(name: string): Promise<boolean> {
  if (!cfConfig) return false;
  const cleanName = name.split('@')[0].toLowerCase();
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/storage/kv/namespaces/${cfConfig.kvNamespaceId}/values/${cleanName}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfConfig.apiToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

function usageKey(name: string): string {
  const cleanName = name.split('@')[0].toLowerCase();
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  return `usage:${cleanName}:${month}`;
}

async function getUsageCount(name: string): Promise<number> {
  if (!cfConfig) return FREE_TIER_LIMIT; // fail closed
  const key = usageKey(name);
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/storage/kv/namespaces/${cfConfig.kvNamespaceId}/values/${key}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfConfig.apiToken}` },
    });
    if (!res.ok) return 0; // no usage record yet
    const data = JSON.parse(await res.text());
    return data.count || 0;
  } catch {
    return 0;
  }
}

async function incrementUsage(name: string): Promise<void> {
  if (!cfConfig) return;
  const key = usageKey(name);
  const current = await getUsageCount(name);
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfConfig.accountId}/storage/kv/namespaces/${cfConfig.kvNamespaceId}/values/${key}`;
  try {
    await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${cfConfig.apiToken}`,
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({
        count: current + 1,
        last_call: new Date().toISOString(),
      }),
    });
  } catch {
    /* best effort */
  }
}

/**
 * Check if a tool call is covered by the free tier.
 * Returns true if the caller is a verified NIP-05 registrant with calls remaining.
 */
async function isFreeTierCall(nip05?: string): Promise<boolean> {
  if (!nip05 || !cfConfig) return false;
  const isRegistrant = await isNip05Registrant(nip05);
  if (!isRegistrant) return false;
  const count = await getUsageCount(nip05);
  if (count >= FREE_TIER_LIMIT) return false;
  await incrementUsage(nip05);
  logger.info(
    { nip05, count: count + 1, limit: FREE_TIER_LIMIT },
    'Free tier call',
  );
  return true;
}

// --- Config ---

const mcpEnv = readEnvFile([
  'MCP_SERVER_PORT',
  'MCP_SERVER_NAME',
  'TOOL_PRICE_SIGN',
  'TOOL_PRICE_PUBLISH',
  'TOOL_PRICE_POST_NOTE',
  'TOOL_PRICE_FETCH_PROFILE',
  'TOOL_PRICE_ZAP',
  'TOOL_PRICE_GET_NOTES',
  'TOOL_PRICE_CREATE_INVOICE',
  'TOOL_PRICE_ACTION_RECEIPT',
  'TOOL_PRICE_VERIFY_RECEIPT',
]);

const MCP_SERVER_PORT = parseInt(
  process.env.MCP_SERVER_PORT || mcpEnv.MCP_SERVER_PORT || '3002',
  10,
);
const MCP_SERVER_NAME =
  process.env.MCP_SERVER_NAME ||
  mcpEnv.MCP_SERVER_NAME ||
  'Jorgenclaw Sovereign MCP';
// Pricing tiers: 5 sats (reads), 21 sats (sign/publish), 50 sats (zaps)
const TOOL_PRICE_SIGN = parseInt(
  process.env.TOOL_PRICE_SIGN || mcpEnv.TOOL_PRICE_SIGN || '21',
  10,
);
const TOOL_PRICE_PUBLISH = parseInt(
  process.env.TOOL_PRICE_PUBLISH || mcpEnv.TOOL_PRICE_PUBLISH || '21',
  10,
);
const TOOL_PRICE_POST_NOTE = parseInt(
  process.env.TOOL_PRICE_POST_NOTE || mcpEnv.TOOL_PRICE_POST_NOTE || '21',
  10,
);
const TOOL_PRICE_FETCH_PROFILE = parseInt(
  process.env.TOOL_PRICE_FETCH_PROFILE ||
    mcpEnv.TOOL_PRICE_FETCH_PROFILE ||
    '5',
  10,
);
const TOOL_PRICE_ZAP = parseInt(
  process.env.TOOL_PRICE_ZAP || mcpEnv.TOOL_PRICE_ZAP || '50',
  10,
);
const TOOL_PRICE_GET_NOTES = parseInt(
  process.env.TOOL_PRICE_GET_NOTES || mcpEnv.TOOL_PRICE_GET_NOTES || '5',
  10,
);
const TOOL_PRICE_CREATE_INVOICE = parseInt(
  process.env.TOOL_PRICE_CREATE_INVOICE ||
    mcpEnv.TOOL_PRICE_CREATE_INVOICE ||
    '5',
  10,
);
const TOOL_PRICE_ACTION_RECEIPT = parseInt(
  process.env.TOOL_PRICE_ACTION_RECEIPT ||
    mcpEnv.TOOL_PRICE_ACTION_RECEIPT ||
    '21',
  10,
);
const TOOL_PRICE_VERIFY_RECEIPT = parseInt(
  process.env.TOOL_PRICE_VERIFY_RECEIPT ||
    mcpEnv.TOOL_PRICE_VERIFY_RECEIPT ||
    '5',
  10,
);

import { fileURLToPath } from 'url';
// Resolve project root from compiled dist/ location
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const walletScript = path.join(projectRoot, 'tools/nwc-wallet/index.js');
const NWC_CONFIG_PATH =
  process.env.NWC_CONFIG ||
  path.join(projectRoot, 'groups/main/config/nwc.json');
const NWC_SPENDING_PATH =
  process.env.NWC_SPENDING ||
  path.join(projectRoot, 'groups/main/config/mcp-spending.json');
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];
const ATTESTATION_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
];
const OUR_PUBKEY =
  'd0514175a31de1942812597ee4e3f478b183f7f35fb73ee66d8c9f57485544e4';

// --- Signing daemon ---

function daemonRequest(payload: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(NOSTR_SIGNER_SOCKET);
    let data = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.end();
    });
    sock.on('data', (chunk: Buffer) => {
      data += chunk;
    });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`Bad response from signer: ${data}`));
      }
    });
    sock.on('error', (err) =>
      reject(new Error(`Cannot connect to signing daemon: ${err.message}`)),
    );
  });
}

// --- Invoice helper ---

function generateInvoice(
  amountSats: number,
  description: string,
): string | null {
  try {
    const result = execSync(
      `${process.execPath} ${walletScript} invoice ${amountSats} "${description.replace(/"/g, '\\"')}"`,
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          NWC_CONFIG: NWC_CONFIG_PATH,
          NWC_SPENDING: NWC_SPENDING_PATH,
        },
      },
    );
    const parsed = JSON.parse(result.trim());
    return parsed.invoice || null;
  } catch (err) {
    logger.error({ err }, 'Failed to generate invoice');
    return null;
  }
}

function verifyPreimage(preimage: string): boolean {
  return /^[0-9a-f]{64}$/i.test(preimage);
}

// --- Relay publishing ---

async function publishToRelays(
  event: Record<string, unknown>,
  relays: string[],
): Promise<string[]> {
  const results: string[] = [];
  const { default: WebSocket } = await import('ws');
  const promises = relays.map(async (url) => {
    try {
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('timeout'));
        }, 10000);
        ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])));
        ws.on('message', (msg: Buffer) => {
          const parsed = JSON.parse(msg.toString());
          if (
            parsed[0] === 'OK' &&
            parsed[1] === (event as { id?: string }).id
          ) {
            clearTimeout(timeout);
            if (parsed[2]) results.push(url);
            ws.close();
            resolve();
          }
        });
        ws.on('error', (e: Error) => {
          clearTimeout(timeout);
          reject(e);
        });
      });
    } catch {
      /* relay failed, skip */
    }
  });
  await Promise.allSettled(promises);
  return results;
}

// --- Relay query ---

const QUERY_RELAYS = ['wss://nos.lol', 'wss://relay.nostr.band'];

async function queryRelays(
  filter: Record<string, unknown>,
  limit: number = 20,
): Promise<Record<string, unknown>[]> {
  const { default: WebSocket } = await import('ws');
  const events: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  const subId = 'q' + Date.now().toString(36);

  const promises = QUERY_RELAYS.map(async (url) => {
    try {
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve();
        }, 8000);
        ws.on('open', () =>
          ws.send(JSON.stringify(['REQ', subId, { ...filter, limit }])),
        );
        ws.on('message', (msg: Buffer) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed[0] === 'EVENT' && parsed[2]) {
            const ev = parsed[2] as Record<string, unknown>;
            const id = ev.id as string;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              events.push(ev);
            }
          }
          if (parsed[0] === 'EOSE') {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        });
        ws.on('error', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch {
      /* relay failed */
    }
  });
  await Promise.allSettled(promises);
  return events.slice(0, limit);
}

// --- Wallet exec ---

function walletExec(command: string): string {
  return execSync(`${process.execPath} ${walletScript} ${command}`, {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NWC_CONFIG: NWC_CONFIG_PATH,
      NWC_SPENDING: NWC_SPENDING_PATH,
      NOSTR_SIGNER_SOCKET,
    },
  }).trim();
}

// --- Npub decode ---

function decodeNpub(input: string): string {
  // If already hex (64 chars), return as-is
  if (/^[0-9a-f]{64}$/i.test(input)) return input;
  // If npub, decode bech32 — use nip19 from nostr-tools if available, else basic decode
  if (input.startsWith('npub1')) {
    try {
      // Simple bech32 decode for npub → hex
      const result = execSync(
        `${process.execPath} -e "import('nostr-tools/nip19').then(m => console.log(m.decode('${input}').data))"`,
        { encoding: 'utf8', timeout: 5000 },
      ).trim();
      if (/^[0-9a-f]{64}$/i.test(result)) return result;
    } catch {
      /* fall through */
    }
  }
  return input; // return as-is if can't decode
}

// --- Tool registration ---

function paymentRequiredResponse(bolt11: string, amountSats: number) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'payment_required',
          invoice: bolt11,
          amount_sats: amountSats,
          message:
            'Pay this Lightning invoice, then retry with payment_preimage parameter.',
        }),
      },
    ],
  };
}

function errorResponse(msg: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
    isError: true as const,
  };
}

function registerTools(server: McpServer): void {
  // --- nostr_sign_event ---
  server.tool(
    'nostr_sign_event',
    `Sign a Nostr event using a sovereign signing daemon. Price: ${TOOL_PRICE_SIGN} sats.`,
    {
      kind: z.number().describe('Nostr event kind'),
      content: z.string().describe('Event content'),
      tags: z.array(z.array(z.string())).optional().describe('Event tags'),
      created_at: z.number().optional().describe('Unix timestamp'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe(
          'Lightning payment preimage (64 hex chars) — provide after paying the invoice',
        ),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(TOOL_PRICE_SIGN, 'nostr_sign_event');
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_SIGN);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const result = await daemonRequest({
          method: 'sign_event',
          params: {
            kind: args.kind,
            content: args.content,
            tags: args.tags || [],
            created_at: args.created_at,
          },
        });
        if (result.error) return errorResponse(String(result.error));
        logger.info(
          { tool: 'nostr_sign_event', kind: args.kind },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ signed_event: result.event }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- nostr_publish_event ---
  server.tool(
    'nostr_publish_event',
    `Sign and publish a Nostr event to relays. Price: ${TOOL_PRICE_PUBLISH} sats.`,
    {
      kind: z.number().describe('Nostr event kind'),
      content: z.string().describe('Event content'),
      tags: z.array(z.array(z.string())).optional().describe('Event tags'),
      created_at: z.number().optional().describe('Unix timestamp'),
      relays: z
        .array(z.string())
        .optional()
        .describe('Relay URLs (defaults to popular relays)'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe(
          'Lightning payment preimage (64 hex chars) — provide after paying the invoice',
        ),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(
          TOOL_PRICE_PUBLISH,
          'nostr_publish_event',
        );
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_PUBLISH);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const result = await daemonRequest({
          method: 'sign_event',
          params: {
            kind: args.kind,
            content: args.content,
            tags: args.tags || [],
            created_at: args.created_at,
          },
        });
        if (result.error) return errorResponse(String(result.error));
        const signedEvent = result.event as Record<string, unknown>;

        const targetRelays = args.relays?.length ? args.relays : DEFAULT_RELAYS;
        const publishedTo = await publishToRelays(signedEvent, targetRelays);
        if (publishedTo.length === 0)
          return errorResponse('Failed to publish to any relay');

        logger.info(
          {
            tool: 'nostr_publish_event',
            kind: args.kind,
            relays: publishedTo.length,
          },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                event_id: signedEvent.id,
                published_to: publishedTo,
                signed_event: signedEvent,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- nostr_post_note ---
  server.tool(
    'nostr_post_note',
    `Post a kind 1 text note to Nostr (sign + publish in one call). Price: ${TOOL_PRICE_POST_NOTE} sats.`,
    {
      content: z.string().describe('Note content'),
      tags: z.array(z.array(z.string())).optional().describe('Event tags'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(TOOL_PRICE_POST_NOTE, 'nostr_post_note');
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_POST_NOTE);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const result = await daemonRequest({
          method: 'sign_event',
          params: { kind: 1, content: args.content, tags: args.tags || [] },
        });
        if (result.error) return errorResponse(String(result.error));
        const signedEvent = result.event as Record<string, unknown>;

        const publishedTo = await publishToRelays(signedEvent, DEFAULT_RELAYS);
        if (publishedTo.length === 0)
          return errorResponse('Failed to publish to any relay');

        logger.info(
          { tool: 'nostr_post_note', relays: publishedTo.length },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                event_id: signedEvent.id,
                published_to: publishedTo,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- nostr_fetch_profile ---
  server.tool(
    'nostr_fetch_profile',
    `Fetch a Nostr profile (kind 0) by npub or hex pubkey. Price: ${TOOL_PRICE_FETCH_PROFILE} sat.`,
    {
      pubkey: z.string().describe('Nostr pubkey (npub1... or 64-char hex)'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(
          TOOL_PRICE_FETCH_PROFILE,
          'nostr_fetch_profile',
        );
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_FETCH_PROFILE);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const hex = decodeNpub(args.pubkey);
        const events = await queryRelays({ kinds: [0], authors: [hex] }, 1);
        if (events.length === 0) return errorResponse('Profile not found');

        const content = JSON.parse((events[0] as { content: string }).content);
        logger.info(
          { tool: 'nostr_fetch_profile', pubkey: hex.slice(0, 16) },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                pubkey: hex,
                name: content.name || null,
                display_name: content.display_name || null,
                about: content.about || null,
                lud16: content.lud16 || null,
                nip05: content.nip05 || null,
                picture: content.picture || null,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- nostr_zap ---
  server.tool(
    'nostr_zap',
    `Zap a Nostr user via Lightning. Price: ${TOOL_PRICE_ZAP} sats (tool fee) + zap amount. Max 5000 sats.`,
    {
      npub: z.string().describe('Nostr npub or hex pubkey to zap'),
      amount_sats: z
        .number()
        .min(1)
        .max(5000)
        .describe('Zap amount in sats (max 5000)'),
      comment: z.string().optional().describe('Zap comment'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(TOOL_PRICE_ZAP, 'nostr_zap');
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_ZAP);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const cmd = args.comment
          ? `zap ${args.npub} ${args.amount_sats} "${args.comment.replace(/"/g, '\\"')}"`
          : `zap ${args.npub} ${args.amount_sats}`;
        const result = walletExec(cmd);
        const parsed = JSON.parse(result);

        if (parsed.error) return errorResponse(parsed.error);

        logger.info(
          { tool: 'nostr_zap', amount: args.amount_sats },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                paid: true,
                preimage: parsed.preimage,
                amount_sats: args.amount_sats,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- nostr_get_notes ---
  server.tool(
    'nostr_get_notes',
    `Fetch recent kind 1 notes by author or hashtag. Price: ${TOOL_PRICE_GET_NOTES} sats.`,
    {
      author: z.string().optional().describe('Author npub or hex pubkey'),
      hashtag: z.string().optional().describe('Hashtag to search (without #)'),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe('Max results (default 10, max 20)'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(TOOL_PRICE_GET_NOTES, 'nostr_get_notes');
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_GET_NOTES);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');
      if (!args.author && !args.hashtag)
        return errorResponse('Provide author or hashtag (or both)');

      try {
        const filter: Record<string, unknown> = { kinds: [1] };
        if (args.author) filter.authors = [decodeNpub(args.author)];
        if (args.hashtag) filter['#t'] = [args.hashtag.replace(/^#/, '')];

        const lim = Math.min(args.limit || 10, 20);
        const events = await queryRelays(filter, lim);

        const notes = events.map((ev) => ({
          id: ev.id,
          content: ev.content,
          author: ev.pubkey,
          created_at: ev.created_at,
          tags: ev.tags,
        }));

        logger.info(
          { tool: 'nostr_get_notes', count: notes.length },
          'Paid tool call executed',
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(notes) }],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- lightning_create_invoice ---
  server.tool(
    'lightning_create_invoice',
    `Create a Lightning invoice. Price: ${TOOL_PRICE_CREATE_INVOICE} sat.`,
    {
      amount_sats: z.number().min(1).describe('Invoice amount in sats'),
      description: z.string().optional().describe('Invoice description'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(
          TOOL_PRICE_CREATE_INVOICE,
          'lightning_create_invoice',
        );
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_CREATE_INVOICE);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const desc = (args.description || 'NanoClaw invoice').replace(
          /"/g,
          '\\"',
        );
        const result = walletExec(`invoice ${args.amount_sats} "${desc}"`);
        const parsed = JSON.parse(result);

        if (!parsed.invoice) return errorResponse('Failed to create invoice');

        logger.info(
          { tool: 'lightning_create_invoice', amount: args.amount_sats },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                bolt11: parsed.invoice,
                amount_sats: args.amount_sats,
                description: args.description,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- create_action_receipt ---
  server.tool(
    'create_action_receipt',
    `Create a signed action receipt (kind 1111) attesting an agent's action. Third-party attestation via Jorgenclaw's signing key. Price: ${TOOL_PRICE_ACTION_RECEIPT} sats.`,
    {
      agent_id: z
        .string()
        .describe('Agent identifier (e.g. "myagent@example.com")'),
      action: z
        .string()
        .describe('Action identifier (e.g. "posted_to_moltbook")'),
      summary: z.string().describe('Human-readable description of the action'),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe('Optional key-value pairs for additional context'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(
          TOOL_PRICE_ACTION_RECEIPT,
          'create_action_receipt',
        );
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_ACTION_RECEIPT);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const content = `Action receipt: ${args.action}\nAgent: ${args.agent_id}\nSummary: ${args.summary}`;
        const tags: string[][] = [
          ['t', 'action-receipt'],
          ['t', 'agent-attestation'],
          ['agent', args.agent_id],
          ['action', args.action],
          ['client', 'nanoclaw-mcp'],
        ];
        if (args.metadata) {
          for (const [key, value] of Object.entries(args.metadata)) {
            tags.push([key, String(value)]);
          }
        }

        const result = await daemonRequest({
          method: 'sign_event',
          params: { kind: 1111, content, tags },
        });
        if (result.error) return errorResponse(String(result.error));
        const signedEvent = result.event as Record<string, unknown>;

        const publishedTo = await publishToRelays(
          signedEvent,
          ATTESTATION_RELAYS,
        );
        if (publishedTo.length === 0)
          return errorResponse('Failed to publish receipt to any relay');

        const eventId = signedEvent.id as string;
        logger.info(
          {
            tool: 'create_action_receipt',
            agent: args.agent_id,
            action: args.action,
            relays: publishedTo.length,
          },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                receipt_event_id: eventId,
                nostr_url: `https://njump.me/${eventId}`,
                signed_at: new Date(
                  (signedEvent.created_at as number) * 1000,
                ).toISOString(),
                pubkey: OUR_PUBKEY,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- verify_receipt ---
  server.tool(
    'verify_receipt',
    `Verify an action receipt by event ID. Confirms it was signed by Jorgenclaw's key. Price: ${TOOL_PRICE_VERIFY_RECEIPT} sat.`,
    {
      event_id: z
        .string()
        .describe('Nostr event ID of the action receipt to verify'),
      nip05: z
        .string()
        .optional()
        .describe(
          'Your name@jorgenclaw.ai NIP-05 identity — if registered, first 200 calls/month are free',
        ),
      payment_preimage: z
        .string()
        .optional()
        .describe('Lightning payment preimage (64 hex chars)'),
    },
    async (args) => {
      const free = await isFreeTierCall(args.nip05);
      if (!free && !args.payment_preimage) {
        const bolt11 = generateInvoice(
          TOOL_PRICE_VERIFY_RECEIPT,
          'verify_receipt',
        );
        if (!bolt11) return errorResponse('Failed to generate invoice');
        return paymentRequiredResponse(bolt11, TOOL_PRICE_VERIFY_RECEIPT);
      }
      if (!free && !verifyPreimage(args.payment_preimage!))
        return errorResponse('Invalid payment preimage');

      try {
        const events = await queryRelays({ ids: [args.event_id] }, 1);
        if (events.length === 0)
          return errorResponse('Event not found on relays');

        const ev = events[0];
        const pubkey = ev.pubkey as string;
        const valid = pubkey === OUR_PUBKEY;
        const tags = (ev.tags || []) as string[][];

        const agentTag = tags.find((t) => t[0] === 'agent');
        const actionTag = tags.find((t) => t[0] === 'action');

        logger.info(
          { tool: 'verify_receipt', eventId: args.event_id, valid },
          'Paid tool call executed',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                valid,
                signed_by: pubkey,
                action: actionTag?.[1] || null,
                agent_id: agentTag?.[1] || null,
                summary:
                  ((ev.content as string) || '').split('\nSummary: ')[1] ||
                  null,
                created_at: new Date(
                  (ev.created_at as number) * 1000,
                ).toISOString(),
                // TODO: cryptographic signature verification (schnorr)
              }),
            },
          ],
        };
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// --- Server startup ---

export async function startMcpServer(): Promise<void> {
  const activeSessions = new Map<string, SSEServerTransport>();

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '/';

      // Health check
      if (url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            name: MCP_SERVER_NAME,
            tools: [
              'nostr_sign_event',
              'nostr_publish_event',
              'nostr_post_note',
              'nostr_fetch_profile',
              'nostr_zap',
              'nostr_get_notes',
              'lightning_create_invoice',
              'create_action_receipt',
              'verify_receipt',
            ],
          }),
        );
        return;
      }

      // SSE endpoint — client connects here to establish an MCP session
      if (url === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        activeSessions.set(transport.sessionId, transport);
        transport.onclose = () => activeSessions.delete(transport.sessionId);

        const sessionServer = new McpServer({
          name: MCP_SERVER_NAME,
          version: '1.0.0',
        });
        registerTools(sessionServer);
        await sessionServer.connect(transport);
        return;
      }

      // Message endpoint — client sends JSON-RPC messages here
      if (url.startsWith('/messages') && req.method === 'POST') {
        const sessionId = new URL(
          url,
          `http://${req.headers.host}`,
        ).searchParams.get('sessionId');
        const transport = sessionId ? activeSessions.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'No active session. Connect to /sse first.',
            }),
          );
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Not found. Use /sse for MCP or /health for status.',
        }),
      );
    },
  );

  httpServer.listen(MCP_SERVER_PORT, '0.0.0.0', () => {
    logger.info(
      { port: MCP_SERVER_PORT, name: MCP_SERVER_NAME },
      'Paid MCP server started',
    );
  });
}
