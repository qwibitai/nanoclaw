/**
 * Google Workspace MCP tools (Phase 13 V1).
 *
 * Two tools today, both for editing Google Docs as plain markdown
 * (which rclone can't do — it surfaces .gdoc files as opaque
 * pointers). Calls go to `${GWS_BASE_URL}/...` which is the host's
 * credential proxy at `http://host.docker.internal:3001/googleapis`;
 * the proxy injects the real OAuth Bearer from
 * `~/.config/gws/credentials.json` so the container never sees any
 * Google credentials.
 *
 * V1 surface — exactly what's needed to close the gap rclone leaves:
 *   drive_doc_read_as_markdown  — export a Google Doc to markdown
 *   drive_doc_write_from_markdown — create or replace a Doc from markdown
 *
 * V2+ (when use cases show up): sheets, calendar, gmail, etc. Each
 * is a thin wrapper around a known googleapis.com endpoint —
 * structurally identical to these two.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const GWS_BASE_URL = process.env.GWS_BASE_URL;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

function requireBaseUrl(): string {
  if (!GWS_BASE_URL) {
    throw new Error(
      'GWS_BASE_URL not set. The host should inject this when spawning the container; if you are running the agent-runner outside a NanoClaw container, this tool is unavailable.',
    );
  }
  return GWS_BASE_URL;
}

async function callGws(path: string, init?: RequestInit): Promise<Response> {
  const base = requireBaseUrl();
  const url = `${base}${path}`;
  const headers = new Headers(init?.headers);
  // The proxy substitutes this with the real OAuth Bearer. Anything
  // we send here is fine — the value is replaced before the request
  // hits googleapis.com.
  if (!headers.has('authorization')) {
    headers.set('authorization', 'Bearer placeholder');
  }
  return fetch(url, { ...init, headers });
}

const driveDocReadAsMarkdown: McpToolDefinition = {
  tool: {
    name: 'drive_doc_read_as_markdown',
    description:
      'Read a Google Doc and return its contents as markdown. Use this when you need to read or analyze the text of a Google Doc — rclone gives you a .gdoc pointer, this gives you the actual content. Pass the Doc file ID (the part after /document/d/ in the URL).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: { type: 'string', description: 'Drive file ID of the Google Doc.' },
      },
      required: ['fileId'],
    },
  },
  async handler(args) {
    const fileId = args.fileId as string;
    if (!fileId) return err('fileId is required');
    try {
      const res = await callGws(
        `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fmarkdown`,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '<no body>');
        return err(`Drive export failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`);
      }
      const markdown = await res.text();
      return ok(markdown);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

const driveDocWriteFromMarkdown: McpToolDefinition = {
  tool: {
    name: 'drive_doc_write_from_markdown',
    description:
      'Create a new Google Doc (or replace an existing one) from markdown content. When `fileId` is provided, that Doc is replaced. When omitted, a new Doc is created with `title` (default "Untitled") in the user\'s root Drive folder. Returns the resulting Doc\'s file ID and webViewLink.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        markdown: { type: 'string', description: 'Markdown body to convert + upload as a Google Doc.' },
        title: { type: 'string', description: 'Document title (used when creating a new Doc).' },
        fileId: { type: 'string', description: 'Existing Doc file ID to overwrite, instead of creating new.' },
      },
      required: ['markdown'],
    },
  },
  async handler(args) {
    const markdown = args.markdown as string;
    if (typeof markdown !== 'string') return err('markdown is required');
    const title = (args.title as string) || 'Untitled';
    const fileId = args.fileId as string | undefined;

    try {
      // The Drive REST API supports importing markdown to a Google Doc
      // via the upload endpoint with `?uploadType=media` and the
      // request body's content-type set to `text/markdown`. For new
      // docs, also pass metadata via `multipart` upload to set title.
      // We use the 'multipart' form: small + handles both create and
      // update with metadata in one call.
      const boundary = `----nanoclaw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const metadata: Record<string, unknown> = {
        mimeType: 'application/vnd.google-apps.document',
      };
      if (!fileId) metadata.name = title;

      const partMetadata =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n`;
      const partBody =
        `--${boundary}\r\n` +
        `Content-Type: text/markdown\r\n\r\n` +
        `${markdown}\r\n` +
        `--${boundary}--`;
      const body = partMetadata + partBody;

      const path = fileId
        ? `/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,webViewLink,name`
        : '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name';
      const method = fileId ? 'PATCH' : 'POST';

      const res = await callGws(path, {
        method,
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '<no body>');
        return err(`Drive upload failed: ${res.status} ${res.statusText} — ${errBody.slice(0, 500)}`);
      }
      const json = (await res.json()) as { id?: string; webViewLink?: string; name?: string };
      const result = {
        fileId: json.id,
        webViewLink: json.webViewLink,
        name: json.name,
      };
      return ok(JSON.stringify(result, null, 2));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([driveDocReadAsMarkdown, driveDocWriteFromMarkdown]);
