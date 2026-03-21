import fs from 'fs';
import path from 'path';
/**
 * Tools MCP Server for NanoClaw (host-side).
 * Provides memory, knowledge base, web crawler, and skills tools.
 * Runs as a stdio subprocess spawned by the Agent SDK.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ENGRAM_URL = process.env.ENGRAM_URL || 'http://localhost:9302';
const KB_URL = process.env.KB_URL || 'http://localhost:9305';
const API_KEY = process.env.SERVICES_API_KEY || '';
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const SKILLS_DIR = process.env.NANOCLAW_SKILLS_DIR || '';
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || '';

// Derive default agent_id from group folder (strip channel prefix)
const DEFAULT_AGENT_ID =
  GROUP_FOLDER.replace(/^(discord|telegram|wechat)_/, '').replace(/_/g, '-') ||
  'main';

// Agent IDs are free-form strings.

const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};

const MAX_CONSECUTIVE_ERRORS = 6;
let consecutiveErrors = 0;

function trackSuccess(): void {
  consecutiveErrors = 0;
}
function trackError(): void {
  consecutiveErrors++;
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    process.stderr.write(
      `[MCP] MCP tools unhealthy: ${consecutiveErrors} consecutive failures — exiting for respawn\n`,
    );
    process.exit(1);
  }
}

async function post(
  baseUrl: string,
  urlPath: string,
  body: object,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  trackSuccess();
  return res.json();
}

async function get(baseUrl: string, urlPath: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const server = new McpServer({ name: 'tools', version: '1.0.0' });

// ─── Engram Memory Tools ────────────────────────────────────────────

server.tool(
  'memory_search',
  'Search conversational memory for facts, preferences, and past interactions. Use this to recall what you know about users, projects, or previous conversations.',
  {
    query: z.string().describe('Search query (semantic search)'),
    agent_id: z
      .string()
      .optional()
      .describe(`Agent memory namespace. Default: "${DEFAULT_AGENT_ID}"`),
    limit: z.number().optional().describe('Max results (default: 10)'),
  },
  async (args) => {
    try {
      const result = (await post(ENGRAM_URL, '/engram/search', {
        query: args.query,
        agent_id: args.agent_id || DEFAULT_AGENT_ID,
        limit: args.limit || 10,
      })) as {
        memories?: Array<{ memory?: string; text?: string; score?: number }>;
      };
      const memories = result.memories || [];
      if (!memories.length)
        return {
          content: [
            {
              type: 'text' as const,
              text: `No memories found for: ${args.query}`,
            },
          ],
        };
      const lines = [`Found ${memories.length} memories:\n`];
      for (let i = 0; i < memories.length; i++) {
        const m = memories[i];
        const text = m.memory || m.text || JSON.stringify(m);
        const score =
          typeof m.score === 'number' ? ` (score: ${m.score.toFixed(3)})` : '';
        lines.push(`${i + 1}. ${text}${score}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'memory_store',
  'Store a conversation into memory. The system auto-extracts facts from the messages provided.',
  {
    messages: z
      .array(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string() }),
      )
      .describe('Conversation messages to extract facts from'),
    agent_id: z
      .string()
      .optional()
      .describe(`Agent memory namespace. Default: "${DEFAULT_AGENT_ID}"`),
    tier: z
      .enum(['global', 'daily'])
      .optional()
      .describe(
        'Memory tier: global (90-day) or daily (7-day). Default: global',
      ),
  },
  async (args) => {
    try {
      const truncated = args.messages.map((m) => ({
        role: m.role,
        content: m.content.slice(0, 2000),
      }));
      const result = (await post(ENGRAM_URL, '/engram/store', {
        messages: truncated,
        agent_id: args.agent_id || DEFAULT_AGENT_ID,
        tier: args.tier || 'global',
      })) as { stored?: number; facts?: string[] };
      const facts = result.facts || [];
      return {
        content: [
          {
            type: 'text' as const,
            text: facts.length
              ? `Stored ${facts.length} facts:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
              : `Memory stored (${result.stored || 0} facts extracted).`,
          },
        ],
      };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory store error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'memory_graph_search',
  'Search the entity relationship graph in memory.',
  {
    query: z.string().describe('Entity or relationship to search for'),
    agent_id: z
      .string()
      .optional()
      .describe(`Agent memory namespace. Default: "${DEFAULT_AGENT_ID}"`),
  },
  async (args) => {
    try {
      const result = (await post(ENGRAM_URL, '/engram/graph/search', {
        query: args.query,
        agent_id: args.agent_id || DEFAULT_AGENT_ID,
      })) as {
        relations?: Array<{
          source: string;
          relation: string;
          destination: string;
        }>;
      };
      const relations = result.relations || [];
      if (!relations.length)
        return {
          content: [
            {
              type: 'text' as const,
              text: `No graph results for: ${args.query}`,
            },
          ],
        };
      const lines = [`Found ${relations.length} relationships:\n`];
      for (const r of relations)
        lines.push(`  ${r.source} —[${r.relation}]→ ${r.destination}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Graph search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// ─── Knowledge Base Tools ───────────────────────────────────────────

server.tool(
  'kb_search',
  'Search the knowledge base for documents, manuals, and reference material.',
  {
    query: z.string().describe('Search query (semantic search)'),
    agent: z.string().optional().describe('Filter by agent'),
    primary: z.string().optional().describe('Primary category filter'),
    secondary: z.string().optional().describe('Secondary category filter'),
    top_k: z.number().optional().describe('Max results (default: 5, max: 20)'),
  },
  async (args) => {
    try {
      const result = (await post(KB_URL, '/search', {
        query: args.query,
        agent: args.agent || DEFAULT_AGENT_ID,
        primary: args.primary,
        secondary: args.secondary,
        top_k: Math.min(args.top_k || 5, 20),
      })) as {
        ok?: boolean;
        results?: Array<{
          score: number;
          agent: string;
          source: string;
          title: string;
          primary?: string;
          secondary?: string;
          text: string;
        }>;
      };
      if (!result.ok) throw new Error('KB search failed');
      const results = result.results || [];
      if (!results.length)
        return {
          content: [
            { type: 'text' as const, text: `No KB results for: ${args.query}` },
          ],
        };
      const lines = [`Found ${results.length} results for: "${args.query}"\n`];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        lines.push(`--- Result ${i + 1} (score: ${r.score}) ---`);
        let src = `${r.agent}/${r.source} > ${r.title}`;
        if (r.primary) src += `  [${r.primary}]`;
        if (r.secondary) src += `  (${r.secondary})`;
        lines.push(`Source: ${src}`);
        lines.push(r.text);
        lines.push('');
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `KB search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'kb_list',
  'List all documents in the knowledge base.',
  {
    agent: z.string().optional().describe('Filter by agent name.'),
  },
  async (args) => {
    try {
      const result = (await post(KB_URL, '/list', { agent: args.agent })) as {
        ok?: boolean;
        documents?: Array<{
          agent: string;
          name: string;
          primary?: string;
          secondary?: string;
          chunks: number;
          total_chars: number;
        }>;
      };
      if (!result.ok) throw new Error('KB list failed');
      const docs = result.documents || [];
      if (!docs.length)
        return {
          content: [
            { type: 'text' as const, text: 'No documents in knowledge base.' },
          ],
        };
      const lines = [`Knowledge Base: ${docs.length} documents\n`];
      for (const d of docs) {
        let meta = '';
        if (d.primary) {
          meta = `  [${d.primary}]`;
          if (d.secondary) meta += ` (${d.secondary})`;
        }
        lines.push(
          `  ${d.agent}/${d.name}${meta}  (${d.chunks} chunks, ${d.total_chars} chars)`,
        );
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `KB list error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'kb_get_document',
  'Retrieve the full content of a knowledge base document by filename.',
  {
    name: z.string().describe('Document filename'),
    agent: z.string().optional().describe('Agent scope'),
  },
  async (args) => {
    try {
      const result = (await post(KB_URL, '/get_document', {
        name: args.name,
        agent: args.agent,
      })) as { ok?: boolean; content?: string; error?: string };
      if (!result.ok) throw new Error(result.error || 'Document not found');
      return {
        content: [
          { type: 'text' as const, text: result.content || '(empty document)' },
        ],
      };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `KB get error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// ─── Web Crawler Tool ───────────────────────────────────────────────

server.tool(
  'crawl_page',
  'Fetch a web page and extract its text content.',
  {
    url: z.string().describe('URL to fetch'),
  },
  async (args) => {
    try {
      const res = await fetch(args.url, {
        headers: { 'User-Agent': 'NanoClaw/1.0 (Bot)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const html = await res.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50000);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Content from ${args.url} (${text.length} chars):\n\n${text}`,
          },
        ],
      };
    } catch (err) {
      trackError();
      return {
        content: [
          {
            type: 'text' as const,
            text: `Crawl error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// ─── Skill System ───────────────────────────────────────────────────

function getSkillSearchPaths(): string[] {
  const paths: string[] = [];
  if (GROUP_DIR) {
    paths.push(path.join(GROUP_DIR, 'skills'));
    paths.push(path.join(GROUP_DIR, 'procedures'));
  }
  if (SKILLS_DIR) {
    paths.push(path.join(SKILLS_DIR, 'core'));
    paths.push(path.join(SKILLS_DIR, 'custom'));

  }
  return paths;
}

server.tool(
  'get_skill',
  'Load an operational procedure/skill by name.',
  {
    name: z.string().describe('Skill name'),
  },
  async (args) => {
    for (const dir of getSkillSearchPaths()) {
      try {
        for (const ext of ['', '.md', '.txt']) {
          const fp = `${dir}/${args.name}${ext}`;
          if (fs.existsSync(fp) && fs.statSync(fp).isFile())
            return {
              content: [
                { type: 'text' as const, text: fs.readFileSync(fp, 'utf-8') },
              ],
            };
        }
        const sd = `${dir}/${args.name}`;
        if (fs.existsSync(sd) && fs.statSync(sd).isDirectory()) {
          const sf = `${sd}/SKILL.md`;
          if (fs.existsSync(sf))
            return {
              content: [
                { type: 'text' as const, text: fs.readFileSync(sf, 'utf-8') },
              ],
            };
        }
      } catch {
        /* skip */
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Skill "${args.name}" not found. Use list_skills.`,
        },
      ],
    };
  },
);

server.tool(
  'list_skills',
  'List all available skills and operational procedures.',
  {},
  async () => {
    const skills: string[] = [];
    for (const dir of getSkillSearchPaths()) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const e of fs.readdirSync(dir)) {
          const fp = `${dir}/${e}`;
          const st = fs.statSync(fp);
          if (st.isFile() && (e.endsWith('.md') || e.endsWith('.txt')))
            skills.push(`${e} (${dir})`);
          else if (st.isDirectory() && fs.existsSync(`${fp}/SKILL.md`))
            skills.push(`${e}/ (${dir})`);
        }
      } catch {
        /* skip */
      }
    }
    if (!skills.length)
      return { content: [{ type: 'text' as const, text: 'No skills found.' }] };
    return {
      content: [
        {
          type: 'text' as const,
          text: `Available skills:\n${skills.map((s) => `  - ${s}`).join('\n')}`,
        },
      ],
    };
  },
);

// ─── Startup Health Check ───────────────────────────────────────────

async function waitForServices(
  maxRetries = 10,
  intervalMs = 2000,
): Promise<void> {
  const services = [
    { name: 'Engram', url: `${ENGRAM_URL}/health` },
    { name: 'KB', url: `${KB_URL}/health` },
  ];
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const results = await Promise.allSettled(
      services.map(async (svc) => {
        const res = await fetch(svc.url, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return svc.name;
      }),
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? services[i].name : null))
      .filter(Boolean);
    if (failed.length === 0) {
      process.stderr.write(
        `[MCP] All services reachable (attempt ${attempt})\n`,
      );
      return;
    }
    process.stderr.write(
      `[MCP] Waiting for services (attempt ${attempt}/${maxRetries}): ${failed.join(', ')} unreachable\n`,
    );
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  process.stderr.write(
    `[MCP] WARNING: Services still unreachable after ${maxRetries} attempts — starting anyway\n`,
  );
}

// ─── Start Server ───────────────────────────────────────────────────

async function main() {
  await waitForServices();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Tools MCP server error: ${err}\n`);
  process.exit(1);
});
