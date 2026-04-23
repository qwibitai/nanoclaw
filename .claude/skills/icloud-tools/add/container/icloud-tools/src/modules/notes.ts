import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getImapClient } from '../auth.js';
import { ok, err } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain-text body from a raw MIME source string. */
function extractBody(source: string): string {
  const idx = source.indexOf('\r\n\r\n');
  if (idx === -1) return source;
  return source.slice(idx + 4).trim();
}

/** Build a snippet: first 100 chars, newlines replaced with spaces. */
function buildSnippet(body: string): string {
  return body.replace(/\r?\n/g, ' ').slice(0, 100);
}

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

export async function handleList(params: { folder?: string }) {
  const folder = params.folder ?? 'Notes';

  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return ok([]);
      const total = mailbox.exists;
      if (total === 0) {
        return ok([]);
      }

      const range = '1:*';

      const notes: Array<{
        id: string;
        title: string;
        date: string;
        snippet: string;
      }> = [];

      for await (const msg of client.fetch(range, { envelope: true, source: true, uid: true })) {
        const source = msg.source ? msg.source.toString() : '';
        const body = extractBody(source);

        notes.push({
          id: String(msg.uid),
          title: msg.envelope!.subject ?? '',
          date: msg.envelope!.date?.toISOString?.() ?? String(msg.envelope!.date ?? ''),
          snippet: buildSnippet(body),
        });
      }

      return ok(notes);
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to list notes: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleRead(params: { id: string }) {
  const uid = parseInt(params.id, 10);

  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('Notes');
    try {
      let found = null;

      for await (const msg of client.fetch(uid, { envelope: true, source: true, uid: true }, { uid: true })) {
        found = msg;
      }

      if (!found) {
        return err(`Note ${params.id} not found`);
      }

      const source = found.source ? found.source.toString() : '';
      const body = extractBody(source);

      return ok({
        title: found.envelope!.subject ?? '',
        date: found.envelope!.date?.toISOString?.() ?? String(found.envelope!.date ?? ''),
        body,
      });
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to read note: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Registration
// ---------------------------------------------------------------------------

export function registerNotes(server: McpServer): void {
  server.tool(
    'icloud_notes_list',
    'List all notes in an iCloud Notes folder',
    {
      folder: z.string().optional().describe('Notes folder to list (default: Notes). Use for subfolders like Notes/Work'),
    },
    async (params) => handleList(params),
  );

  server.tool(
    'icloud_notes_read',
    'Read the full content of an iCloud note',
    {
      id: z.string().describe('UID of the note to read'),
    },
    async (params) => handleRead(params),
  );
}
