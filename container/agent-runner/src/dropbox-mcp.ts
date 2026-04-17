/**
 * Dropbox MCP Server — custom, no third-party dependencies beyond the
 * official `dropbox` npm package (maintained by Dropbox).
 *
 * Runs as a stdio MCP server inside the container. Uses a refresh token
 * stored in env vars so access tokens auto-refresh indefinitely.
 *
 * Env vars required:
 *   DROPBOX_APP_KEY
 *   DROPBOX_APP_SECRET
 *   DROPBOX_REFRESH_TOKEN
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Dropbox } from 'dropbox';
import { z } from 'zod';

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

if (!APP_KEY || !APP_SECRET || !REFRESH_TOKEN) {
  console.error('[dropbox-mcp] Missing DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN');
  process.exit(1);
}

const dbx = new Dropbox({
  clientId: APP_KEY,
  clientSecret: APP_SECRET,
  refreshToken: REFRESH_TOKEN,
  fetch: (url: string, init?: any) => fetch(url, init),
});

function asText(data: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function asError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: `Dropbox error: ${msg}` }],
    isError: true,
  };
}

const server = new McpServer({ name: 'dropbox', version: '1.0.0' });

server.tool(
  'list_folder',
  'List files and folders at a given Dropbox path. Use empty string "" for the root. Returns name, path, type (file/folder), size, and modified time for each entry.',
  {
    path: z
      .string()
      .describe('Dropbox path starting with / (or empty string for root)'),
    recursive: z
      .boolean()
      .optional()
      .describe('Recurse into subfolders (default: false)'),
  },
  async (args) => {
    try {
      const res = await dbx.filesListFolder({
        path: args.path === '/' ? '' : args.path,
        recursive: args.recursive ?? false,
      });
      const entries = res.result.entries.map((e) => ({
        name: e.name,
        path: (e as any).path_display,
        type: e['.tag'],
        size: (e as any).size,
        modified: (e as any).server_modified,
      }));
      return asText({ entries, has_more: res.result.has_more });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'upload_file',
  'Upload content as a file to Dropbox. For text, pass the content directly. For binary, pass base64-encoded content with is_base64=true. Creates parent folders if needed via autorename.',
  {
    path: z
      .string()
      .describe('Destination path in Dropbox (e.g. "/Invoices/2026-04/acme.pdf")'),
    content: z.string().describe('File content (text or base64)'),
    is_base64: z
      .boolean()
      .optional()
      .describe('Set true if content is base64-encoded binary'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Overwrite if file exists (default: false — appends a suffix)'),
  },
  async (args) => {
    try {
      const contents = args.is_base64
        ? Buffer.from(args.content, 'base64')
        : Buffer.from(args.content, 'utf-8');
      const res = await dbx.filesUpload({
        path: args.path,
        contents,
        mode: { '.tag': args.overwrite ? 'overwrite' : 'add' } as any,
        autorename: !args.overwrite,
      });
      return asText({
        path: res.result.path_display,
        size: res.result.size,
        id: res.result.id,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'download_file',
  'Download a file from Dropbox. Returns content as text. For binary files, use get_temporary_link to get a URL instead.',
  {
    path: z.string().describe('Dropbox path of the file'),
  },
  async (args) => {
    try {
      const res = await dbx.filesDownload({ path: args.path });
      const buf: Buffer | undefined = (res.result as any).fileBinary;
      if (!buf) {
        return asError('No binary content returned');
      }
      const text = buf.toString('utf-8');
      return asText({
        path: res.result.path_display,
        size: res.result.size,
        content: text.slice(0, 50000),
        truncated: text.length > 50000,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'search',
  'Search for files and folders in Dropbox by name or content. Returns matching paths.',
  {
    query: z.string().describe('Search query'),
    path: z
      .string()
      .optional()
      .describe('Restrict to this folder (default: entire Dropbox)'),
    max_results: z
      .number()
      .optional()
      .describe('Max results (default 20, max 100)'),
  },
  async (args) => {
    try {
      const res = await dbx.filesSearchV2({
        query: args.query,
        options: {
          path: args.path,
          max_results: args.max_results ?? 20,
        },
      });
      const matches = (res.result.matches || []).map((m: any) => ({
        path: m.metadata?.metadata?.path_display,
        name: m.metadata?.metadata?.name,
        type: m.metadata?.metadata?.['.tag'],
      }));
      return asText({ matches });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'create_folder',
  'Create a folder at the given path. Parent folders are NOT auto-created.',
  {
    path: z.string().describe('Folder path to create (e.g. "/Invoices/2026-04")'),
  },
  async (args) => {
    try {
      const res = await dbx.filesCreateFolderV2({
        path: args.path,
        autorename: false,
      });
      return asText({ path: res.result.metadata.path_display });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'delete',
  'Delete a file or folder at the given path. Irreversible for 30 days (moves to deleted files).',
  {
    path: z.string().describe('Path to delete'),
  },
  async (args) => {
    try {
      const res = await dbx.filesDeleteV2({ path: args.path });
      return asText({ deleted: res.result.metadata.path_display });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'get_temporary_link',
  'Get a short-lived (~4 hour) direct download URL for a file. Good for sharing the contents of a file with the user via a link.',
  {
    path: z.string().describe('Path to the file'),
  },
  async (args) => {
    try {
      const res = await dbx.filesGetTemporaryLink({ path: args.path });
      return asText({ link: res.result.link, path: res.result.metadata.path_display });
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'create_shared_link',
  'Create (or return existing) shareable public link for a file or folder. Anyone with the link can view.',
  {
    path: z.string().describe('Path to share'),
  },
  async (args) => {
    try {
      // Try to create; if already exists, list existing links instead.
      try {
        const res = await dbx.sharingCreateSharedLinkWithSettings({
          path: args.path,
        });
        return asText({ url: res.result.url });
      } catch (e: any) {
        if (e?.error?.error?.['.tag'] === 'shared_link_already_exists') {
          const list = await dbx.sharingListSharedLinks({ path: args.path });
          return asText({ url: list.result.links[0]?.url });
        }
        throw e;
      }
    } catch (err) {
      return asError(err);
    }
  },
);

server.tool(
  'account_info',
  'Return Dropbox account info (name, email, account id). Useful as a health check.',
  {},
  async () => {
    try {
      const res = await dbx.usersGetCurrentAccount();
      return asText({
        name: res.result.name.display_name,
        email: res.result.email,
        account_id: res.result.account_id,
      });
    } catch (err) {
      return asError(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[dropbox-mcp] ready');
}

main().catch((err) => {
  console.error('[dropbox-mcp] fatal:', err);
  process.exit(1);
});
