/**
 * 1Password MCP server for NanoClaw agent containers.
 *
 * Provides secure credential retrieval, creation, and updates via 1Password SDK.
 * Agents use this to log into websites via agent-browser without credentials
 * appearing in chat history or on disk.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createClient,
  ItemCategory,
  ItemFieldType,
  AutofillBehavior,
} from '@1password/sdk';
import type { Client, Item, ItemField } from '@1password/sdk';
import { z } from 'zod';

const tokenPath = process.env.OP_TOKEN_PATH;
if (!tokenPath) {
  process.stderr.write('1password-mcp: OP_TOKEN_PATH not set\n');
  process.exit(1);
}
const token = fs.readFileSync(tokenPath, 'utf-8').trim();

let client: Client;
try {
  client = await createClient({
    auth: token,
    integrationName: 'nanoclaw',
    integrationVersion: '1.0.0',
  });
} catch (err) {
  process.stderr.write(`1password-mcp: failed to initialize: ${err}\n`);
  process.exit(1);
}

const server = new McpServer({ name: '1password', version: '1.0.0' });

interface CacheEntry {
  items: Item[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedItems(vaultId: string): Promise<Item[]> {
  const entry = cache.get(vaultId);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.items;
  }

  const overviews = await client.items.list(vaultId);
  const items = await Promise.all(
    overviews.map((o) => client.items.get(vaultId, o.id)),
  );

  cache.set(vaultId, { items, fetchedAt: Date.now() });
  return items;
}

function invalidateCache(vaultId: string): void {
  cache.delete(vaultId);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

server.tool(
  'list_vaults',
  'List all accessible 1Password vaults',
  {},
  async () => {
    try {
      const vaults = await client.vaults.list();
      return jsonResult(vaults.map((v) => ({ id: v.id, title: v.title })));
    } catch (err) {
      return errorResult(`Failed to list vaults: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  'search_items',
  'Search for items across all properties (title, URLs, notes, tags, field labels). Returns metadata only — use get_secret to retrieve actual credential values.',
  {
    vault_id: z.string().describe('Vault ID to search in'),
    query: z.string().describe('Search query (case-insensitive, matches any property)'),
  },
  async ({ vault_id, query }) => {
    try {
      const items = await getCachedItems(vault_id);
      const q = normalize(query);

      const matches = items.filter((item) => {
        if (normalize(item.title).includes(q)) return true;
        if (item.notes && normalize(item.notes).includes(q)) return true;
        if (item.tags?.some((t) => normalize(t).includes(q))) return true;
        if (item.websites?.some((w) => normalize(w.url).includes(q))) return true;
        if (item.fields?.some((f) => normalize(f.title).includes(q))) return true;
        return false;
      });

      return jsonResult(
        matches.map((item) => ({
          id: item.id,
          title: item.title,
          category: item.category,
          vault_id: item.vaultId,
          websites: item.websites?.map((w) => w.url) ?? [],
          tags: item.tags ?? [],
          fields: item.fields?.map((f) => f.title).filter(Boolean) ?? [],
        })),
      );
    } catch (err) {
      return errorResult(`Search failed: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  'get_secret',
  'Retrieve a specific secret value using a 1Password secret reference (op://vault/item/field)',
  {
    secret_reference: z.string().describe('Secret reference in op://vault/item/field format'),
  },
  async ({ secret_reference }) => {
    try {
      const value = await client.secrets.resolve(secret_reference);
      return jsonResult({ value });
    } catch (err) {
      return errorResult(`Failed to resolve secret: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  'create_item',
  'Create a new login item in 1Password. If password is omitted, a secure one is generated automatically.',
  {
    vault_id: z.string().describe('Vault ID to create the item in'),
    title: z.string().describe('Item title (e.g., "Nobu Restaurant")'),
    username: z.string().optional().describe('Login username or email'),
    password: z.string().optional().describe('Login password (auto-generated if omitted)'),
    url: z.string().optional().describe('Website URL'),
    notes: z.string().optional().describe('Additional notes'),
  },
  async ({ vault_id, title, username, password, url, notes }) => {
    try {
      const fields: ItemField[] = [];

      if (username) {
        fields.push({
          id: 'username',
          title: 'username',
          fieldType: ItemFieldType.Text,
          value: username,
        });
      }

      fields.push({
        id: 'password',
        title: 'password',
        fieldType: ItemFieldType.Concealed,
        value: password ?? randomBytes(24).toString('base64url'),
      });

      const created = await client.items.create({
        category: ItemCategory.Login,
        vaultId: vault_id,
        title,
        fields,
        notes,
        websites: url
          ? [{ url, label: '', autofillBehavior: AutofillBehavior.AnywhereOnWebsite }]
          : undefined,
      });

      invalidateCache(vault_id);

      return jsonResult({
        id: created.id,
        title: created.title,
        vault_id: created.vaultId,
        category: created.category,
      });
    } catch (err) {
      return errorResult(`Failed to create item: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  'update_item',
  'Update fields on an existing 1Password item. Can modify existing fields, add new ones, or remove fields by label.',
  {
    vault_id: z.string().describe('Vault ID containing the item'),
    item_id: z.string().describe('Item ID to update'),
    fields: z
      .array(
        z.object({
          label: z.string().describe('Field label (e.g., "username", "password")'),
          value: z.string().describe('New field value'),
          concealed: z.boolean().optional().describe('Whether the field value should be hidden (default: false)'),
        }),
      )
      .optional()
      .describe('Fields to add or update'),
    remove_fields: z
      .array(z.string())
      .optional()
      .describe('Field labels to remove'),
  },
  async ({ vault_id, item_id, fields, remove_fields }) => {
    try {
      const item = await client.items.get(vault_id, item_id);

      if (remove_fields?.length) {
        const toRemove = new Set(remove_fields.map((l) => l.toLowerCase()));
        item.fields = item.fields.filter(
          (f) => !toRemove.has(f.title.toLowerCase()),
        );
      }

      if (fields?.length) {
        for (const { label, value, concealed } of fields) {
          const existing = item.fields.find(
            (f) => f.title.toLowerCase() === label.toLowerCase(),
          );
          if (existing) {
            existing.value = value;
            if (concealed !== undefined) {
              existing.fieldType = concealed ? ItemFieldType.Concealed : ItemFieldType.Text;
            }
          } else {
            item.fields.push({
              id: label.toLowerCase().replace(/\s+/g, '_'),
              title: label,
              fieldType: concealed ? ItemFieldType.Concealed : ItemFieldType.Text,
              value,
            });
          }
        }
      }

      const updated = await client.items.put(item);
      invalidateCache(vault_id);

      return jsonResult({
        id: updated.id,
        title: updated.title,
        vault_id: updated.vaultId,
        fields: updated.fields.map((f) => f.title).filter(Boolean),
      });
    } catch (err) {
      return errorResult(`Failed to update item: ${err instanceof Error ? err.message : err}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
