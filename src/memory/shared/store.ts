// src/memory/shared/store.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  memoryRoot,
  factPath,
  indexPath,
  archivedDir,
  ensureMemoryDirs,
} from './paths.js';
import type { Fact, FactFrontmatter, FactType } from './types.js';

const FRONTMATTER_DELIM = '---';
const INDEX_PREAMBLE = `# Shared user memory

These facts were learned across all groups. Each fact has metadata:
- \`count\` — times reinforced (higher = more reliable)
- \`last_seen\` — recency
- \`last_value\` — current value if it shifts (e.g. preference changed)
- \`scopes\` — when this applies (empty = always)

Apply the highest-count value by default; override with newer/scoped values when context matches. If two facts conflict and counts are close, surface the tension to the user rather than guessing.

---
`;

export function writeFact(fact: Fact): void {
  ensureMemoryDirs();
  const front = yaml.dump(fact.frontmatter, { lineWidth: 120 }).trimEnd();
  const content = `${FRONTMATTER_DELIM}\n${front}\n${FRONTMATTER_DELIM}\n\n${fact.body.trim()}\n`;
  fs.writeFileSync(factPath(fact.slug), content);
}

export function readFact(slug: string): Fact | null {
  const p = factPath(slug);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  return {
    slug,
    frontmatter: parsed.frontmatter as unknown as FactFrontmatter,
    body: parsed.body,
  };
}

export function listFacts(filter?: { type?: FactType }): Fact[] {
  ensureMemoryDirs();
  const root = memoryRoot();
  const out: Fact[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (!entry.endsWith('.md') || entry === 'MEMORY.md') continue;
    if (entry.startsWith('.')) continue;
    const slug = entry.replace(/\.md$/, '');
    const fact = readFact(slug);
    if (!fact) continue;
    if (filter?.type && fact.frontmatter.type !== filter.type) continue;
    out.push(fact);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function regenerateIndex(): void {
  ensureMemoryDirs();
  const facts = listFacts();
  const lines = facts.map((f) => {
    const sourcesSummary = summarizeSources(f.frontmatter.sources);
    const hook = `${f.frontmatter.count} reinforcement${
      f.frontmatter.count === 1 ? '' : 's'
    }${sourcesSummary ? ` across ${sourcesSummary}` : ''}`;
    return `- [${f.frontmatter.name}](${f.slug}.md) — ${hook}`;
  });
  const content = INDEX_PREAMBLE + '\n' + lines.join('\n') + '\n';
  fs.writeFileSync(indexPath(), content);
}

export function archiveFact(slug: string): boolean {
  const src = factPath(slug);
  if (!fs.existsSync(src)) return false;
  ensureMemoryDirs();
  const dest = path.join(archivedDir(), `${slug}-${Date.now()}.md`);
  fs.renameSync(src, dest);
  regenerateIndex();
  return true;
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null {
  if (!raw.startsWith(FRONTMATTER_DELIM)) return null;
  const end = raw.indexOf(`\n${FRONTMATTER_DELIM}`, FRONTMATTER_DELIM.length);
  if (end < 0) return null;
  const front = raw.slice(FRONTMATTER_DELIM.length, end).trim();
  const body = raw.slice(end + FRONTMATTER_DELIM.length + 1).trim();
  try {
    const fm = yaml.load(front) as Record<string, unknown>;
    if (!fm || typeof fm !== 'object') return null;
    return { frontmatter: fm, body };
  } catch {
    return null;
  }
}

function summarizeSources(sources: Record<string, number>): string {
  const groups = Object.keys(sources).sort();
  if (groups.length === 0) return '';
  if (groups.length <= 2) return groups.join(' + ');
  return `${groups.slice(0, 2).join(' + ')} +${groups.length - 2}`;
}
