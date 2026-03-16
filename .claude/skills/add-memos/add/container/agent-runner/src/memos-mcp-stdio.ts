/**
 * Stdio MCP Server for MemOS memory operations.
 * Gives container agents explicit tools to search and store memories.
 * Communicates with the MemOS API via HTTP.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const MEMOS_API_URL = process.env.MEMOS_API_URL || '';
const MEMOS_USER_ID = process.env.MEMOS_USER_ID || 'agent';
const REQUEST_TIMEOUT = 10000;

const server = new McpServer({
  name: 'memos',
  version: '1.0.0',
});

server.tool(
  'search_memories',
  'Search your persistent memory for relevant information. Use this to recall past conversations, decisions, user preferences, or any previously stored knowledge.',
  {
    query: z.string().describe('What to search for in memory'),
  },
  async (args) => {
    try {
      const resp = await fetch(`${MEMOS_API_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query, user_id: MEMOS_USER_ID }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!resp.ok) {
        return { content: [{ type: 'text' as const, text: `Memory search failed (${resp.status})` }] };
      }

      const json = await resp.json();
      const data = json.data;
      if (!data || typeof data !== 'object') {
        return { content: [{ type: 'text' as const, text: 'No relevant memories found.' }] };
      }

      // MemOS returns categories (text_mem, act_mem, etc.), each containing
      // cubes with memories arrays. Flatten all memories from all categories.
      const memories: { memory: string; score: number }[] = [];
      for (const category of Object.values(data)) {
        if (!Array.isArray(category)) continue;
        for (const cube of category as { memories?: { memory?: string; score?: number }[] }[]) {
          if (!Array.isArray(cube.memories)) continue;
          for (const mem of cube.memories) {
            if (mem.memory) memories.push({ memory: mem.memory, score: mem.score ?? 0 });
          }
        }
      }

      if (memories.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No relevant memories found.' }] };
      }

      const formatted = memories
        .map((item, i) => `[${i + 1}] (relevance: ${item.score.toFixed(2)}) ${item.memory}`)
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Memory search error: ${err}` }] };
    }
  },
);

server.tool(
  'add_memory',
  'Store important information in your persistent memory. Use this for facts, decisions, user preferences, or anything worth remembering across conversations.',
  {
    content: z.string().describe('The information to remember'),
  },
  async (args) => {
    try {
      const resp = await fetch(`${MEMOS_API_URL}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: MEMOS_USER_ID,
          messages: [{ role: 'user', content: args.content }],
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!resp.ok) {
        return { content: [{ type: 'text' as const, text: `Failed to store memory (${resp.status})` }] };
      }

      const json = await resp.json();
      return { content: [{ type: 'text' as const, text: json.message || 'Memory stored.' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Memory store error: ${err}` }] };
    }
  },
);

server.tool(
  'chat',
  'Ask a question about your stored memories. Unlike search, this returns a natural language answer synthesized from relevant memories.',
  {
    query: z.string().describe('The question to ask about your memories'),
  },
  async (args) => {
    try {
      const resp = await fetch(`${MEMOS_API_URL}/chat/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: args.query, user_id: MEMOS_USER_ID }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!resp.ok) {
        return { content: [{ type: 'text' as const, text: `Memory chat failed (${resp.status})` }] };
      }

      const json = await resp.json();
      return { content: [{ type: 'text' as const, text: json.data?.response || 'No response.' }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Memory chat error: ${err}` }] };
    }
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
