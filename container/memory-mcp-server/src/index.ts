/**
 * Memory MCP Server for NanoClaw
 * Provides semantic memory operations over the agent's knowledge vault.
 * Runs as a stdio MCP server alongside the main nanoclaw MCP server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryStore } from './store.js';

const VAULT_PATH = process.env.KNOWLEDGE_VAULT_PATH || '/workspace/group/knowledge';

function errorMessage(err: unknown): string {
  return errorMessage(err);
}

const store = new MemoryStore(VAULT_PATH);

// Index existing vault files on startup
const indexed = await store.indexVault();
console.error(`[memory-mcp] Indexed ${indexed} files from ${VAULT_PATH}`);

const server = new McpServer({
  name: 'memory',
  version: '1.0.0',
});

server.tool(
  'memory_store',
  `Save a memory to the knowledge vault as a markdown file with auto-generated embedding for semantic search.

Categories:
- people: Information about contacts, collaborators, relationships
- projects: Project details, goals, status, timelines
- preferences: User preferences, settings, habits
- decisions: Key decisions made, with reasoning and context
- reference: General reference material, facts, how-tos`,
  {
    title: z.string().describe('Short descriptive title for the memory (used as filename)'),
    text: z.string().describe('The memory content in markdown'),
    category: z
      .enum(['people', 'projects', 'preferences', 'decisions', 'reference'])
      .describe('Memory category'),
    tags: z.array(z.string()).describe('Tags for filtering (e.g., ["work", "urgent"])'),
  },
  async (args) => {
    try {
      const filePath = await store.storeMemory(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory stored: ${filePath}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to store memory: ${errorMessage(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_search',
  'Semantic search over stored memories. Returns the most relevant results ranked by similarity to your query.',
  {
    query: z.string().describe('Natural language search query'),
    top_n: z.number().default(5).describe('Number of results to return (default 5)'),
  },
  async (args) => {
    try {
      const results = await store.search(args.query, args.top_n);

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No memories found.' }],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}** (${r.category}) — similarity: ${r.similarity?.toFixed(3)}\n   Tags: ${r.tags.join(', ') || 'none'}\n   File: ${r.filePath}\n   ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`,
        )
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Search failed: ${errorMessage(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_list',
  'List memories filtered by category and/or tag.',
  {
    category: z
      .enum(['people', 'projects', 'preferences', 'decisions', 'reference'])
      .optional()
      .describe('Filter by category'),
    tag: z.string().optional().describe('Filter by tag'),
  },
  async (args) => {
    try {
      const results = store.listMemories({ category: args.category, tag: args.tag });

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No memories found.' }],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `- **${r.title}** (${r.category}) — tags: ${r.tags.join(', ') || 'none'}\n  File: ${r.filePath}\n  Updated: ${r.updated}`,
        )
        .join('\n');

      return {
        content: [{ type: 'text' as const, text: `${results.length} memories:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `List failed: ${errorMessage(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_link',
  'Create a [[wiki-link]] between two memory files. Updates the `related` frontmatter in both files.',
  {
    file_a: z.string().describe('First memory file (filename like "my-note.md" or absolute path)'),
    file_b: z.string().describe('Second memory file (filename like "other-note.md" or absolute path)'),
  },
  async (args) => {
    try {
      store.linkMemories(args.file_a, args.file_b);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Linked: ${args.file_a} <-> ${args.file_b}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Link failed: ${errorMessage(err)}`,
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
