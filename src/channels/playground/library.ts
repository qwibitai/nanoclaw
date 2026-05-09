/**
 * Anthropic skills library browser.
 *
 * Ported from origin/main:src/playground/library.ts. Adapted for v2's
 * `log` import and DATA_DIR path convention. Logic is otherwise verbatim.
 *
 * On first use, shallow-clones github.com/anthropics/skills into
 * `data/playground/library-cache/`. Subsequent calls re-use the cache
 * (and git-pull on explicit refresh). Compatibility check parses each
 * SKILL.md frontmatter for tool references not available in NanoClaw
 * containers.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

const LIBRARY_REPO = 'https://github.com/anthropics/skills.git';
const LIBRARY_CACHE_DIR = path.join(DATA_DIR, 'playground', 'library-cache');

// Tools available inside NanoClaw containers — kept loose; the runner allows
// most things. Used purely for the compatibility badge.
const NANOCLAW_TOOLS = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'websearch',
  'webfetch',
  'task',
  'taskoutput',
  'taskstop',
  'teamcreate',
  'teamdelete',
  'sendmessage',
  'todowrite',
  'toolsearch',
  'skill',
  'notebookedit',
]);

const KNOWN_INCOMPATIBLE = new Set(['artifacts', 'computer_use', 'computer', 'str_replace_editor']);

export interface LibraryEntry {
  category: string;
  name: string;
  description: string;
  compatibility: 'compatible' | 'partial' | 'incompatible';
}

export interface LibraryPreview extends LibraryEntry {
  content: string;
  missing: string[];
  incompatible: string[];
}

function ensureClone(refresh = false): void {
  fs.mkdirSync(path.dirname(LIBRARY_CACHE_DIR), { recursive: true });
  const gitDir = path.join(LIBRARY_CACHE_DIR, '.git');
  if (fs.existsSync(gitDir)) {
    if (refresh) {
      const res = spawnSync('git', ['-C', LIBRARY_CACHE_DIR, 'pull', '--ff-only'], { encoding: 'utf-8' });
      if (res.status !== 0) log.warn('Library refresh failed (continuing with cache)', { stderr: res.stderr });
    }
    return;
  }
  const res = spawnSync('git', ['clone', '--depth', '1', LIBRARY_REPO, LIBRARY_CACHE_DIR], { encoding: 'utf-8' });
  if (res.status !== 0) throw new Error(`Library clone failed: ${res.stderr}`);
}

function parseFrontmatter(md: string): Record<string, string> {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const out: Record<string, string> = {};
  for (const line of fm[1]!.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function classifyTools(md: string): {
  compatibility: 'compatible' | 'partial' | 'incompatible';
  missing: string[];
  incompatible: string[];
} {
  const fm = parseFrontmatter(md);
  const allowedRaw = fm['allowed-tools'] || '';
  const tools = allowedRaw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  const missing: string[] = [];
  const incompatible: string[] = [];
  for (const t of tools) {
    if (KNOWN_INCOMPATIBLE.has(t)) incompatible.push(t);
    else if (!NANOCLAW_TOOLS.has(t)) missing.push(t);
  }
  if (incompatible.length > 0) return { compatibility: 'incompatible', missing, incompatible };
  if (missing.length > 0) return { compatibility: 'partial', missing, incompatible };
  return { compatibility: 'compatible', missing, incompatible };
}

export function listLibrary(refresh = false): LibraryEntry[] {
  try {
    ensureClone(refresh);
  } catch (err) {
    log.warn('Library clone unavailable', { err });
    return [];
  }
  const out: LibraryEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, subRel);
      } else if (entry.name === 'SKILL.md') {
        const parts = subRel.split('/');
        if (parts.length < 2) continue;
        const name = parts[parts.length - 2]!;
        const category = parts[0]!;
        const md = fs.readFileSync(full, 'utf-8');
        const fm = parseFrontmatter(md);
        const description = fm.description || '';
        const { compatibility } = classifyTools(md);
        out.push({ category, name, description, compatibility });
      }
    }
  };
  walk(LIBRARY_CACHE_DIR, '');
  return out.sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );
}

export function getLibraryCacheStat(): { exists: boolean; mtime: string | null } {
  if (!fs.existsSync(LIBRARY_CACHE_DIR)) return { exists: false, mtime: null };
  return { exists: true, mtime: fs.statSync(LIBRARY_CACHE_DIR).mtime.toISOString() };
}
