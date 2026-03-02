import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';

const SKILLS_DIR = '/home/node/.claude/skills';

// Built-in skills that ship with the container image — agent can't overwrite these
const BUILTIN_SKILLS = new Set(['agent-browser']);

export function register(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'list_skills',
    'List all installed custom skills with their descriptions.',
    {},
    async () => {
      try {
        if (!fs.existsSync(SKILLS_DIR)) {
          return { content: [{ type: 'text' as const, text: 'No skills installed yet. Use create_skill to create one.' }] };
        }

        const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
        const skills: string[] = [];

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
          if (!fs.existsSync(skillFile)) continue;

          const content = fs.readFileSync(skillFile, 'utf-8');
          // Extract description from YAML frontmatter
          const descMatch = content.match(/^description:\s*(.+)$/m);
          const desc = descMatch ? descMatch[1].trim() : '(no description)';
          const isBuiltin = BUILTIN_SKILLS.has(entry.name);

          skills.push(`- **${entry.name}**${isBuiltin ? ' (built-in)' : ''}: ${desc}`);
        }

        if (skills.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No skills found. Use create_skill to create one.' }] };
        }

        return { content: [{ type: 'text' as const, text: `## Installed Skills\n\n${skills.join('\n')}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error listing skills: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'create_skill',
    `Create or update a custom skill. Skills are persistent instructions that are available in every session.

Use this to save reusable workflows, templates, or specialized instructions that you want available permanently.

The skill will be saved and available starting from the next session (each message spawns a new container).`,
    {
      name: z.string().regex(/^[a-z0-9-]+$/, 'Skill name must be lowercase alphanumeric with hyphens only (e.g. "data-fetcher", "weekly-report")').describe('Skill name (lowercase, hyphens allowed)'),
      description: z.string().max(200).describe('Short description of what the skill does (shown in list_skills)'),
      content: z.string().describe('The skill content — instructions, templates, workflows. Written as the body of a SKILL.md file.'),
      allowed_tools: z.array(z.string()).optional().describe('Optional list of tool names this skill is allowed to use (e.g. ["Bash", "Read", "Write"]). Omit for no restrictions.'),
    },
    async (args) => {
      if (BUILTIN_SKILLS.has(args.name)) {
        return {
          content: [{ type: 'text' as const, text: `Cannot overwrite built-in skill "${args.name}". Choose a different name.` }],
          isError: true,
        };
      }

      try {
        const skillDir = path.join(SKILLS_DIR, args.name);
        fs.mkdirSync(skillDir, { recursive: true });

        // Build YAML frontmatter
        let frontmatter = `---\nname: ${args.name}\ndescription: ${args.description}\n`;
        if (args.allowed_tools && args.allowed_tools.length > 0) {
          frontmatter += `allowed_tools:\n${args.allowed_tools.map(t => `  - ${t}`).join('\n')}\n`;
        }
        frontmatter += '---\n\n';

        const skillContent = frontmatter + args.content;
        const skillFile = path.join(skillDir, 'SKILL.md');

        const isUpdate = fs.existsSync(skillFile);
        fs.writeFileSync(skillFile, skillContent);

        return {
          content: [{ type: 'text' as const, text: `Skill "${args.name}" ${isUpdate ? 'updated' : 'created'} at ${skillFile}. It will be available in your next session.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error creating skill: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
