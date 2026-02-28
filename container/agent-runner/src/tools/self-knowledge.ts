import { z } from 'zod';
import fs from 'fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';

interface SelfKnowledgeSection {
  title: string;
  summary: string;
  items: Array<{ name: string; description: string }>;
}

interface SelfKnowledgeDoc {
  version: number;
  agent_name: string;
  summary: string;
  sections: Record<string, SelfKnowledgeSection>;
}

function loadCapabilities(): SelfKnowledgeDoc | null {
  const capPath = '/workspace/group/knowledge/capabilities.json';
  try {
    if (!fs.existsSync(capPath)) return null;
    const raw = JSON.parse(fs.readFileSync(capPath, 'utf-8'));
    if (!raw.summary || !raw.sections) return null;
    return {
      version: raw.version || 1,
      agent_name: raw.agent_name || 'Agent',
      summary: raw.summary,
      sections: raw.sections,
    };
  } catch {
    return null;
  }
}

function formatOverview(doc: SelfKnowledgeDoc): string {
  const lines: string[] = [];
  lines.push(`# ${doc.agent_name}`);
  lines.push('');
  lines.push(doc.summary);
  lines.push('');
  lines.push('## Available sections');
  lines.push('');
  for (const [key, section] of Object.entries(doc.sections)) {
    lines.push(`- **${key}** — ${section.summary}`);
  }
  lines.push('');
  lines.push('_Ask about a specific section for details (e.g. "tell me about your tools")._');
  return lines.join('\n');
}

function formatSection(section: SelfKnowledgeSection): string {
  const lines: string[] = [];
  lines.push(`# ${section.title}`);
  lines.push('');
  lines.push(section.summary);
  if (section.items && section.items.length > 0) {
    lines.push('');
    for (const item of section.items) {
      lines.push(`- **${item.name}** — ${item.description}`);
    }
  }
  return lines.join('\n');
}

function matchSection(doc: SelfKnowledgeDoc, query: string): string | null {
  const q = query.toLowerCase().trim();
  const keys = Object.keys(doc.sections);
  if (keys.includes(q)) return q;
  const keyMatch = keys.find(k => k.includes(q) || q.includes(k));
  if (keyMatch) return keyMatch;
  const titleMatch = keys.find(k =>
    doc.sections[k].title.toLowerCase().includes(q) ||
    q.includes(doc.sections[k].title.toLowerCase()),
  );
  if (titleMatch) return titleMatch;
  return null;
}

export function register(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'self_knowledge',
    `Explain your own capabilities. Use this when someone asks "what can you do?", "help", "about", or wants to know your tools, limits, or features.

With no section specified, returns a high-level overview. With a section name, returns detailed information about that area.

Available sections vary by agent but typically include: tools, scheduled_tasks, memory, delegation, limitations.`,
    {
      section: z.string().optional().describe('Section to show details for (e.g. "tools", "memory", "limitations"). Omit for overview.'),
    },
    async (args) => {
      const doc = loadCapabilities();
      if (!doc) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No capabilities file found. Create knowledge/capabilities.json in your workspace to enable self-knowledge.',
          }],
        };
      }

      if (!args.section) {
        return { content: [{ type: 'text' as const, text: formatOverview(doc) }] };
      }

      const matched = matchSection(doc, args.section);
      if (!matched) {
        const available = Object.keys(doc.sections).join(', ');
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown section "${args.section}". Available: ${available}`,
          }],
          isError: true,
        };
      }

      return { content: [{ type: 'text' as const, text: formatSection(doc.sections[matched]) }] };
    },
  );
}
