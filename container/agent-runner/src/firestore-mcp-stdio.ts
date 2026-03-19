/**
 * Stdio MCP Server for Firestore persistent memory.
 * Provides read/write access to the botti_memory collection.
 * Receives Firebase credentials via GOOGLE_APPLICATION_CREDENTIALS env var.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initializeApp, cert, type ServiceAccount } from 'firebase-admin/app';
import {
  getFirestore,
  FieldValue,
  Timestamp,
  type Query,
} from 'firebase-admin/firestore';
import fs from 'fs';

const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS!;
const sa: ServiceAccount = JSON.parse(fs.readFileSync(saPath, 'utf-8'));

const app = initializeApp({ credential: cert(sa) });
const db = getFirestore(app);

const COLLECTION = 'botti_memory';

const DOC_TYPES = [
  'journal',
  'tasks',
  'contacts',
  'projects',
  'cosy_instructions',
] as const;
type DocType = (typeof DOC_TYPES)[number];

/** Convert Firestore Timestamps to ISO strings for JSON serialization. */
function serializeTimestamps(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Timestamp) {
      result[key] = value.toDate().toISOString();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = serializeTimestamps(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const server = new McpServer({
  name: 'firestore',
  version: '1.0.0',
});

// --- memory_read ---

server.tool(
  'memory_read',
  `Read a specific document from persistent memory by its full ID.
Document IDs use the format "{type}:{identifier}" — e.g., "journal:2026-03-18", "tasks:fix-api-bug", "contacts:eline".

Valid types: journal, tasks, contacts, projects, cosy_instructions.`,
  {
    doc_id: z
      .string()
      .describe(
        'Full document ID, e.g. "journal:2026-03-18" or "contacts:eline"',
      ),
  },
  async (args) => {
    try {
      const doc = await db.collection(COLLECTION).doc(args.doc_id).get();
      if (!doc.exists) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Document "${args.doc_id}" not found.`,
            },
          ],
        };
      }
      const data = serializeTimestamps(doc.data()!);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ id: doc.id, ...data }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading document: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- memory_list ---

server.tool(
  'memory_list',
  `List all documents of a given type from persistent memory, with optional pagination.
Returns documents sorted by updated_at descending (newest first).

Valid types: journal, tasks, contacts, projects, cosy_instructions.`,
  {
    type: z.enum(DOC_TYPES).describe('Document type to list'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe('Max documents to return (default 20, max 100)'),
    start_after: z
      .string()
      .optional()
      .describe('Document ID to start after (for pagination)'),
  },
  async (args) => {
    try {
      let query: Query = db
        .collection(COLLECTION)
        .where('_type', '==', args.type)
        .orderBy('updated_at', 'desc')
        .limit(args.limit);

      if (args.start_after) {
        const cursor = await db
          .collection(COLLECTION)
          .doc(args.start_after)
          .get();
        if (cursor.exists) {
          query = query.startAfter(cursor);
        }
      }

      const snap = await query.get();
      const docs = snap.docs.map((d) => ({
        id: d.id,
        ...serializeTimestamps(d.data()),
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { type: args.type, count: docs.length, documents: docs },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error listing documents: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- memory_search ---

server.tool(
  'memory_search',
  `Search documents in persistent memory by type with optional filters.
Supports filtering by field values, date ranges, and status.

Valid types: journal, tasks, contacts, projects, cosy_instructions.

Filter operators: "==" (equals), ">=" (gte), "<=" (lte), ">" (gt), "<" (lt), "array-contains".`,
  {
    type: z.enum(DOC_TYPES).describe('Document type to search'),
    filters: z
      .array(
        z.object({
          field: z
            .string()
            .describe(
              'Field name to filter on (e.g. "status", "priority", "date")',
            ),
          op: z
            .enum(['==', '>=', '<=', '>', '<', 'array-contains'])
            .describe('Comparison operator'),
          value: z
            .union([z.string(), z.number(), z.boolean()])
            .describe('Value to compare against'),
        }),
      )
      .optional()
      .describe('Array of filters to apply'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe('Max documents to return'),
  },
  async (args) => {
    try {
      let query: Query = db
        .collection(COLLECTION)
        .where('_type', '==', args.type);

      if (args.filters) {
        for (const f of args.filters) {
          query = query.where(f.field, f.op, f.value);
        }
      }

      query = query.limit(args.limit);
      const snap = await query.get();
      const docs = snap.docs.map((d) => ({
        id: d.id,
        ...serializeTimestamps(d.data()),
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { type: args.type, count: docs.length, documents: docs },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error searching documents: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- memory_write ---

server.tool(
  'memory_write',
  `Create or update (upsert) a document in persistent memory.
Automatically sets created_at on first write and updated_at on every write.

Document ID format: "{type}:{identifier}" — e.g.:
- "journal:2026-03-18" — daily journal entry
- "tasks:fix-api-bug" — a task
- "contacts:eline" — a contact
- "projects:website-redesign" — a project
- "cosy_instructions:morning-routine" — a standing instruction

The type prefix in the ID must match one of the valid types.`,
  {
    doc_id: z
      .string()
      .describe('Document ID in "{type}:{id}" format'),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'Document fields to write. Do not include created_at/updated_at — they are managed automatically.',
      ),
  },
  async (args) => {
    const colonIdx = args.doc_id.indexOf(':');
    if (colonIdx === -1) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Invalid doc_id format. Must be "{type}:{identifier}", e.g. "journal:2026-03-18".',
          },
        ],
        isError: true,
      };
    }
    const typePrefix = args.doc_id.slice(0, colonIdx) as DocType;
    if (!DOC_TYPES.includes(typePrefix)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Invalid type prefix "${typePrefix}". Valid types: ${DOC_TYPES.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const docRef = db.collection(COLLECTION).doc(args.doc_id);
      const existing = await docRef.get();

      const writeData: Record<string, unknown> = {
        ...args.data,
        _type: typePrefix,
        updated_at: FieldValue.serverTimestamp(),
      };

      if (!existing.exists) {
        writeData.created_at = FieldValue.serverTimestamp();
      }

      await docRef.set(writeData, { merge: true });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Document "${args.doc_id}" ${existing.exists ? 'updated' : 'created'} successfully.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error writing document: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- memory_delete ---

server.tool(
  'memory_delete',
  'Delete a document from persistent memory. This is irreversible.',
  {
    doc_id: z
      .string()
      .describe(
        'Full document ID to delete, e.g. "tasks:fix-api-bug"',
      ),
  },
  async (args) => {
    try {
      const docRef = db.collection(COLLECTION).doc(args.doc_id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Document "${args.doc_id}" not found.`,
            },
          ],
        };
      }
      await docRef.delete();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Document "${args.doc_id}" deleted.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error deleting document: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
