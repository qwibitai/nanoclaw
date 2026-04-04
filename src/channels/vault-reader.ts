/**
 * Reads the family vault (markdown files with YAML frontmatter and wikilinks)
 * and builds a graph structure for the dashboard vault view.
 *
 * Ported from vault-explorer/server.js to TypeScript.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, basename } from 'path';
import matter from 'gray-matter';

const DEFAULT_VAULT_PATH = '/Users/fambot/sigma-data/family-vault';

export interface VaultNode {
  id: string;
  label: string;
  domain: string;
  type: 'moc' | 'node';
  description: string;
  updated: string;
  updated_by: string;
  durability: string;
  content: string;
}

export interface VaultEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: VaultNode[];
  edges: VaultEdge[];
}

function getVaultPath(): string {
  return process.env.VAULT_PATH || DEFAULT_VAULT_PATH;
}

async function walkMarkdown(
  dir: string,
  base: string = dir,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('_')) {
      files.push(...(await walkMarkdown(full, base)));
    } else if (
      entry.name.endsWith('.md') &&
      entry.name !== 'CLAUDE.md' &&
      entry.name !== '_log.md'
    ) {
      files.push(full);
    }
  }
  return files;
}

function extractWikilinks(content: string): string[] {
  const re = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    links.push(m[1]);
  }
  return links;
}

function nodeIdFromPath(filePath: string, base: string): string {
  return relative(base, filePath).replace(/\.md$/, '');
}

function labelFromId(id: string): string {
  const name = basename(id);
  if (name === 'MOC') {
    const parent = id.split('/').slice(-2, -1)[0];
    return parent
      ? parent.charAt(0).toUpperCase() + parent.slice(1)
      : 'Map of Content';
  }
  return name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function domainFromId(id: string): string {
  if (!id.includes('/')) return 'root';
  return id.split('/')[0];
}

export async function readVaultGraph(): Promise<VaultGraph> {
  const vaultPath = getVaultPath();
  const files = await walkMarkdown(vaultPath);
  const nodes: VaultNode[] = [];
  const nodeIds = new Set<string>();

  for (const file of files) {
    const raw = await readFile(file, 'utf-8');
    const { data: fm, content } = matter(raw);
    const id = nodeIdFromPath(file, vaultPath);
    nodeIds.add(id);

    // Strip frontmatter + first H1 heading for display content
    const displayContent = content
      .replace(/^#\s+.+$/m, '')
      .trim()
      .slice(0, 1200);

    nodes.push({
      id,
      label: labelFromId(id),
      domain: domainFromId(id),
      type: basename(id) === 'MOC' ? 'moc' : 'node',
      description: fm.description || '',
      updated: fm.updated ? String(fm.updated).slice(0, 10) : 'unknown',
      updated_by: fm.updated_by || 'unknown',
      durability: fm.durability || 'unknown',
      content: displayContent,
    });
  }

  // Build edges from wikilinks, only where both nodes exist
  const edges: VaultEdge[] = [];
  const edgeSet = new Set<string>();

  // We need the raw links, so re-parse content for links
  for (const file of files) {
    const raw = await readFile(file, 'utf-8');
    const { content } = matter(raw);
    const id = nodeIdFromPath(file, vaultPath);
    const links = extractWikilinks(content);

    for (const target of links) {
      if (nodeIds.has(target)) {
        const key = [id, target].sort().join('\u2192');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: id, target });
        }
      }
    }
  }

  return { nodes, edges };
}
