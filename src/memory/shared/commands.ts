// src/memory/shared/commands.ts
import { listFacts, readFact, archiveFact } from './store.js';
import yaml from 'js-yaml';

export type MemoryCommand =
  | { action: 'list' }
  | { action: 'show'; slug: string }
  | { action: 'forget'; slug: string };

/** Parse `/memory ...` or `memory ...` into a MemoryCommand. Returns null if not a memory command. */
export function parseMemoryCommand(text: string): MemoryCommand | null {
  const t = text.trim().replace(/^\//, '');
  const parts = t.split(/\s+/);
  if (parts[0]?.toLowerCase() !== 'memory') return null;
  const action = parts[1]?.toLowerCase();
  if (action === 'list') return { action: 'list' };
  if (action === 'show' && parts[2]) return { action: 'show', slug: parts[2] };
  if (action === 'forget' && parts[2])
    return { action: 'forget', slug: parts[2] };
  return null;
}

export function handleMemoryCommand(cmd: MemoryCommand): string {
  switch (cmd.action) {
    case 'list': {
      const facts = listFacts();
      if (facts.length === 0) return '_No memory yet._';
      const lines = facts.map(
        (f) =>
          `• *${f.frontmatter.name}* (${f.slug}) — count ${f.frontmatter.count}, last seen ${f.frontmatter.last_seen}`,
      );
      return `*Shared memory* (${facts.length} fact${facts.length === 1 ? '' : 's'})\n${lines.join('\n')}`;
    }
    case 'show': {
      const f = readFact(cmd.slug);
      if (!f) return `_Fact not found: ${cmd.slug}_`;
      const front = yaml.dump(f.frontmatter, { lineWidth: 100 }).trimEnd();
      return `*${f.frontmatter.name}*\n\`\`\`\n${front}\n\`\`\`\n${f.body}`;
    }
    case 'forget': {
      const ok = archiveFact(cmd.slug);
      return ok ? `_Archived: ${cmd.slug}_` : `_Fact not found: ${cmd.slug}_`;
    }
  }
}
