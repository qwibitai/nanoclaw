import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';

// ── BM25 Search (pure JS, zero deps) ────────────────────────────────

interface BM25Result {
  file: string;
  snippet: string;
  score: number;
}

function bm25Search(dirs: string[], query: string, maxResults: number): BM25Result[] {
  interface Doc { file: string; text: string; lineStart: number; }
  const docs: Doc[] = [];

  for (const dir of dirs) {
    const walk = (d: string) => {
      let entries: string[];
      try { entries = fs.readdirSync(d); } catch { return; }
      for (const entry of entries) {
        const full = path.join(d, entry);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { walk(full); continue; }
          if (!/\.(md|txt|json)$/i.test(entry)) continue;
          if (stat.size > 500_000) continue;
          const content = fs.readFileSync(full, 'utf-8');
          const relPath = full.replace('/workspace/group/', '');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 5) {
            const chunk = lines.slice(i, i + 10).join('\n').trim();
            if (chunk.length > 10) {
              docs.push({ file: relPath, text: chunk, lineStart: i + 1 });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    };
    walk(dir);
  }

  if (docs.length === 0) return [];

  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  const N = docs.length;
  const docFreq: Record<string, number> = {};
  const docTokens: string[][] = docs.map(d => {
    const tokens = tokenize(d.text);
    const seen = new Set(tokens);
    for (const t of seen) {
      docFreq[t] = (docFreq[t] || 0) + 1;
    }
    return tokens;
  });

  const k1 = 1.2;
  const b = 0.75;
  const avgDl = docTokens.reduce((s, t) => s + t.length, 0) / N;

  const scored: { idx: number; score: number }[] = [];
  for (let i = 0; i < N; i++) {
    const tokens = docTokens[i];
    const dl = tokens.length;
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

    let score = 0;
    for (const term of queryTerms) {
      const f = tf[term] || 0;
      if (f === 0) continue;
      const df = docFreq[term] || 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgDl))));
    }

    if (score > 0) scored.push({ idx: i, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const results: BM25Result[] = [];
  for (const { idx, score } of scored) {
    if (results.length >= maxResults) break;
    const doc = docs[idx];
    const key = `${doc.file}:${doc.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const lines = doc.text.split('\n');
    const matchingLines = lines.filter(line =>
      queryTerms.some(t => line.toLowerCase().includes(t))
    );
    const snippet = matchingLines.length > 0
      ? matchingLines.slice(0, 5).join('\n')
      : lines.slice(0, 3).join('\n');

    results.push({
      file: doc.file,
      snippet: snippet.slice(0, 500),
      score: Math.round(score * 100) / 100,
    });
  }

  return results;
}

// Future: if EMBEDDING_URL is set, also query embeddings and merge via RRF.
const EMBEDDING_URL = process.env.EMBEDDING_URL || '';

export function register(server: McpServer, _ctx: ToolContext): void {
  server.tool(
    'recall',
    `Search your workspace files (knowledge, daily notes, projects, areas, conversations) for past information. Use this when you need to remember something — a decision, a conversation detail, a person's name, a preference, or anything you might have written down before.

This searches the actual files on disk, not conversation history. Your nightly consolidation writes important things here, so this is your long-term memory.

Powered by BM25 relevance ranking — results are sorted by how well they match your query, not just whether they contain the words.

MODE:
- "layered" (default): Returns compact summaries — file path, category, score, and first meaningful line. Use recall_detail to fetch the full content of specific files. Saves context tokens.
- "full": Returns full matching snippets inline (legacy behavior). Use when you need everything at once.

Tips:
- Use specific keywords: "stripe", "brandon preference", "oauth"
- Search is case-insensitive and ranked by relevance
- In layered mode, scan summaries first, then call recall_detail for the files you actually need
- If you get no results, try different keywords or check daily/ for date-specific notes`,
    {
      query: z.string().describe('Search keywords (e.g. "stripe keys", "brandon", "revenue target"). Ranked by BM25 relevance.'),
      folder: z.enum(['all', 'knowledge', 'daily', 'projects', 'areas', 'conversations', 'resources']).default('all').describe('Narrow search to a specific folder, or "all" to search everywhere.'),
      max_results: z.number().default(20).describe('Maximum number of results to return.'),
      mode: z.enum(['layered', 'full']).default('layered').describe('layered=compact summaries (use recall_detail for full content), full=full snippets inline (legacy)'),
    },
    async (args) => {
      const baseDir = '/workspace/group';
      const searchDirs = args.folder === 'all'
        ? ['knowledge', 'daily', 'projects', 'areas', 'conversations', 'resources']
        : [args.folder];

      const existingDirs = searchDirs
        .map(d => path.join(baseDir, d))
        .filter(d => fs.existsSync(d));

      if (existingDirs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No workspace folders found. Your memory is empty — start writing to knowledge/ and daily/ files.' }] };
      }

      try {
        const results = bm25Search(existingDirs, args.query, args.max_results);

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No results for "${args.query}". Try different keywords, or check if you have written this down yet.` }] };
        }

        if (args.mode === 'full') {
          let output = `## Recall results for "${args.query}"\n\n`;
          for (const r of results) {
            output += `**${r.file}** (score: ${r.score})\n\`\`\`\n${r.snippet}\n\`\`\`\n\n`;
          }
          if (EMBEDDING_URL) {
            output += `\n_Semantic search: enabled (${EMBEDDING_URL})_`;
          }
          return { content: [{ type: 'text' as const, text: output }] };
        }

        // Layered mode — compact summaries
        const CATEGORY_PATTERNS: Array<[RegExp, string]> = [
          [/\bobservations?\b/i, 'observation'],
          [/\blearnings?\b/i, 'learning'],
          [/\bknowledge\b/i, 'knowledge'],
          [/\bdaily\b/i, 'daily'],
          [/\bprojects?\b/i, 'project'],
          [/\bconversations?\b/i, 'conversation'],
          [/\bmemory\b/i, 'memory'],
        ];

        const PRIORITY_PATTERNS: Array<[RegExp, string]> = [
          [/\u{1F534}\s*Critical/u, 'critical'],
          [/\u{1F7E1}\s*Useful/u, 'useful'],
          [/\u{1F7E2}\s*Noise/u, 'noise'],
        ];

        const SKIP_LINE_PATTERNS = [
          /^<!--.*-->$/,
          /^---$/,
          /^\s*$/,
          /^#\s*$/,
        ];

        function detectCategory(filePath: string): string {
          for (const [pattern, category] of CATEGORY_PATTERNS) {
            if (pattern.test(filePath)) return category;
          }
          return 'unknown';
        }

        function detectPriority(text: string): string | null {
          for (const [pattern, priority] of PRIORITY_PATTERNS) {
            if (pattern.test(text)) return priority;
          }
          return null;
        }

        function extractFirstLine(text: string, maxLength = 120): string {
          const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            if (SKIP_LINE_PATTERNS.some((p) => p.test(trimmed))) continue;
            if (trimmed.length <= maxLength) return trimmed;
            return trimmed.slice(0, maxLength - 3) + '...';
          }
          return '(empty)';
        }

        let output = `## Recall: "${args.query}" (${results.length} results, layered mode)\n`;
        output += `_Use recall_detail with a file path to see full content._\n\n`;

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const category = detectCategory(r.file);
          const priority = detectPriority(r.snippet);
          const firstLine = extractFirstLine(r.snippet);

          const tags: string[] = [];
          if (category !== 'unknown') tags.push(category);
          if (priority) tags.push(priority);
          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

          output += `${i + 1}. **${r.file}** (${r.score})${tagStr}\n`;
          output += `   ${firstLine}\n`;
        }

        if (EMBEDDING_URL) {
          output += `\n_Semantic search: enabled (${EMBEDDING_URL})_`;
        }

        return { content: [{ type: 'text' as const, text: output }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Recall error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'recall_detail',
    `Fetch the full content of a specific workspace file. Use this after recall (layered mode) to read files that look relevant from the summaries.

Returns the complete file content. If the file is large, it returns the first 10,000 characters with a truncation notice.`,
    {
      file: z.string().describe('Relative file path from recall results (e.g. "knowledge/patterns.md", "daily/2026-02-28.md")'),
    },
    async (args) => {
      const filePath = path.join('/workspace/group', args.file);

      if (args.file.includes('..') || !filePath.startsWith('/workspace/group/')) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid file path. Must be within your workspace.' }],
          isError: true,
        };
      }

      try {
        if (!fs.existsSync(filePath)) {
          return {
            content: [{ type: 'text' as const, text: `File not found: ${args.file}` }],
            isError: true,
          };
        }

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `"${args.file}" is a directory, not a file. Use recall to search within it.` }],
            isError: true,
          };
        }

        const MAX_CHARS = 10_000;
        const content = fs.readFileSync(filePath, 'utf-8');

        if (content.length <= MAX_CHARS) {
          return {
            content: [{ type: 'text' as const, text: `## ${args.file}\n\n\`\`\`\n${content}\n\`\`\`` }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `## ${args.file} (truncated — ${content.length} chars, showing first ${MAX_CHARS})\n\n\`\`\`\n${content.slice(0, MAX_CHARS)}\n\`\`\`\n\n_File truncated. Use recall with specific keywords to find the section you need._`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error reading file: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'remember',
    `Write something important to your long-term memory. Use this to save information you will need later — decisions, lessons learned, contact details, preferences, or anything that should survive session compaction.

This writes directly to your workspace knowledge files. Information stored here persists across all sessions and is searchable with the recall tool.

Choose the right file:
- knowledge/patterns.md — lessons from mistakes, things that work
- knowledge/preferences.md — Brandon's preferences, how he works
- knowledge/contacts.md — people, accounts, relationships
- knowledge/security.md — security rules, trusted channels
- daily/YYYY-MM-DD.md — today's events and decisions
- projects/<name>.md — project-specific notes`,
    {
      file: z.string().describe('Relative path within your workspace (e.g. "knowledge/patterns.md", "daily/2026-02-27.md", "projects/revenue.md")'),
      content: z.string().describe('The text to append to the file. Will be added at the end with a newline separator.'),
      mode: z.enum(['append', 'overwrite']).default('append').describe('append=add to end of file (default, safe), overwrite=replace entire file (use carefully)'),
    },
    async (args) => {
      const filePath = path.join('/workspace/group', args.file);

      if (args.file.includes('..') || !filePath.startsWith('/workspace/group/')) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid file path. Must be within your workspace.' }],
          isError: true,
        };
      }

      const PROTECTED_FILES = ['tool-guard.json', 'CLAUDE.md'];
      if (PROTECTED_FILES.includes(path.basename(args.file))) {
        return {
          content: [{ type: 'text' as const, text: `Cannot write to protected config file: ${path.basename(args.file)}` }],
          isError: true,
        };
      }

      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        if (args.mode === 'overwrite') {
          fs.writeFileSync(filePath, args.content + '\n');
        } else {
          const separator = fs.existsSync(filePath) ? '\n\n' : '';
          fs.appendFileSync(filePath, separator + args.content + '\n');
        }

        return { content: [{ type: 'text' as const, text: `Saved to ${args.file} (${args.mode}).` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error writing: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Identity tools (agent can read/modify its own CLAUDE.md) ---

  const CLAUDE_MD_PATH = '/workspace/group/CLAUDE.md';

  const IMMUTABLE_SECTIONS = [
    'Admin Context',
    'Container Mounts',
    'Managing Groups',
    'Global Memory',
  ];

  const IDENTITY_LOG_PATH = '/workspace/group/logs/identity-changes.log';

  function logIdentityChange(action: string, section: string, reason: string): void {
    const entry = `[${new Date().toISOString()}] ${action} section="${section}" reason="${reason}"\n`;
    fs.mkdirSync(path.dirname(IDENTITY_LOG_PATH), { recursive: true });
    fs.appendFileSync(IDENTITY_LOG_PATH, entry);
  }

  server.tool(
    'update_identity',
    `Modify your own CLAUDE.md instructions. Use this to evolve your behavior based on user feedback or your own learnings.

IMPORTANT GUARDRAILS:
• Cannot modify immutable sections: ${IMMUTABLE_SECTIONS.join(', ')}
• Every change is logged with a reason for audit

Actions:
• "append_section" — Add a new section at the end
• "replace_section" — Replace an existing section's content (by heading)
• "remove_section" — Remove a section entirely (cannot remove immutable sections)`,
    {
      action: z.enum(['append_section', 'replace_section', 'remove_section']).describe('What to do'),
      section: z.string().describe('Section heading (e.g. "Communication Style", "Daily Routine"). For append_section, this becomes the new heading.'),
      content: z.string().optional().describe('New content for the section (required for append/replace, ignored for remove)'),
      reason: z.string().describe('Why you are making this change — logged for audit trail'),
    },
    async (args) => {
      // Check for immutable sections
      if (IMMUTABLE_SECTIONS.some(s => s.toLowerCase() === args.section.toLowerCase())) {
        return {
          content: [{ type: 'text' as const, text: `Cannot modify immutable section "${args.section}". Protected sections: ${IMMUTABLE_SECTIONS.join(', ')}` }],
          isError: true,
        };
      }

      // Block immutable heading injection inside content body
      if (args.content) {
        for (const heading of IMMUTABLE_SECTIONS) {
          const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im');
          if (pattern.test(args.content)) {
            return {
              content: [{ type: 'text' as const, text: `Blocked: content contains immutable heading "## ${heading}".` }],
              isError: true,
            };
          }
        }
      }

      try {
        let existing = '';
        if (fs.existsSync(CLAUDE_MD_PATH)) {
          existing = fs.readFileSync(CLAUDE_MD_PATH, 'utf-8');
        }

        // Split into sections by ## headings
        const sectionRegex = /^## .+$/gm;
        const sectionHeadings: { heading: string; start: number; end: number }[] = [];
        let match;
        while ((match = sectionRegex.exec(existing)) !== null) {
          if (sectionHeadings.length > 0) {
            sectionHeadings[sectionHeadings.length - 1].end = match.index;
          }
          sectionHeadings.push({
            heading: match[0].replace(/^## /, '').trim(),
            start: match.index,
            end: existing.length,
          });
        }

        if (args.action === 'append_section') {
          if (!args.content) {
            return { content: [{ type: 'text' as const, text: 'Content is required for append_section.' }], isError: true };
          }
          const newSection = `\n\n## ${args.section}\n\n${args.content}\n`;
          fs.writeFileSync(CLAUDE_MD_PATH, existing + newSection);
          logIdentityChange('append_section', args.section, args.reason);
          return { content: [{ type: 'text' as const, text: `Added new section "## ${args.section}" to CLAUDE.md.` }] };
        }

        const targetSection = sectionHeadings.find(
          s => s.heading.toLowerCase() === args.section.toLowerCase()
        );

        if (args.action === 'replace_section') {
          if (!args.content) {
            return { content: [{ type: 'text' as const, text: 'Content is required for replace_section.' }], isError: true };
          }
          if (!targetSection) {
            return { content: [{ type: 'text' as const, text: `Section "## ${args.section}" not found. Use append_section to add a new one.` }], isError: true };
          }
          const before = existing.slice(0, targetSection.start);
          const after = existing.slice(targetSection.end);
          const replacement = `## ${args.section}\n\n${args.content}\n`;
          fs.writeFileSync(CLAUDE_MD_PATH, before + replacement + after);
          logIdentityChange('replace_section', args.section, args.reason);
          return { content: [{ type: 'text' as const, text: `Replaced section "## ${args.section}" in CLAUDE.md.` }] };
        }

        if (args.action === 'remove_section') {
          if (!targetSection) {
            return { content: [{ type: 'text' as const, text: `Section "## ${args.section}" not found.` }], isError: true };
          }
          const before = existing.slice(0, targetSection.start);
          const after = existing.slice(targetSection.end);
          fs.writeFileSync(CLAUDE_MD_PATH, (before + after).replace(/\n{3,}/g, '\n\n'));
          logIdentityChange('remove_section', args.section, args.reason);
          return { content: [{ type: 'text' as const, text: `Removed section "## ${args.section}" from CLAUDE.md.` }] };
        }

        // Unreachable — Zod enum validates action
        throw new Error(`Unexpected action: ${args.action}`);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error updating CLAUDE.md: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- Self-Improving Memory tools (v2.5) ---

  server.tool(
    'review_proposed_updates',
    `Review proposed additions to your CLAUDE.md instructions.

The memory-improver analyzes your LEARNINGS.md and proposes new lines to add to CLAUDE.md. These proposals are staged in learnings/PROPOSED_UPDATES.md and never auto-applied.

Use this tool to read the proposals before deciding which to apply.`,
    {},
    async () => {
      const proposalsPath = path.join('/workspace/group', 'learnings', 'PROPOSED_UPDATES.md');

      if (!fs.existsSync(proposalsPath)) {
        return {
          content: [{ type: 'text' as const, text: 'No proposed updates found. The memory-improver has not generated any proposals yet.' }],
        };
      }

      try {
        const content = fs.readFileSync(proposalsPath, 'utf-8');
        if (!content.trim()) {
          return {
            content: [{ type: 'text' as const, text: 'PROPOSED_UPDATES.md exists but is empty.' }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: content }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error reading proposals: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'apply_memory_update',
    `Apply a proposed update to your CLAUDE.md instructions.

After reviewing proposals with review_proposed_updates, use this to approve and apply a specific proposal. The content is APPENDED to your CLAUDE.md (never overwrites). The applied proposal is then removed from PROPOSED_UPDATES.md.

Provide the proposal number (1-based) from the PROPOSED_UPDATES.md file.`,
    {
      proposal_number: z.number().int().positive().describe('The proposal number to apply (1-based, from review_proposed_updates output)'),
    },
    async (args) => {
      const proposalsPath = path.join('/workspace/group', 'learnings', 'PROPOSED_UPDATES.md');
      const claudePath = path.join('/workspace/group', 'CLAUDE.md');

      if (!fs.existsSync(proposalsPath)) {
        return {
          content: [{ type: 'text' as const, text: 'No proposed updates found.' }],
          isError: true,
        };
      }

      try {
        const content = fs.readFileSync(proposalsPath, 'utf-8');

        // Parse proposals — each starts with "## Proposal N"
        const proposalBlocks = content.split(/(?=## Proposal \d+)/);
        const proposals = proposalBlocks.filter((b) => b.startsWith('## Proposal'));

        if (args.proposal_number < 1 || args.proposal_number > proposals.length) {
          return {
            content: [{ type: 'text' as const, text: `Invalid proposal number ${args.proposal_number}. There are ${proposals.length} proposals.` }],
            isError: true,
          };
        }

        const proposal = proposals[args.proposal_number - 1];

        // Extract content between code fences
        const codeMatch = proposal.match(/```\n([\s\S]*?)\n```/);
        if (!codeMatch) {
          return {
            content: [{ type: 'text' as const, text: `Could not extract content from proposal ${args.proposal_number}.` }],
            isError: true,
          };
        }

        const newContent = codeMatch[1].trim();

        // Extract section header
        const sectionMatch = proposal.match(/\*\*Section:\*\*\s*(.+)/);
        const section = sectionMatch ? sectionMatch[1].trim() : '';

        // Append to CLAUDE.md
        const separator = fs.existsSync(claudePath) ? '\n\n' : '';
        const addendum = section
          ? `${separator}${section}\n${newContent}\n`
          : `${separator}${newContent}\n`;
        fs.appendFileSync(claudePath, addendum);

        // Remove the applied proposal from PROPOSED_UPDATES.md
        const remaining = proposals.filter((_, i) => i !== args.proposal_number - 1);
        if (remaining.length === 0) {
          fs.unlinkSync(proposalsPath);
        } else {
          // Re-number and rewrite
          const header = proposalBlocks.find((b) => !b.startsWith('## Proposal')) || '';
          const renumbered = remaining.map((block, i) =>
            block.replace(/## Proposal \d+/, `## Proposal ${i + 1}`),
          );
          fs.writeFileSync(proposalsPath, header + renumbered.join(''));
        }

        return {
          content: [{ type: 'text' as const, text: `Applied proposal ${args.proposal_number} to CLAUDE.md. ${remaining.length} proposals remaining.` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error applying proposal: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}
