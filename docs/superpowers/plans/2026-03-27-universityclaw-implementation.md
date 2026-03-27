# universityClaw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork NanoClaw and build a personal university teaching assistant with Obsidian-based knowledge management, document ingestion pipeline, RAG retrieval, and a web review dashboard.

**Architecture:** NanoClaw fork with three added subsystems: (1) an Obsidian vault utility for direct Markdown file I/O, (2) a document ingestion pipeline using Docling for extraction and Claude for note generation with a review queue, and (3) a Next.js web dashboard for uploads, review, and vault browsing. LightRAG provides hybrid vector + graph retrieval over the vault.

**Tech Stack:** TypeScript/Node.js 20+ (NanoClaw core), Next.js (dashboard), Python (Docling), SQLite (better-sqlite3), LightRAG, gray-matter, chokidar, Telegram (grammy)

**Spec:** `docs/superpowers/specs/2026-03-27-universityclaw-design.md`

---

## File Structure

### Existing NanoClaw files we modify

- `CLAUDE.md` — Add universityClaw-specific project context
- `package.json` — Add new dependencies (gray-matter, chokidar, lightrag client, etc.)
- `src/config.ts` — Add vault paths, upload folder, dashboard port config
- `src/db.ts` — Add tables for ingestion queue, review status, folder-type mappings
- `src/types.ts` — Add interfaces for vault notes, ingestion pipeline, review queue
- `src/index.ts` — Wire up file watcher and ingestion pipeline at startup
- `groups/main/CLAUDE.md` — Customize agent personality and capabilities for teaching assistant
- `groups/global/CLAUDE.md` — Add vault-aware context for non-main groups

### New files we create

**Vault Utility:**
- `src/vault/vault-utility.ts` — Core Obsidian vault read/write/search operations
- `src/vault/vault-utility.test.ts` — Tests
- `src/vault/frontmatter.ts` — YAML frontmatter parsing/serialization with gray-matter
- `src/vault/frontmatter.test.ts` — Tests
- `src/vault/wikilinks.ts` — Wikilink regex extraction and resolution
- `src/vault/wikilinks.test.ts` — Tests

**Path Parser:**
- `src/ingestion/path-parser.ts` — Extract metadata from folder structure
- `src/ingestion/path-parser.test.ts` — Tests
- `src/ingestion/type-mappings.ts` — Generalized folder-name-to-type config (learnable)
- `src/ingestion/type-mappings.test.ts` — Tests

**Document Ingestion Pipeline:**
- `src/ingestion/file-watcher.ts` — chokidar-based upload folder watcher
- `src/ingestion/file-watcher.test.ts` — Tests
- `src/ingestion/docling-client.ts` — Python subprocess wrapper for Docling
- `src/ingestion/docling-client.test.ts` — Tests
- `src/ingestion/note-generator.ts` — Claude-powered atomic note generation
- `src/ingestion/note-generator.test.ts` — Tests
- `src/ingestion/review-queue.ts` — Draft management, approve/reject/edit flow
- `src/ingestion/review-queue.test.ts` — Tests
- `src/ingestion/index.ts` — Pipeline orchestrator (watcher → docling → generator → queue)
- `src/ingestion/index.test.ts` — Integration tests
- `scripts/docling-extract.py` — Python script that runs Docling, outputs JSON

**RAG Layer:**
- `src/rag/rag-client.ts` — LightRAG query interface with metadata filtering
- `src/rag/rag-client.test.ts` — Tests
- `src/rag/indexer.ts` — Vault change watcher → incremental index updates
- `src/rag/indexer.test.ts` — Tests

**Student Profile:**
- `src/profile/student-profile.ts` — Read/write profile, study log, knowledge map
- `src/profile/student-profile.test.ts` — Tests

**Web Dashboard:**
- `dashboard/package.json` — Next.js app dependencies
- `dashboard/tsconfig.json`
- `dashboard/next.config.ts`
- `dashboard/src/app/layout.tsx` — Root layout
- `dashboard/src/app/page.tsx` — Home/status view
- `dashboard/src/app/upload/page.tsx` — Upload view
- `dashboard/src/app/review/page.tsx` — Review queue list
- `dashboard/src/app/review/[id]/page.tsx` — Single draft review with figure management
- `dashboard/src/app/vault/page.tsx` — Vault browser
- `dashboard/src/app/api/upload/route.ts` — File upload endpoint
- `dashboard/src/app/api/review/route.ts` — Review actions (approve/reject/edit)
- `dashboard/src/app/api/review/[id]/figures/route.ts` — Figure removal endpoint
- `dashboard/src/app/api/status/route.ts` — Pipeline status endpoint
- `dashboard/src/app/api/vault/route.ts` — Vault browsing endpoint
- `dashboard/src/lib/api-client.ts` — Shared fetch helpers

**Vault Template:**
- `vault/.gitkeep`
- `vault/profile/student-profile.md` — Initial profile template
- `vault/profile/study-log.md` — Empty log
- `vault/profile/knowledge-map.md` — Empty knowledge map
- `vault/drafts/.gitkeep`
- `vault/attachments/.gitkeep`
- `vault/courses/.gitkeep`
- `vault/resources/.gitkeep`

---

## Task 1: Fork NanoClaw and Set Up Project

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`
- Create: `vault/` directory structure
- Create: `.env.example` (update)

- [ ] **Step 1: Fork and clone NanoClaw**

```bash
gh repo fork qwibitai/nanoclaw --clone --remote \
  --fork-name universityClaw
cd universityClaw
```

- [ ] **Step 2: Verify the project builds and tests pass**

```bash
npm install
npm run build
npm test
```

Expected: Clean build, all existing tests pass.

- [ ] **Step 3: Create vault directory structure**

```bash
mkdir -p vault/{courses,resources/{books,articles,external},drafts,attachments,profile}
touch vault/.gitkeep vault/courses/.gitkeep vault/resources/.gitkeep
touch vault/drafts/.gitkeep vault/attachments/.gitkeep
```

- [ ] **Step 4: Create initial student profile templates**

Create `vault/profile/student-profile.md`:

```markdown
---
title: Student Profile
type: profile
program: Digital Transformation
status: active
language_preference: auto
created: 2026-03-27
---

## Program
Digital Transformation (Digital Forretningsutvikling)

## Active Courses
<!-- Updated automatically as courses are ingested -->

## Completed Courses
<!-- Updated automatically -->

## Preferences
- Language: auto (mirrors user input)
- Quiz difficulty: adaptive
```

Create `vault/profile/study-log.md`:

```markdown
---
title: Study Log
type: profile
created: 2026-03-27
---

<!-- Auto-appended after each study interaction -->
```

Create `vault/profile/knowledge-map.md`:

```markdown
---
title: Knowledge Map
type: profile
created: 2026-03-27
---

<!-- Topics with confidence levels, updated after quizzes and Q&A -->
```

- [ ] **Step 5: Update CLAUDE.md with universityClaw context**

Append to the existing `CLAUDE.md`:

```markdown

## universityClaw Extensions

This is a fork of NanoClaw customized as a personal university teaching assistant.

### Additional Subsystems
- **Vault Utility** (`src/vault/`) — Direct Obsidian vault file I/O (gray-matter + regex)
- **Ingestion Pipeline** (`src/ingestion/`) — File watcher → Docling → Claude note gen → review queue
- **RAG Layer** (`src/rag/`) — LightRAG hybrid retrieval over the vault
- **Student Profile** (`src/profile/`) — Learning progress tracking
- **Web Dashboard** (`dashboard/`) — Next.js app for upload, review, vault browsing

### Key Paths
- `vault/` — Obsidian vault (primary knowledge store)
- `upload/` — Watched folder for new documents
- `dashboard/` — Next.js web dashboard
- `scripts/docling-extract.py` — Python document extraction script

### Testing
- `npm test` — Run all tests (vitest)
- `cd dashboard && npm test` — Dashboard tests
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: initialize universityClaw fork with vault structure and profile templates"
```

---

## Task 2: Add Telegram Channel

**Files:**
- Uses NanoClaw's built-in `/add-telegram` skill which merges from `nanoclaw-telegram` repo

- [ ] **Step 1: Run the add-telegram skill**

```bash
claude "/add-telegram"
```

This skill will:
- Add the `nanoclaw-telegram` git remote
- Merge the telegram branch (adds `src/channels/telegram.ts`, grammy dependency)
- Prompt for bot token configuration
- Update `.env` with `TELEGRAM_BOT_TOKEN`

Follow the interactive prompts.

- [ ] **Step 2: Verify telegram channel builds**

```bash
npm run build
npm test
```

Expected: Build succeeds with telegram channel included, tests pass.

- [ ] **Step 3: Commit if not already committed by the skill**

```bash
git status
# If there are uncommitted changes:
git add -A
git commit -m "feat: add Telegram channel via nanoclaw-telegram"
```

---

## Task 3: Vault Utility — Frontmatter Module

**Files:**
- Create: `src/vault/frontmatter.ts`
- Create: `src/vault/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests for frontmatter parsing**

Create `src/vault/frontmatter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter, updateFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter and body from markdown', () => {
    const md = `---
title: Test Note
type: lecture
course: BI-2081
tags:
  - sustainability
---

# Test Note

Some content here.`;

    const result = parseFrontmatter(md);
    expect(result.data.title).toBe('Test Note');
    expect(result.data.type).toBe('lecture');
    expect(result.data.course).toBe('BI-2081');
    expect(result.data.tags).toEqual(['sustainability']);
    expect(result.content).toContain('# Test Note');
    expect(result.content).toContain('Some content here.');
  });

  it('returns empty data for markdown without frontmatter', () => {
    const md = '# Just a heading\n\nSome text.';
    const result = parseFrontmatter(md);
    expect(result.data).toEqual({});
    expect(result.content).toContain('# Just a heading');
  });
});

describe('serializeFrontmatter', () => {
  it('combines data and content into markdown with frontmatter', () => {
    const data = { title: 'Test', type: 'lecture', course: 'BI-2081' };
    const content = '# Test\n\nBody text.';
    const result = serializeFrontmatter(data, content);
    expect(result).toContain('---');
    expect(result).toContain('title: Test');
    expect(result).toContain('type: lecture');
    expect(result).toContain('# Test');
    expect(result).toContain('Body text.');
  });
});

describe('updateFrontmatter', () => {
  it('merges new fields into existing frontmatter', () => {
    const md = `---
title: Test
status: draft
---

Content.`;

    const result = updateFrontmatter(md, { status: 'approved', week: 12 });
    const parsed = parseFrontmatter(result);
    expect(parsed.data.title).toBe('Test');
    expect(parsed.data.status).toBe('approved');
    expect(parsed.data.week).toBe(12);
    expect(parsed.content).toContain('Content.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/vault/frontmatter.test.ts
```

Expected: FAIL — module `./frontmatter.js` not found.

- [ ] **Step 3: Implement frontmatter module**

Create `src/vault/frontmatter.ts`:

```typescript
import matter from 'gray-matter';

export interface ParsedNote {
  data: Record<string, unknown>;
  content: string;
}

export function parseFrontmatter(markdown: string): ParsedNote {
  const result = matter(markdown);
  return {
    data: result.data,
    content: result.content.trim(),
  };
}

export function serializeFrontmatter(
  data: Record<string, unknown>,
  content: string,
): string {
  return matter.stringify(content, data);
}

export function updateFrontmatter(
  markdown: string,
  updates: Record<string, unknown>,
): string {
  const { data, content } = parseFrontmatter(markdown);
  const merged = { ...data, ...updates };
  return serializeFrontmatter(merged, content);
}
```

- [ ] **Step 4: Install gray-matter dependency**

```bash
npm install gray-matter
npm install -D @types/gray-matter
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/vault/frontmatter.test.ts
```

Expected: All 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/vault/frontmatter.ts src/vault/frontmatter.test.ts package.json package-lock.json
git commit -m "feat: add frontmatter parsing module for Obsidian vault"
```

---

## Task 4: Vault Utility — Wikilinks Module

**Files:**
- Create: `src/vault/wikilinks.ts`
- Create: `src/vault/wikilinks.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/vault/wikilinks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractWikilinks, createWikilink, replaceWikilinks } from './wikilinks.js';

describe('extractWikilinks', () => {
  it('extracts simple wikilinks', () => {
    const md = 'See [[Digital Strategy]] and [[Change Management]].';
    const links = extractWikilinks(md);
    expect(links).toEqual([
      { target: 'Digital Strategy', heading: undefined, alias: undefined },
      { target: 'Change Management', heading: undefined, alias: undefined },
    ]);
  });

  it('extracts wikilinks with headings', () => {
    const md = 'See [[Digital Strategy#Key Concepts]].';
    const links = extractWikilinks(md);
    expect(links).toEqual([
      { target: 'Digital Strategy', heading: 'Key Concepts', alias: undefined },
    ]);
  });

  it('extracts wikilinks with aliases', () => {
    const md = 'See [[Digital Strategy|DS]].';
    const links = extractWikilinks(md);
    expect(links).toEqual([
      { target: 'Digital Strategy', heading: undefined, alias: 'DS' },
    ]);
  });

  it('extracts wikilinks with both heading and alias', () => {
    const md = 'See [[Digital Strategy#Key Concepts|key stuff]].';
    const links = extractWikilinks(md);
    expect(links).toEqual([
      { target: 'Digital Strategy', heading: 'Key Concepts', alias: 'key stuff' },
    ]);
  });

  it('returns empty array for no wikilinks', () => {
    expect(extractWikilinks('No links here.')).toEqual([]);
  });

  it('ignores image embeds', () => {
    const md = '![[figure.png]] and [[Real Link]]';
    const links = extractWikilinks(md);
    expect(links).toEqual([
      { target: 'Real Link', heading: undefined, alias: undefined },
    ]);
  });
});

describe('createWikilink', () => {
  it('creates simple wikilink', () => {
    expect(createWikilink('Digital Strategy')).toBe('[[Digital Strategy]]');
  });

  it('creates wikilink with alias', () => {
    expect(createWikilink('Digital Strategy', { alias: 'DS' })).toBe('[[Digital Strategy|DS]]');
  });

  it('creates wikilink with heading', () => {
    expect(createWikilink('Digital Strategy', { heading: 'Key Concepts' }))
      .toBe('[[Digital Strategy#Key Concepts]]');
  });
});

describe('replaceWikilinks', () => {
  it('renames a target across markdown', () => {
    const md = 'See [[Old Name]] and [[Old Name#Section]].';
    const result = replaceWikilinks(md, 'Old Name', 'New Name');
    expect(result).toBe('See [[New Name]] and [[New Name#Section]].');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/vault/wikilinks.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement wikilinks module**

Create `src/vault/wikilinks.ts`:

```typescript
export interface WikiLink {
  target: string;
  heading: string | undefined;
  alias: string | undefined;
}

// Matches [[target]], [[target#heading]], [[target|alias]], [[target#heading|alias]]
// Negative lookbehind for ! to exclude image embeds like ![[image.png]]
const WIKILINK_RE = /(?<!!)\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

export function extractWikilinks(markdown: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags);
  while ((match = re.exec(markdown)) !== null) {
    links.push({
      target: match[1].trim(),
      heading: match[2]?.trim(),
      alias: match[3]?.trim(),
    });
  }
  return links;
}

export function createWikilink(
  target: string,
  opts?: { heading?: string; alias?: string },
): string {
  let link = target;
  if (opts?.heading) link += `#${opts.heading}`;
  if (opts?.alias) link += `|${opts.alias}`;
  return `[[${link}]]`;
}

export function replaceWikilinks(
  markdown: string,
  oldTarget: string,
  newTarget: string,
): string {
  const re = new RegExp(
    `(?<!!)\\[\\[${escapeRegex(oldTarget)}(#[^\\]|]*?)?(\\|[^\\]]+?)?\\]\\]`,
    'g',
  );
  return markdown.replace(re, (_, heading = '', alias = '') => {
    return `[[${newTarget}${heading}${alias}]]`;
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/vault/wikilinks.test.ts
```

Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/wikilinks.ts src/vault/wikilinks.test.ts
git commit -m "feat: add wikilink extraction and manipulation module"
```

---

## Task 5: Vault Utility — Core VaultUtility Class

**Files:**
- Create: `src/vault/vault-utility.ts`
- Create: `src/vault/vault-utility.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/vault/vault-utility.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultUtility } from './vault-utility.js';

let vaultDir: string;
let vault: VaultUtility;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  mkdirSync(join(vaultDir, 'courses', 'BI-2081', 'lectures'), { recursive: true });
  mkdirSync(join(vaultDir, 'drafts'), { recursive: true });
  mkdirSync(join(vaultDir, 'attachments'), { recursive: true });
  vault = new VaultUtility(vaultDir);
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('createNote', () => {
  it('creates a note with frontmatter and body', async () => {
    await vault.createNote('courses/BI-2081/lectures/week1.md', {
      data: { title: 'Week 1', type: 'lecture', course: 'BI-2081', status: 'approved' },
      content: '# Week 1\n\nIntroduction.',
    });
    const raw = await readFile(join(vaultDir, 'courses/BI-2081/lectures/week1.md'), 'utf-8');
    expect(raw).toContain('title: Week 1');
    expect(raw).toContain('# Week 1');
  });

  it('creates intermediate directories if needed', async () => {
    await vault.createNote('courses/NEW-101/lectures/first.md', {
      data: { title: 'First', type: 'lecture' },
      content: 'Content.',
    });
    const raw = await readFile(join(vaultDir, 'courses/NEW-101/lectures/first.md'), 'utf-8');
    expect(raw).toContain('title: First');
  });
});

describe('readNote', () => {
  it('reads and parses an existing note', async () => {
    const md = `---\ntitle: Test\ntype: lecture\n---\n\n# Test\n\nBody.`;
    await writeFile(join(vaultDir, 'courses/BI-2081/lectures/test.md'), md);
    const note = await vault.readNote('courses/BI-2081/lectures/test.md');
    expect(note.data.title).toBe('Test');
    expect(note.content).toContain('Body.');
  });

  it('returns null for non-existent note', async () => {
    const note = await vault.readNote('nonexistent.md');
    expect(note).toBeNull();
  });
});

describe('searchNotes', () => {
  it('finds notes matching a frontmatter query', async () => {
    await vault.createNote('courses/BI-2081/lectures/a.md', {
      data: { title: 'A', type: 'lecture', course: 'BI-2081' },
      content: 'Content A.',
    });
    await vault.createNote('courses/BI-2081/lectures/b.md', {
      data: { title: 'B', type: 'reading', course: 'BI-2081' },
      content: 'Content B.',
    });
    const results = await vault.searchNotes({ type: 'lecture' });
    expect(results).toHaveLength(1);
    expect(results[0].data.title).toBe('A');
  });
});

describe('moveNote', () => {
  it('moves a note from one path to another', async () => {
    await vault.createNote('drafts/note.md', {
      data: { title: 'Draft', status: 'draft' },
      content: 'Draft content.',
    });
    await vault.moveNote('drafts/note.md', 'courses/BI-2081/lectures/note.md');
    const moved = await vault.readNote('courses/BI-2081/lectures/note.md');
    expect(moved).not.toBeNull();
    expect(moved!.data.title).toBe('Draft');
    const original = await vault.readNote('drafts/note.md');
    expect(original).toBeNull();
  });
});

describe('getBacklinks', () => {
  it('finds notes that link to a given note', async () => {
    await vault.createNote('courses/BI-2081/lectures/a.md', {
      data: { title: 'Note A' },
      content: 'Links to [[Note B]].',
    });
    await vault.createNote('courses/BI-2081/lectures/b.md', {
      data: { title: 'Note B' },
      content: 'No links here.',
    });
    const backlinks = await vault.getBacklinks('Note B');
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toContain('a.md');
  });
});

describe('listNotes', () => {
  it('lists all markdown files in a directory', async () => {
    await vault.createNote('courses/BI-2081/lectures/a.md', {
      data: { title: 'A' },
      content: 'A.',
    });
    await vault.createNote('courses/BI-2081/lectures/b.md', {
      data: { title: 'B' },
      content: 'B.',
    });
    const notes = await vault.listNotes('courses/BI-2081/lectures');
    expect(notes).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/vault/vault-utility.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement VaultUtility**

Create `src/vault/vault-utility.ts`:

```typescript
import { readFile, writeFile, mkdir, rename, readdir, unlink, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { extractWikilinks } from './wikilinks.js';

export interface NoteInput {
  data: Record<string, unknown>;
  content: string;
}

export interface NoteOutput {
  path: string;
  data: Record<string, unknown>;
  content: string;
}

export class VaultUtility {
  constructor(private readonly vaultDir: string) {}

  private resolve(notePath: string): string {
    return join(this.vaultDir, notePath);
  }

  async createNote(notePath: string, note: NoteInput): Promise<void> {
    const fullPath = this.resolve(notePath);
    await mkdir(dirname(fullPath), { recursive: true });
    const markdown = serializeFrontmatter(note.data, note.content);
    await writeFile(fullPath, markdown, 'utf-8');
  }

  async readNote(notePath: string): Promise<NoteOutput | null> {
    const fullPath = this.resolve(notePath);
    try {
      const raw = await readFile(fullPath, 'utf-8');
      const { data, content } = parseFrontmatter(raw);
      return { path: notePath, data, content };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async updateNote(notePath: string, updates: Record<string, unknown>): Promise<void> {
    const note = await this.readNote(notePath);
    if (!note) throw new Error(`Note not found: ${notePath}`);
    const merged = { ...note.data, ...updates };
    const markdown = serializeFrontmatter(merged, note.content);
    await writeFile(this.resolve(notePath), markdown, 'utf-8');
  }

  async moveNote(fromPath: string, toPath: string): Promise<void> {
    const fullTo = this.resolve(toPath);
    await mkdir(dirname(fullTo), { recursive: true });
    await rename(this.resolve(fromPath), fullTo);
  }

  async deleteNote(notePath: string): Promise<void> {
    await unlink(this.resolve(notePath));
  }

  async listNotes(dirPath: string): Promise<string[]> {
    const fullDir = this.resolve(dirPath);
    const entries = await readdir(fullDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(dirPath, e.name));
  }

  async searchNotes(
    query: Record<string, unknown>,
    searchDir?: string,
  ): Promise<NoteOutput[]> {
    const dir = searchDir || '';
    const allFiles = await this.walkMarkdownFiles(this.resolve(dir));
    const results: NoteOutput[] = [];

    for (const filePath of allFiles) {
      const relPath = relative(this.vaultDir, filePath);
      const note = await this.readNote(relPath);
      if (!note) continue;

      const matches = Object.entries(query).every(([key, value]) => {
        return note.data[key] === value;
      });
      if (matches) results.push(note);
    }
    return results;
  }

  async getBacklinks(noteTitle: string): Promise<string[]> {
    const allFiles = await this.walkMarkdownFiles(this.vaultDir);
    const backlinks: string[] = [];

    for (const filePath of allFiles) {
      const raw = await readFile(filePath, 'utf-8');
      const links = extractWikilinks(raw);
      if (links.some((link) => link.target === noteTitle)) {
        backlinks.push(relative(this.vaultDir, filePath));
      }
    }
    return backlinks;
  }

  private async walkMarkdownFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walkMarkdownFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/vault/vault-utility.test.ts
```

Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault/vault-utility.ts src/vault/vault-utility.test.ts
git commit -m "feat: add VaultUtility class for Obsidian vault operations"
```

---

## Task 6: Path Parser — Folder Context Extraction

**Files:**
- Create: `src/ingestion/path-parser.ts`
- Create: `src/ingestion/path-parser.test.ts`
- Create: `src/ingestion/type-mappings.ts`
- Create: `src/ingestion/type-mappings.test.ts`

- [ ] **Step 1: Write failing tests for type mappings**

Create `src/ingestion/type-mappings.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TypeMappings } from './type-mappings.js';

let configDir: string;
let mappings: TypeMappings;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mappings-test-'));
  mappings = new TypeMappings(join(configDir, 'type-mappings.json'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('classifyFolder', () => {
  it('maps Norwegian lecture folder names', () => {
    expect(mappings.classifyFolder('Forelesninger')).toBe('lecture');
    expect(mappings.classifyFolder('Slides')).toBe('lecture');
    expect(mappings.classifyFolder('Presentasjoner')).toBe('lecture');
  });

  it('maps Norwegian reading folder names', () => {
    expect(mappings.classifyFolder('Pensum')).toBe('reading');
    expect(mappings.classifyFolder('Litteratur')).toBe('reading');
  });

  it('maps exam-prep folders', () => {
    expect(mappings.classifyFolder('Eksamenslesning')).toBe('exam-prep');
    expect(mappings.classifyFolder('Tidligere eksamener')).toBe('exam-prep');
  });

  it('maps assignment folders', () => {
    expect(mappings.classifyFolder('Tasks')).toBe('assignment');
    expect(mappings.classifyFolder('Oppgaver')).toBe('assignment');
    expect(mappings.classifyFolder('Innleveringer')).toBe('assignment');
  });

  it('maps compendium folders', () => {
    expect(mappings.classifyFolder('Kompendium')).toBe('compendium');
  });

  it('maps project folders', () => {
    expect(mappings.classifyFolder('Bacheloroppgave')).toBe('project');
    expect(mappings.classifyFolder('Prosjekt')).toBe('project');
  });

  it('returns null for unknown folders', () => {
    expect(mappings.classifyFolder('Diverse')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(mappings.classifyFolder('forelesninger')).toBe('lecture');
    expect(mappings.classifyFolder('PENSUM')).toBe('reading');
  });
});

describe('learning', () => {
  it('saves and recalls custom mappings', async () => {
    expect(mappings.classifyFolder('Notater')).toBeNull();
    await mappings.learn('Notater', 'lecture');
    expect(mappings.classifyFolder('Notater')).toBe('lecture');
  });

  it('persists learned mappings to disk', async () => {
    await mappings.learn('Diverse', 'reference');
    const reloaded = new TypeMappings(join(configDir, 'type-mappings.json'));
    expect(reloaded.classifyFolder('Diverse')).toBe('reference');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ingestion/type-mappings.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement type mappings**

Create `src/ingestion/type-mappings.ts`:

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type NoteType =
  | 'lecture'
  | 'reading'
  | 'exam-prep'
  | 'assignment'
  | 'compendium'
  | 'project'
  | 'reference'
  | 'personal'
  | 'external';

const BUILT_IN_MAPPINGS: Record<string, NoteType> = {
  // Lectures
  forelesninger: 'lecture',
  lectures: 'lecture',
  slides: 'lecture',
  presentasjoner: 'lecture',
  // Readings
  pensum: 'reading',
  litteratur: 'reading',
  readings: 'reading',
  artikler: 'reading',
  // Exam prep
  eksamenslesning: 'exam-prep',
  eksamen: 'exam-prep',
  exam: 'exam-prep',
  'tidligere eksamener': 'exam-prep',
  // Assignments
  tasks: 'assignment',
  oppgaver: 'assignment',
  innleveringer: 'assignment',
  øvinger: 'assignment',
  // Compendium
  kompendium: 'compendium',
  summary: 'compendium',
  sammendrag: 'compendium',
  // Project
  prosjekt: 'project',
  project: 'project',
  bacheloroppgave: 'project',
  masteroppgave: 'project',
  // Reference
  ressurser: 'reference',
  resources: 'reference',
  vedlegg: 'reference',
};

export class TypeMappings {
  private customMappings: Record<string, NoteType> = {};
  private readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
    if (existsSync(configPath)) {
      this.customMappings = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  }

  classifyFolder(folderName: string): NoteType | null {
    const normalized = folderName.toLowerCase().trim();
    return (
      this.customMappings[normalized] ??
      BUILT_IN_MAPPINGS[normalized] ??
      null
    );
  }

  async learn(folderName: string, type: NoteType): Promise<void> {
    const normalized = folderName.toLowerCase().trim();
    this.customMappings[normalized] = type;
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.customMappings, null, 2));
  }
}
```

- [ ] **Step 4: Run type mapping tests**

```bash
npx vitest run src/ingestion/type-mappings.test.ts
```

Expected: All 10 tests PASS.

- [ ] **Step 5: Write failing tests for path parser**

Create `src/ingestion/path-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseUploadPath, PathContext } from './path-parser.js';

describe('parseUploadPath', () => {
  it('extracts full context from a typical path', () => {
    const result = parseUploadPath(
      '01 - Digital Forretningsutvikling/6. Semester/BI 2081 - Natur, miljø og bærekraft/Forelesninger/lecture-w12.pdf',
    );
    expect(result).toEqual<PathContext>({
      semester: 6,
      year: 3,
      courseCode: 'BI-2081',
      courseName: 'Natur, miljø og bærekraft',
      type: 'lecture',
      fileName: 'lecture-w12.pdf',
    });
  });

  it('handles different semester numbers', () => {
    const result = parseUploadPath(
      '01 - Digital Forretningsutvikling/1. Semester/DIFT 1001 - Intro/Pensum/book.pdf',
    );
    expect(result.semester).toBe(1);
    expect(result.year).toBe(1);
    expect(result.courseCode).toBe('DIFT-1001');
    expect(result.type).toBe('reading');
  });

  it('calculates year from semester correctly', () => {
    expect(parseUploadPath('x/1. Semester/Y 1234 - Z/f.pdf').year).toBe(1);
    expect(parseUploadPath('x/2. Semester/Y 1234 - Z/f.pdf').year).toBe(1);
    expect(parseUploadPath('x/3. Semester/Y 1234 - Z/f.pdf').year).toBe(2);
    expect(parseUploadPath('x/4. Semester/Y 1234 - Z/f.pdf').year).toBe(2);
    expect(parseUploadPath('x/5. Semester/Y 1234 - Z/f.pdf').year).toBe(3);
    expect(parseUploadPath('x/6. Semester/Y 1234 - Z/f.pdf').year).toBe(3);
  });

  it('returns null type for unrecognized folder names', () => {
    const result = parseUploadPath(
      '01 - Digital Forretningsutvikling/6. Semester/BI 2081 - Natur/Diverse/file.pdf',
    );
    expect(result.type).toBeNull();
  });

  it('handles files directly in course folder (no type subfolder)', () => {
    const result = parseUploadPath(
      '01 - Digital Forretningsutvikling/6. Semester/BI 2081 - Natur/NMB - Kompendium.pdf',
    );
    expect(result.courseCode).toBe('BI-2081');
    expect(result.type).toBeNull();
    expect(result.fileName).toBe('NMB - Kompendium.pdf');
  });

  it('returns partial context when path has less structure', () => {
    const result = parseUploadPath('random-folder/document.pdf');
    expect(result.semester).toBeNull();
    expect(result.courseCode).toBeNull();
    expect(result.fileName).toBe('document.pdf');
  });
});
```

- [ ] **Step 6: Implement path parser**

Create `src/ingestion/path-parser.ts`:

```typescript
import { basename } from 'node:path';
import { TypeMappings, NoteType } from './type-mappings.js';

export interface PathContext {
  semester: number | null;
  year: number | null;
  courseCode: string | null;
  courseName: string | null;
  type: NoteType | null;
  fileName: string;
}

const SEMESTER_RE = /(\d+)\.\s*Semester/i;
const COURSE_RE = /([A-Z]{2,4})\s+(\d{4})\s*-\s*(.+)/;

// Default instance for built-in mappings only (no persistence)
const defaultMappings = new TypeMappings('');

export function parseUploadPath(
  relativePath: string,
  typeMappings: TypeMappings = defaultMappings,
): PathContext {
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = basename(relativePath);

  let semester: number | null = null;
  let year: number | null = null;
  let courseCode: string | null = null;
  let courseName: string | null = null;
  let type: NoteType | null = null;

  for (const segment of segments) {
    // Try semester
    const semMatch = segment.match(SEMESTER_RE);
    if (semMatch) {
      semester = parseInt(semMatch[1], 10);
      year = Math.ceil(semester / 2);
      continue;
    }

    // Try course code
    const courseMatch = segment.match(COURSE_RE);
    if (courseMatch) {
      courseCode = `${courseMatch[1]}-${courseMatch[2]}`;
      courseName = courseMatch[3].trim();
      continue;
    }

    // Try type classification (skip the filename itself and root folder)
    if (segment !== fileName) {
      const classified = typeMappings.classifyFolder(segment);
      if (classified) type = classified;
    }
  }

  return { semester, year, courseCode, courseName, type, fileName };
}
```

- [ ] **Step 7: Fix the default TypeMappings constructor to handle empty path**

Update the `TypeMappings` constructor in `src/ingestion/type-mappings.ts` — change the `existsSync` check:

```typescript
  constructor(configPath: string) {
    this.configPath = configPath;
    if (configPath && existsSync(configPath)) {
      this.customMappings = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  }
```

- [ ] **Step 8: Run all path parser and type mapping tests**

```bash
npx vitest run src/ingestion/path-parser.test.ts src/ingestion/type-mappings.test.ts
```

Expected: All tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/ingestion/path-parser.ts src/ingestion/path-parser.test.ts \
  src/ingestion/type-mappings.ts src/ingestion/type-mappings.test.ts
git commit -m "feat: add path parser and type mappings for folder-based context extraction"
```

---

## Task 7: Docling Client — Python Document Extraction

**Files:**
- Create: `scripts/docling-extract.py`
- Create: `src/ingestion/docling-client.ts`
- Create: `src/ingestion/docling-client.test.ts`

- [ ] **Step 1: Create the Python extraction script**

Create `scripts/docling-extract.py`:

```python
#!/usr/bin/env python3
"""Extract text and figures from documents using Docling.

Usage: python docling-extract.py <input_file> <output_dir>

Outputs:
  <output_dir>/content.md    — Extracted markdown
  <output_dir>/figures/      — Extracted figure images (if any)
  <output_dir>/metadata.json — Extraction metadata
"""

import json
import sys
from pathlib import Path

def extract(input_path: str, output_dir: str) -> None:
    from docling.document_converter import DocumentConverter
    from docling.datamodel.pipeline_options import PdfPipelineOptions, EasyOcrOptions

    input_file = Path(input_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    figures_dir = out / "figures"
    figures_dir.mkdir(exist_ok=True)

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = True
    pipeline_options.ocr_options = EasyOcrOptions(lang=["no", "en"])
    pipeline_options.images_scale = 2.0
    pipeline_options.generate_picture_images = True

    converter = DocumentConverter(
        allowed_formats=None,
        pdf_pipeline_options=pipeline_options,
    )

    result = converter.convert(input_file)
    doc = result.document

    # Export markdown
    markdown = doc.export_to_markdown()
    (out / "content.md").write_text(markdown, encoding="utf-8")

    # Export figures
    figure_paths = []
    for i, element in enumerate(doc.pictures):
        if element.image is not None:
            fig_name = f"figure-{i+1:02d}.png"
            fig_path = figures_dir / fig_name
            element.image.pil_image.save(str(fig_path))
            figure_paths.append(fig_name)

    # Write metadata
    metadata = {
        "source": input_file.name,
        "pages": getattr(doc, 'num_pages', None),
        "figures": figure_paths,
        "format": input_file.suffix.lower(),
    }
    (out / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(json.dumps({"status": "ok", "output_dir": str(out), "figures": len(figure_paths)}))

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input_file> <output_dir>", file=sys.stderr)
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
```

- [ ] **Step 2: Write failing tests for the TypeScript client**

Create `src/ingestion/docling-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DoclingClient, DoclingResult } from './docling-client.js';

// We test the parsing logic, not the actual Python subprocess
describe('DoclingClient', () => {
  describe('parseResult', () => {
    it('parses a successful extraction result directory', async () => {
      // This tests the result parsing, not the subprocess.
      // Integration test with real Docling requires Python + the package installed.
      const client = new DoclingClient();
      expect(client).toBeDefined();
    });
  });

  describe('isSupported', () => {
    it('recognizes supported file extensions', () => {
      const client = new DoclingClient();
      expect(client.isSupported('lecture.pdf')).toBe(true);
      expect(client.isSupported('slides.pptx')).toBe(true);
      expect(client.isSupported('notes.docx')).toBe(true);
      expect(client.isSupported('image.png')).toBe(true);
      expect(client.isSupported('image.jpg')).toBe(true);
      expect(client.isSupported('text.md')).toBe(true);
      expect(client.isSupported('video.mp4')).toBe(false);
      expect(client.isSupported('archive.zip')).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/ingestion/docling-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement DoclingClient**

Create `src/ingestion/docling-client.ts`:

```typescript
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.pptx', '.docx', '.doc', '.ppt',
  '.png', '.jpg', '.jpeg', '.tiff', '.bmp',
  '.md', '.txt', '.html', '.htm',
]);

export interface DoclingResult {
  markdown: string;
  figures: string[];       // filenames of extracted figures
  figurePaths: string[];   // absolute paths to extracted figures
  metadata: {
    source: string;
    pages: number | null;
    format: string;
  };
  outputDir: string;
}

export class DoclingClient {
  private readonly scriptPath: string;
  private readonly pythonBin: string;

  constructor(pythonBin = 'python3') {
    this.scriptPath = join(import.meta.dirname, '..', '..', 'scripts', 'docling-extract.py');
    this.pythonBin = pythonBin;
  }

  isSupported(fileName: string): boolean {
    const ext = extname(fileName).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  }

  async extract(inputPath: string): Promise<DoclingResult> {
    const outputDir = mkdtempSync(join(tmpdir(), 'docling-'));

    await execFileAsync(this.pythonBin, [this.scriptPath, inputPath, outputDir], {
      timeout: 300_000, // 5 minute timeout for large documents
    });

    const markdown = await readFile(join(outputDir, 'content.md'), 'utf-8');
    const metaRaw = await readFile(join(outputDir, 'metadata.json'), 'utf-8');
    const meta = JSON.parse(metaRaw);

    return {
      markdown,
      figures: meta.figures || [],
      figurePaths: (meta.figures || []).map((f: string) => join(outputDir, 'figures', f)),
      metadata: {
        source: meta.source,
        pages: meta.pages,
        format: meta.format,
      },
      outputDir,
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/ingestion/docling-client.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/docling-extract.py src/ingestion/docling-client.ts \
  src/ingestion/docling-client.test.ts
git commit -m "feat: add Docling client for document text and figure extraction"
```

---

## Task 8: Database Schema — Ingestion & Review Tables

**Files:**
- Modify: `src/db.ts`
- Create: `src/db-ingestion.test.ts`

- [ ] **Step 1: Write failing tests for new tables**

Create `src/db-ingestion.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the SQL directly to avoid coupling to the full db.ts init
describe('ingestion tables', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'db-test-'));
    db = new Database(join(dir, 'test.db'));
    // Create tables using the same SQL that will be in db.ts
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_jobs (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_filename TEXT NOT NULL,
        course_code TEXT,
        course_name TEXT,
        semester INTEGER,
        year INTEGER,
        type TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES ingestion_jobs(id),
        draft_path TEXT NOT NULL,
        original_source TEXT,
        suggested_type TEXT,
        suggested_course TEXT,
        figures TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS folder_type_overrides (
        folder_name TEXT PRIMARY KEY,
        note_type TEXT NOT NULL,
        course_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an ingestion job', () => {
    const stmt = db.prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename, course_code, status)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run('job-1', '/uploads/test.pdf', 'test.pdf', 'BI-2081', 'pending');

    const job = db.prepare('SELECT * FROM ingestion_jobs WHERE id = ?').get('job-1') as any;
    expect(job.source_filename).toBe('test.pdf');
    expect(job.course_code).toBe('BI-2081');
    expect(job.status).toBe('pending');
  });

  it('creates review items linked to a job', () => {
    db.prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename, status) VALUES (?, ?, ?, ?)`,
    ).run('job-1', '/test.pdf', 'test.pdf', 'processing');

    db.prepare(
      `INSERT INTO review_items (id, job_id, draft_path, suggested_type, figures, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('rev-1', 'job-1', 'drafts/note-1.md', 'lecture', '["fig-01.png"]', 'pending');

    const item = db.prepare('SELECT * FROM review_items WHERE id = ?').get('rev-1') as any;
    expect(item.job_id).toBe('job-1');
    expect(item.draft_path).toBe('drafts/note-1.md');
    expect(JSON.parse(item.figures)).toEqual(['fig-01.png']);
  });

  it('tracks folder type overrides', () => {
    db.prepare(
      `INSERT INTO folder_type_overrides (folder_name, note_type) VALUES (?, ?)`,
    ).run('diverse', 'reference');

    const override = db.prepare(
      'SELECT * FROM folder_type_overrides WHERE folder_name = ?',
    ).get('diverse') as any;
    expect(override.note_type).toBe('reference');
  });

  it('updates job status to completed', () => {
    db.prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename, status) VALUES (?, ?, ?, ?)`,
    ).run('job-1', '/test.pdf', 'test.pdf', 'processing');

    db.prepare(
      `UPDATE ingestion_jobs SET status = ?, completed_at = datetime('now') WHERE id = ?`,
    ).run('completed', 'job-1');

    const job = db.prepare('SELECT * FROM ingestion_jobs WHERE id = ?').get('job-1') as any;
    expect(job.status).toBe('completed');
    expect(job.completed_at).not.toBeNull();
  });

  it('updates review item status to approved', () => {
    db.prepare(
      `INSERT INTO ingestion_jobs (id, source_path, source_filename, status) VALUES (?, ?, ?, ?)`,
    ).run('job-1', '/test.pdf', 'test.pdf', 'completed');
    db.prepare(
      `INSERT INTO review_items (id, job_id, draft_path, status) VALUES (?, ?, ?, ?)`,
    ).run('rev-1', 'job-1', 'drafts/note.md', 'pending');

    db.prepare(
      `UPDATE review_items SET status = ?, reviewed_at = datetime('now') WHERE id = ?`,
    ).run('approved', 'rev-1');

    const item = db.prepare('SELECT * FROM review_items WHERE id = ?').get('rev-1') as any;
    expect(item.status).toBe('approved');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass** (these test raw SQL, no source changes needed yet)

```bash
npx vitest run src/db-ingestion.test.ts
```

Expected: All 5 tests PASS (they create the tables inline).

- [ ] **Step 3: Add the tables to src/db.ts initDatabase()**

Add to the `initDatabase()` function in `src/db.ts`, after the existing `CREATE TABLE IF NOT EXISTS` statements:

```typescript
  // Ingestion pipeline tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_filename TEXT NOT NULL,
      course_code TEXT,
      course_name TEXT,
      semester INTEGER,
      year INTEGER,
      type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS review_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES ingestion_jobs(id),
      draft_path TEXT NOT NULL,
      original_source TEXT,
      suggested_type TEXT,
      suggested_course TEXT,
      figures TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS folder_type_overrides (
      folder_name TEXT PRIMARY KEY,
      note_type TEXT NOT NULL,
      course_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
```

Also add query helper functions after the existing helpers:

```typescript
export function createIngestionJob(
  id: string, sourcePath: string, sourceFilename: string,
  courseCode: string | null, courseName: string | null,
  semester: number | null, year: number | null, type: string | null,
): void {
  db.prepare(
    `INSERT INTO ingestion_jobs (id, source_path, source_filename, course_code, course_name, semester, year, type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(id, sourcePath, sourceFilename, courseCode, courseName, semester, year, type);
}

export function updateIngestionJobStatus(id: string, status: string, error?: string): void {
  db.prepare(
    `UPDATE ingestion_jobs SET status = ?, error = ?, completed_at = CASE WHEN ? IN ('completed','failed') THEN datetime('now') ELSE completed_at END WHERE id = ?`,
  ).run(status, error ?? null, status, id);
}

export function createReviewItem(
  id: string, jobId: string, draftPath: string, originalSource: string | null,
  suggestedType: string | null, suggestedCourse: string | null, figures: string[],
): void {
  db.prepare(
    `INSERT INTO review_items (id, job_id, draft_path, original_source, suggested_type, suggested_course, figures, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(id, jobId, draftPath, originalSource, suggestedType, suggestedCourse, JSON.stringify(figures));
}

export function updateReviewItemStatus(id: string, status: string): void {
  db.prepare(
    `UPDATE review_items SET status = ?, reviewed_at = datetime('now') WHERE id = ?`,
  ).run(status, id);
}

export function getPendingReviewItems(): unknown[] {
  return db.prepare(`SELECT * FROM review_items WHERE status = 'pending' ORDER BY created_at`).all();
}

export function getIngestionJobs(status?: string): unknown[] {
  if (status) {
    return db.prepare('SELECT * FROM ingestion_jobs WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM ingestion_jobs ORDER BY created_at DESC').all();
}
```

- [ ] **Step 4: Run the full test suite**

```bash
npm test
```

Expected: All tests PASS including existing NanoClaw tests.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db-ingestion.test.ts
git commit -m "feat: add ingestion and review queue database tables"
```

---

## Task 9: Review Queue Logic

**Files:**
- Create: `src/ingestion/review-queue.ts`
- Create: `src/ingestion/review-queue.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/ingestion/review-queue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultUtility } from '../vault/vault-utility.js';
import { ReviewQueue } from './review-queue.js';

let vaultDir: string;
let vault: VaultUtility;
let queue: ReviewQueue;

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'review-test-'));
  mkdirSync(join(vaultDir, 'drafts'), { recursive: true });
  mkdirSync(join(vaultDir, 'courses', 'BI-2081', 'lectures'), { recursive: true });
  mkdirSync(join(vaultDir, 'attachments', 'BI-2081', 'figures'), { recursive: true });
  vault = new VaultUtility(vaultDir);
  queue = new ReviewQueue(vault);
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('addDraft', () => {
  it('creates a draft note in the drafts folder', async () => {
    await queue.addDraft({
      id: 'draft-1',
      data: { title: 'Test', type: 'lecture', course: 'BI-2081', status: 'draft' },
      content: '# Test\n\nContent.',
      targetPath: 'courses/BI-2081/lectures/test.md',
    });

    const note = await vault.readNote('drafts/draft-1.md');
    expect(note).not.toBeNull();
    expect(note!.data.status).toBe('draft');
    expect(note!.data._targetPath).toBe('courses/BI-2081/lectures/test.md');
  });
});

describe('approveDraft', () => {
  it('moves draft to target path and updates status', async () => {
    await queue.addDraft({
      id: 'draft-1',
      data: {
        title: 'Test',
        type: 'lecture',
        course: 'BI-2081',
        status: 'draft',
      },
      content: '# Test\n\nContent.',
      targetPath: 'courses/BI-2081/lectures/test.md',
    });

    await queue.approveDraft('draft-1');

    const approved = await vault.readNote('courses/BI-2081/lectures/test.md');
    expect(approved).not.toBeNull();
    expect(approved!.data.status).toBe('approved');
    expect(approved!.data._targetPath).toBeUndefined();

    const draft = await vault.readNote('drafts/draft-1.md');
    expect(draft).toBeNull();
  });
});

describe('rejectDraft', () => {
  it('deletes the draft note', async () => {
    await queue.addDraft({
      id: 'draft-1',
      data: { title: 'Test', status: 'draft' },
      content: 'Content.',
      targetPath: 'courses/BI-2081/lectures/test.md',
    });

    await queue.rejectDraft('draft-1');

    const note = await vault.readNote('drafts/draft-1.md');
    expect(note).toBeNull();
  });
});

describe('removeFigure', () => {
  it('removes a figure embed from a draft note', async () => {
    await queue.addDraft({
      id: 'draft-1',
      data: {
        title: 'Test',
        status: 'draft',
        figures: ['figure-01.png', 'figure-02.png'],
      },
      content: '# Test\n\n![[figure-01.png]]\n\n**Figure:** Description of fig 1.\n\n![[figure-02.png]]\n\n**Figure:** Description of fig 2.',
      targetPath: 'courses/BI-2081/lectures/test.md',
    });

    await queue.removeFigure('draft-1', 'figure-01.png');

    const note = await vault.readNote('drafts/draft-1.md');
    expect(note!.content).not.toContain('figure-01.png');
    expect(note!.content).toContain('figure-02.png');
    expect(note!.data.figures).toEqual(['figure-02.png']);
  });
});

describe('listDrafts', () => {
  it('lists all drafts in the review queue', async () => {
    await queue.addDraft({
      id: 'draft-1',
      data: { title: 'A', status: 'draft' },
      content: 'A.',
      targetPath: 'courses/X/a.md',
    });
    await queue.addDraft({
      id: 'draft-2',
      data: { title: 'B', status: 'draft' },
      content: 'B.',
      targetPath: 'courses/X/b.md',
    });

    const drafts = await queue.listDrafts();
    expect(drafts).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/ingestion/review-queue.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement ReviewQueue**

Create `src/ingestion/review-queue.ts`:

```typescript
import { VaultUtility, NoteOutput } from '../vault/vault-utility.js';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface DraftInput {
  id: string;
  data: Record<string, unknown>;
  content: string;
  targetPath: string;
}

export class ReviewQueue {
  constructor(private readonly vault: VaultUtility) {}

  async addDraft(draft: DraftInput): Promise<void> {
    const draftPath = `drafts/${draft.id}.md`;
    await this.vault.createNote(draftPath, {
      data: { ...draft.data, status: 'draft', _targetPath: draft.targetPath },
      content: draft.content,
    });
  }

  async approveDraft(draftId: string): Promise<void> {
    const draftPath = `drafts/${draftId}.md`;
    const note = await this.vault.readNote(draftPath);
    if (!note) throw new Error(`Draft not found: ${draftId}`);

    const targetPath = note.data._targetPath as string;
    if (!targetPath) throw new Error(`Draft ${draftId} has no target path`);

    // Remove internal fields and set status
    const { _targetPath, ...cleanData } = note.data;
    cleanData.status = 'approved';

    await this.vault.createNote(targetPath, {
      data: cleanData,
      content: note.content,
    });
    await this.vault.deleteNote(draftPath);
  }

  async rejectDraft(draftId: string): Promise<void> {
    const draftPath = `drafts/${draftId}.md`;
    await this.vault.deleteNote(draftPath);
  }

  async removeFigure(draftId: string, figureFilename: string): Promise<void> {
    const draftPath = `drafts/${draftId}.md`;
    const note = await this.vault.readNote(draftPath);
    if (!note) throw new Error(`Draft not found: ${draftId}`);

    // Remove the figure embed and its description from content
    const embedPattern = new RegExp(
      `!\\[\\[${escapeRegex(figureFilename)}\\]\\]\\s*\\n?\\s*(?:\\*\\*Figure:\\*\\*[^\\n]*\\n?)?`,
      'g',
    );
    const cleanedContent = note.content.replace(embedPattern, '').trim();

    // Remove from figures array in frontmatter
    const figures = (note.data.figures as string[] || []).filter(
      (f) => f !== figureFilename,
    );

    await this.vault.createNote(draftPath, {
      data: { ...note.data, figures },
      content: cleanedContent,
    });
  }

  async listDrafts(): Promise<NoteOutput[]> {
    const paths = await this.vault.listNotes('drafts');
    const drafts: NoteOutput[] = [];
    for (const path of paths) {
      const note = await this.vault.readNote(path);
      if (note) drafts.push(note);
    }
    return drafts;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/ingestion/review-queue.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/review-queue.ts src/ingestion/review-queue.test.ts
git commit -m "feat: add review queue for draft note management"
```

---

## Task 10: File Watcher

**Files:**
- Create: `src/ingestion/file-watcher.ts`
- Create: `src/ingestion/file-watcher.test.ts`

- [ ] **Step 1: Install chokidar**

```bash
npm install chokidar
```

- [ ] **Step 2: Write failing tests**

Create `src/ingestion/file-watcher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileWatcher } from './file-watcher.js';

let uploadDir: string;

beforeEach(() => {
  uploadDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
});

afterEach(() => {
  rmSync(uploadDir, { recursive: true, force: true });
});

describe('FileWatcher', () => {
  it('detects new files added to the watch directory', async () => {
    const detected: string[] = [];
    const watcher = new FileWatcher(uploadDir, (filePath) => {
      detected.push(filePath);
    });

    await watcher.start();

    // Add a file
    writeFileSync(join(uploadDir, 'test.pdf'), 'fake pdf content');

    // Wait for detection
    await new Promise((r) => setTimeout(r, 500));

    await watcher.stop();

    expect(detected.length).toBeGreaterThanOrEqual(1);
    expect(detected[0]).toContain('test.pdf');
  });

  it('detects files in nested directories', async () => {
    const detected: string[] = [];
    const watcher = new FileWatcher(uploadDir, (filePath) => {
      detected.push(filePath);
    });

    await watcher.start();

    mkdirSync(join(uploadDir, 'subdir'), { recursive: true });
    writeFileSync(join(uploadDir, 'subdir', 'nested.pdf'), 'content');

    await new Promise((r) => setTimeout(r, 500));

    await watcher.stop();

    expect(detected.length).toBeGreaterThanOrEqual(1);
    expect(detected[0]).toContain('nested.pdf');
  });

  it('ignores non-document files', async () => {
    const detected: string[] = [];
    const watcher = new FileWatcher(uploadDir, (filePath) => {
      detected.push(filePath);
    });

    await watcher.start();

    writeFileSync(join(uploadDir, 'readme.txt'), 'text');
    writeFileSync(join(uploadDir, '.DS_Store'), 'mac junk');
    writeFileSync(join(uploadDir, 'doc.pdf'), 'pdf');

    await new Promise((r) => setTimeout(r, 500));

    await watcher.stop();

    const filenames = detected.map((d) => d.split('/').pop());
    expect(filenames).toContain('doc.pdf');
    expect(filenames).not.toContain('.DS_Store');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run src/ingestion/file-watcher.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement FileWatcher**

Create `src/ingestion/file-watcher.ts`:

```typescript
import chokidar from 'chokidar';
import { extname } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.pptx', '.docx', '.doc', '.ppt',
  '.png', '.jpg', '.jpeg', '.tiff', '.bmp',
  '.md', '.txt', '.html', '.htm',
]);

const IGNORED_FILES = new Set(['.ds_store', 'thumbs.db', '.gitkeep']);

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;

  constructor(
    private readonly watchDir: string,
    private readonly onFile: (filePath: string) => void,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.watchDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
      depth: 10,
    });

    this.watcher.on('add', (filePath) => {
      const fileName = filePath.split('/').pop() || '';
      if (IGNORED_FILES.has(fileName.toLowerCase())) return;

      const ext = extname(fileName).toLowerCase();
      if (!ext || SUPPORTED_EXTENSIONS.has(ext)) {
        this.onFile(filePath);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run src/ingestion/file-watcher.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ingestion/file-watcher.ts src/ingestion/file-watcher.test.ts \
  package.json package-lock.json
git commit -m "feat: add file watcher for upload folder monitoring"
```

---

## Task 11: Ingestion Pipeline Orchestrator

**Files:**
- Create: `src/ingestion/index.ts`
- Modify: `src/config.ts`

This task wires the components together: file watcher → path parser → docling → note generator → review queue.

- [ ] **Step 1: Add config constants**

Add to `src/config.ts`:

```typescript
export const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), 'vault');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), 'upload');
export const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3100', 10);
export const TYPE_MAPPINGS_PATH = join(STORE_DIR, 'type-mappings.json');
```

And add the import for `join` from `node:path` if not already present.

- [ ] **Step 2: Implement the pipeline orchestrator**

Create `src/ingestion/index.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join, relative, dirname, basename } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { DoclingClient } from './docling-client.js';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';
import { ReviewQueue, DraftInput } from './review-queue.js';
import { VaultUtility } from '../vault/vault-utility.js';
import {
  createIngestionJob,
  updateIngestionJobStatus,
  createReviewItem,
} from '../db.js';
import { log } from '../logger.js';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  typeMappingsPath: string;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private docling: DoclingClient;
  private typeMappings: TypeMappings;
  private vault: VaultUtility;
  private reviewQueue: ReviewQueue;
  private uploadDir: string;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vault = new VaultUtility(opts.vaultDir);
    this.reviewQueue = new ReviewQueue(this.vault);
    this.docling = new DoclingClient();
    this.typeMappings = new TypeMappings(opts.typeMappingsPath);
    this.watcher = new FileWatcher(opts.uploadDir, (filePath) => {
      this.processFile(filePath).catch((err) => {
        log('ingestion', `Error processing ${filePath}: ${err.message}`);
      });
    });
  }

  async start(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    await this.watcher.start();
    log('ingestion', `Watching ${this.uploadDir} for new files`);
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
  }

  async processFile(filePath: string): Promise<void> {
    const jobId = randomUUID();
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    log('ingestion', `Processing: ${relativePath}`);

    // Step 1: Parse path for context
    const context = parseUploadPath(relativePath, this.typeMappings);

    createIngestionJob(
      jobId, filePath, fileName,
      context.courseCode, context.courseName,
      context.semester, context.year, context.type,
    );

    try {
      updateIngestionJobStatus(jobId, 'extracting');

      // Step 2: Copy original to attachments
      const courseDir = context.courseCode || '_unsorted';
      const attachmentDir = join('attachments', courseDir);
      await mkdir(join(this.vault['vaultDir'], attachmentDir), { recursive: true });
      await copyFile(filePath, join(this.vault['vaultDir'], attachmentDir, fileName));

      // Step 3: Extract text and figures via Docling
      let markdown: string;
      let figures: string[] = [];
      let figurePaths: string[] = [];

      if (this.docling.isSupported(fileName)) {
        updateIngestionJobStatus(jobId, 'extracting');
        const result = await this.docling.extract(filePath);
        markdown = result.markdown;
        figures = result.figures;
        figurePaths = result.figurePaths;

        // Copy figures to vault attachments
        if (figures.length > 0) {
          const figDir = join(attachmentDir, 'figures', fileName.replace(/\.[^.]+$/, ''));
          await mkdir(join(this.vault['vaultDir'], figDir), { recursive: true });
          for (let i = 0; i < figures.length; i++) {
            await copyFile(
              figurePaths[i],
              join(this.vault['vaultDir'], figDir, figures[i]),
            );
          }
        }
      } else {
        markdown = `<!-- Unsupported format: ${fileName} -->\n\nOriginal file: [[${fileName}]]`;
      }

      updateIngestionJobStatus(jobId, 'generating');

      // Step 4: Create draft note (note generation via Claude happens in a future task)
      // For now, create a simple draft with extracted content
      const draftId = randomUUID();
      const targetFolder = context.type || 'unsorted';
      const courseFolder = context.courseCode || '_unsorted';
      const targetPath = `courses/${courseFolder}/${targetFolder}/${fileName.replace(/\.[^.]+$/, '.md')}`;

      const figureEmbeds = figures.map((f) => `![[${f}]]\n\n**Figure:** _Description pending._`).join('\n\n');
      const fullContent = markdown + (figureEmbeds ? `\n\n## Figures\n\n${figureEmbeds}` : '');

      const draft: DraftInput = {
        id: draftId,
        data: {
          title: fileName.replace(/\.[^.]+$/, ''),
          type: context.type,
          course: context.courseCode,
          course_name: context.courseName,
          semester: context.semester,
          year: context.year,
          source: fileName,
          language: 'auto',
          status: 'draft',
          figures,
          created: new Date().toISOString().split('T')[0],
        },
        content: fullContent,
        targetPath,
      };

      await this.reviewQueue.addDraft(draft);

      createReviewItem(
        draftId, jobId, `drafts/${draftId}.md`, fileName,
        context.type, context.courseCode, figures,
      );

      // Step 5: Move original out of upload folder
      const processedDir = join(this.uploadDir, '.processed');
      await mkdir(processedDir, { recursive: true });
      await rename(filePath, join(processedDir, `${jobId}-${fileName}`));

      updateIngestionJobStatus(jobId, 'completed');
      log('ingestion', `Completed: ${relativePath} → draft ${draftId}`);

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      updateIngestionJobStatus(jobId, 'failed', message);
      log('ingestion', `Failed: ${relativePath} — ${message}`);
    }
  }
}
```

- [ ] **Step 3: Run the full test suite to ensure nothing is broken**

```bash
npm test
```

Expected: All existing tests PASS. (No integration test for the orchestrator yet — it depends on Docling being installed. The individual components are tested.)

- [ ] **Step 4: Commit**

```bash
git add src/ingestion/index.ts src/config.ts
git commit -m "feat: add ingestion pipeline orchestrator wiring all components"
```

---

## Task 12: Wire Pipeline into NanoClaw Startup

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add pipeline startup to main()**

In `src/index.ts`, after the existing subsystem startups (task scheduler, IPC watcher, group queue) and before the message polling loop, add:

```typescript
import { IngestionPipeline } from './ingestion/index.js';
import { VAULT_DIR, UPLOAD_DIR, TYPE_MAPPINGS_PATH } from './config.js';

// ... inside main(), after other subsystem setup:

// Start ingestion pipeline
const pipeline = new IngestionPipeline({
  uploadDir: UPLOAD_DIR,
  vaultDir: VAULT_DIR,
  typeMappingsPath: TYPE_MAPPINGS_PATH,
});
await pipeline.start();

// ... add to graceful shutdown handler:
await pipeline.stop();
```

- [ ] **Step 2: Build and verify**

```bash
npm run build
```

Expected: Clean build with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire ingestion pipeline into NanoClaw startup and shutdown"
```

---

## Task 13: Agent CLAUDE.md — Teaching Assistant Personality

**Files:**
- Modify: `groups/main/CLAUDE.md`
- Modify: `groups/global/CLAUDE.md`

- [ ] **Step 1: Customize the main group CLAUDE.md**

Append to `groups/main/CLAUDE.md` (after the existing NanoClaw template content):

```markdown

## universityClaw — Teaching Assistant

You are a personal university teaching assistant for a Digital Transformation degree program. Your knowledge base is an Obsidian vault at `/workspace/group/vault/`.

### Core Capabilities

1. **Q&A** — Answer questions grounded in vault content. Always cite which notes you drew from. If you're unsure or the vault doesn't cover the topic, say so rather than guessing.

2. **Quiz** — Generate questions from specified course material. Track what the student gets right and wrong. Vary difficulty. After a quiz session, update the knowledge map.

3. **Summarize** — Create structured summaries of lectures, chapters, or entire courses. Use headings, bullet points, and key concept highlights.

4. **Writing Help** — Help structure essays, review assignment drafts, suggest improvements. Ground suggestions in course material when relevant.

5. **Study Planning** — Suggest what to focus on based on the knowledge map (weak areas), upcoming exam dates, and course progression.

### Language

Mirror the user's language. If they write Norwegian, respond in Norwegian. If English, respond in English. When source material is in a different language than the conversation, translate key terms and concepts.

### Source Attribution

Every answer that draws on vault content MUST include references:
- "Basert på [[Note Title]]" or "Source: [[Note Title]]"
- When multiple sources are used, list them at the end

### Ingestion Pipeline Interaction

When you receive a message about document classification (from the ingestion pipeline), respond clearly with the classification. For example:
- Pipeline: "I found files in 'BI 2081/Diverse/' — what type of material is this?"
- You: Help the user classify by asking via send_message to the user's chat

### Student Profile

Read from and update these files:
- `/workspace/group/vault/profile/student-profile.md` — Course roster, program info
- `/workspace/group/vault/profile/study-log.md` — Append after each study interaction
- `/workspace/group/vault/profile/knowledge-map.md` — Update after quizzes
```

- [ ] **Step 2: Update global CLAUDE.md similarly**

Append to `groups/global/CLAUDE.md`:

```markdown

## universityClaw — Teaching Assistant Context

You have read-only access to the Obsidian vault. You can answer questions, generate quizzes, and summarize content from vault notes. Always cite your sources using [[wikilink]] notation.

Mirror the user's language (Norwegian or English). Ground your answers in the actual course material rather than general knowledge.
```

- [ ] **Step 3: Commit**

```bash
git add groups/main/CLAUDE.md groups/global/CLAUDE.md
git commit -m "feat: add teaching assistant personality and capabilities to agent CLAUDE.md"
```

---

## Task 14: Web Dashboard — Project Setup

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/next.config.ts`
- Create: `dashboard/src/app/layout.tsx`
- Create: `dashboard/src/app/page.tsx`

- [ ] **Step 1: Initialize Next.js project**

```bash
mkdir -p dashboard
cd dashboard
npx create-next-app@latest . --typescript --tailwind --eslint \
  --app --src-dir --import-alias "@/*" --no-turbopack --use-npm
cd ..
```

- [ ] **Step 2: Update next.config.ts for vault access**

Replace `dashboard/next.config.ts`:

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
```

- [ ] **Step 3: Create root layout**

Replace `dashboard/src/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'universityClaw',
  description: 'Teaching Assistant Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <nav className="border-b border-gray-800 px-6 py-4">
          <div className="flex items-center gap-8">
            <h1 className="text-lg font-semibold">universityClaw</h1>
            <div className="flex gap-6 text-sm text-gray-400">
              <a href="/" className="hover:text-gray-100">Status</a>
              <a href="/upload" className="hover:text-gray-100">Upload</a>
              <a href="/review" className="hover:text-gray-100">Review</a>
              <a href="/vault" className="hover:text-gray-100">Vault</a>
            </div>
          </div>
        </nav>
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 4: Create status page**

Replace `dashboard/src/app/page.tsx`:

```tsx
export default function StatusPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">System Status</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatusCard title="Pipeline" status="Running" />
        <StatusCard title="RAG Index" status="Not configured" />
        <StatusCard title="Telegram" status="Not connected" />
      </div>
    </div>
  );
}

function StatusCard({ title, status }: { title: string; status: string }) {
  return (
    <div className="border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm text-gray-400 mb-1">{title}</h3>
      <p className="text-lg">{status}</p>
    </div>
  );
}
```

- [ ] **Step 5: Verify dashboard builds**

```bash
cd dashboard && npm run build && cd ..
```

Expected: Next.js build succeeds.

- [ ] **Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat: initialize Next.js dashboard with layout and status page"
```

---

## Task 15: Web Dashboard — Review Queue UI

**Files:**
- Create: `dashboard/src/app/api/review/route.ts`
- Create: `dashboard/src/app/api/review/[id]/figures/route.ts`
- Create: `dashboard/src/app/review/page.tsx`
- Create: `dashboard/src/app/review/[id]/page.tsx`

- [ ] **Step 1: Create review API routes**

Create `dashboard/src/app/api/review/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');

export async function GET() {
  const draftsDir = join(VAULT_DIR, 'drafts');

  try {
    const files = await readdir(draftsDir);
    const drafts = await Promise.all(
      files
        .filter((f) => f.endsWith('.md'))
        .map(async (f) => {
          const raw = await readFile(join(draftsDir, f), 'utf-8');
          const { data, content } = matter(raw);
          return {
            id: f.replace('.md', ''),
            ...data,
            contentPreview: content.slice(0, 200),
          };
        }),
    );
    return NextResponse.json(drafts);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(request: Request) {
  const body = await request.json();
  const { id, action } = body as { id: string; action: 'approve' | 'reject' };

  const draftPath = join(VAULT_DIR, 'drafts', `${id}.md`);
  const raw = await readFile(draftPath, 'utf-8');
  const { data, content } = matter(raw);

  if (action === 'approve') {
    const targetPath = data._targetPath as string;
    if (!targetPath) {
      return NextResponse.json({ error: 'No target path' }, { status: 400 });
    }

    const { _targetPath, ...cleanData } = data;
    cleanData.status = 'approved';

    const approved = matter.stringify(content, cleanData);
    const fullTargetPath = join(VAULT_DIR, targetPath);

    const { mkdir, writeFile, unlink } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(fullTargetPath), { recursive: true });
    await writeFile(fullTargetPath, approved);
    await unlink(draftPath);

    return NextResponse.json({ status: 'approved', path: targetPath });
  }

  if (action === 'reject') {
    const { unlink } = await import('node:fs/promises');
    await unlink(draftPath);
    return NextResponse.json({ status: 'rejected' });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
```

Create `dashboard/src/app/api/review/[id]/figures/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { figure } = body as { figure: string };

  const draftPath = join(VAULT_DIR, 'drafts', `${id}.md`);
  const raw = await readFile(draftPath, 'utf-8');
  const { data, content } = matter(raw);

  // Remove figure embed and description from content
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `!\\[\\[${escaped}\\]\\]\\s*\\n?\\s*(?:\\*\\*Figure:\\*\\*[^\\n]*\\n?)?`,
    'g',
  );
  const cleanedContent = content.replace(pattern, '').trim();

  // Remove from figures array
  const figures = ((data.figures as string[]) || []).filter((f) => f !== figure);
  data.figures = figures;

  const updated = matter.stringify(cleanedContent, data);
  await writeFile(draftPath, updated);

  return NextResponse.json({ status: 'removed', remainingFigures: figures });
}
```

- [ ] **Step 2: Create review list page**

Create `dashboard/src/app/review/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';

interface Draft {
  id: string;
  title: string;
  type: string;
  course: string;
  course_name: string;
  figures: string[];
  contentPreview: string;
}

export default function ReviewPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  useEffect(() => {
    fetch('/api/review')
      .then((r) => r.json())
      .then(setDrafts);
  }, []);

  async function handleAction(id: string, action: 'approve' | 'reject') {
    await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">
        Review Queue ({drafts.length} pending)
      </h2>

      {drafts.length === 0 && (
        <p className="text-gray-500">No drafts pending review.</p>
      )}

      <div className="space-y-4">
        {drafts.map((draft) => (
          <div
            key={draft.id}
            className="border border-gray-800 rounded-lg p-4"
          >
            <div className="flex justify-between items-start mb-2">
              <div>
                <h3 className="font-semibold">{draft.title}</h3>
                <p className="text-sm text-gray-400">
                  {draft.course} — {draft.type}
                  {draft.figures?.length > 0 &&
                    ` — ${draft.figures.length} figure(s)`}
                </p>
              </div>
              <div className="flex gap-2">
                <a
                  href={`/review/${draft.id}`}
                  className="px-3 py-1 bg-gray-800 rounded text-sm hover:bg-gray-700"
                >
                  Review
                </a>
                <button
                  onClick={() => handleAction(draft.id, 'approve')}
                  className="px-3 py-1 bg-green-900 rounded text-sm hover:bg-green-800"
                >
                  Approve
                </button>
                <button
                  onClick={() => handleAction(draft.id, 'reject')}
                  className="px-3 py-1 bg-red-900 rounded text-sm hover:bg-red-800"
                >
                  Reject
                </button>
              </div>
            </div>
            <p className="text-sm text-gray-500">{draft.contentPreview}...</p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create single draft review page with figure management**

Create `dashboard/src/app/review/[id]/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

interface DraftDetail {
  id: string;
  title: string;
  type: string;
  course: string;
  course_name: string;
  source: string;
  figures: string[];
  content: string;
  _targetPath: string;
}

export default function ReviewDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [draft, setDraft] = useState<DraftDetail | null>(null);

  useEffect(() => {
    fetch('/api/review')
      .then((r) => r.json())
      .then((drafts: DraftDetail[]) => {
        const found = drafts.find((d) => d.id === id);
        if (found) setDraft(found);
      });
  }, [id]);

  async function handleAction(action: 'approve' | 'reject') {
    await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    router.push('/review');
  }

  async function removeFigure(figure: string) {
    await fetch(`/api/review/${id}/figures`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figure }),
    });
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            figures: prev.figures.filter((f) => f !== figure),
          }
        : null,
    );
  }

  if (!draft) return <p className="text-gray-500">Loading...</p>;

  return (
    <div className="max-w-4xl">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold">{draft.title}</h2>
          <p className="text-gray-400">
            {draft.course} — {draft.type} — Source: {draft.source}
          </p>
          <p className="text-sm text-gray-500">
            Target: {draft._targetPath}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleAction('approve')}
            className="px-4 py-2 bg-green-900 rounded hover:bg-green-800"
          >
            Approve
          </button>
          <button
            onClick={() => handleAction('reject')}
            className="px-4 py-2 bg-red-900 rounded hover:bg-red-800"
          >
            Reject
          </button>
        </div>
      </div>

      {draft.figures && draft.figures.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">
            Figures ({draft.figures.length})
          </h3>
          <div className="grid grid-cols-2 gap-4">
            {draft.figures.map((fig) => (
              <div
                key={fig}
                className="border border-gray-800 rounded-lg p-3"
              >
                <p className="text-sm text-gray-400 mb-2">{fig}</p>
                <button
                  onClick={() => removeFigure(fig)}
                  className="text-sm text-red-400 hover:text-red-300"
                >
                  Remove figure
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border border-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-3">Generated Content</h3>
        <div className="prose prose-invert max-w-none whitespace-pre-wrap text-sm">
          {draft.content}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Install gray-matter in the dashboard**

```bash
cd dashboard && npm install gray-matter && cd ..
```

- [ ] **Step 5: Build and verify**

```bash
cd dashboard && npm run build && cd ..
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat: add review queue UI with figure management"
```

---

## Task 16: Web Dashboard — Upload & Vault Browser Pages

**Files:**
- Create: `dashboard/src/app/upload/page.tsx`
- Create: `dashboard/src/app/api/upload/route.ts`
- Create: `dashboard/src/app/vault/page.tsx`
- Create: `dashboard/src/app/api/vault/route.ts`

- [ ] **Step 1: Create upload API route**

Create `dashboard/src/app/api/upload/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const UPLOAD_DIR = process.env.UPLOAD_DIR || join(process.cwd(), '..', 'upload');

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File;
  const subfolder = (formData.get('subfolder') as string) || '';

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  const targetDir = subfolder
    ? join(UPLOAD_DIR, subfolder)
    : UPLOAD_DIR;

  await mkdir(targetDir, { recursive: true });

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  await writeFile(join(targetDir, file.name), buffer);

  return NextResponse.json({
    status: 'uploaded',
    filename: file.name,
    path: join(subfolder, file.name),
  });
}
```

- [ ] **Step 2: Create upload page**

Create `dashboard/src/app/upload/page.tsx`:

```tsx
'use client';

import { useState } from 'react';

export default function UploadPage() {
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<string[]>([]);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem('file') as HTMLInputElement;
    const files = fileInput.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const uploaded: string[] = [];

    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      uploaded.push(`${data.filename} — ${data.status}`);
    }

    setResults(uploaded);
    setUploading(false);
    fileInput.value = '';
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold mb-6">Upload Documents</h2>

      <form onSubmit={handleUpload} className="space-y-4">
        <div className="border-2 border-dashed border-gray-700 rounded-lg p-8 text-center">
          <input
            type="file"
            name="file"
            multiple
            accept=".pdf,.pptx,.docx,.doc,.ppt,.png,.jpg,.jpeg,.md,.txt"
            className="block w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:bg-gray-800 file:text-gray-300 hover:file:bg-gray-700"
          />
          <p className="mt-2 text-sm text-gray-500">
            PDF, PPTX, DOCX, images, Markdown
          </p>
        </div>

        <button
          type="submit"
          disabled={uploading}
          className="px-4 py-2 bg-blue-900 rounded hover:bg-blue-800 disabled:opacity-50"
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </form>

      {results.length > 0 && (
        <div className="mt-6 space-y-2">
          <h3 className="font-semibold">Results</h3>
          {results.map((r, i) => (
            <p key={i} className="text-sm text-gray-400">{r}</p>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create vault browsing API**

Create `dashboard/src/app/api/vault/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

const VAULT_DIR = process.env.VAULT_DIR || join(process.cwd(), '..', 'vault');

export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const fullPath = join(VAULT_DIR, path);

  try {
    const info = await stat(fullPath);

    if (info.isDirectory()) {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: join(path, e.name),
        }));
      return NextResponse.json({ type: 'directory', path, items });
    }

    if (fullPath.endsWith('.md')) {
      const raw = await readFile(fullPath, 'utf-8');
      const { data, content } = matter(raw);
      return NextResponse.json({ type: 'file', path, data, content });
    }

    return NextResponse.json({ type: 'file', path, data: {}, content: '' });
  } catch {
    return NextResponse.json({ type: 'directory', path, items: [] });
  }
}
```

- [ ] **Step 4: Create vault browser page**

Create `dashboard/src/app/vault/page.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

interface DirEntry {
  name: string;
  type: 'directory' | 'file';
  path: string;
}

interface VaultResponse {
  type: 'directory' | 'file';
  path: string;
  items?: DirEntry[];
  data?: Record<string, unknown>;
  content?: string;
}

export default function VaultPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentPath = searchParams.get('path') || '';
  const [view, setView] = useState<VaultResponse | null>(null);

  useEffect(() => {
    fetch(`/api/vault?path=${encodeURIComponent(currentPath)}`)
      .then((r) => r.json())
      .then(setView);
  }, [currentPath]);

  function navigate(path: string) {
    router.push(`/vault?path=${encodeURIComponent(path)}`);
  }

  if (!view) return <p className="text-gray-500">Loading...</p>;

  const parentPath = currentPath.split('/').slice(0, -1).join('/');

  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-bold mb-2">Vault Browser</h2>
      <p className="text-sm text-gray-500 mb-6">
        /{currentPath || '(root)'}
      </p>

      {currentPath && (
        <button
          onClick={() => navigate(parentPath)}
          className="text-sm text-blue-400 hover:text-blue-300 mb-4 block"
        >
          .. (up)
        </button>
      )}

      {view.type === 'directory' && (
        <div className="space-y-1">
          {view.items?.map((item) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className="w-full text-left px-4 py-2 rounded hover:bg-gray-800 flex items-center gap-3"
            >
              <span className="text-gray-500">
                {item.type === 'directory' ? '/' : '#'}
              </span>
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      )}

      {view.type === 'file' && view.content && (
        <div className="border border-gray-800 rounded-lg p-6">
          {view.data && Object.keys(view.data).length > 0 && (
            <div className="mb-4 pb-4 border-b border-gray-800">
              <h3 className="text-sm text-gray-400 mb-2">Frontmatter</h3>
              <pre className="text-xs text-gray-500">
                {JSON.stringify(view.data, null, 2)}
              </pre>
            </div>
          )}
          <div className="prose prose-invert max-w-none whitespace-pre-wrap text-sm">
            {view.content}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Build and verify**

```bash
cd dashboard && npm run build && cd ..
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat: add upload and vault browser pages to dashboard"
```

---

## Task 17: Student Profile Module

**Files:**
- Create: `src/profile/student-profile.ts`
- Create: `src/profile/student-profile.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/profile/student-profile.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultUtility } from '../vault/vault-utility.js';
import { StudentProfile } from './student-profile.js';

let vaultDir: string;
let vault: VaultUtility;
let profile: StudentProfile;

beforeEach(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), 'profile-test-'));
  mkdirSync(join(vaultDir, 'profile'), { recursive: true });
  vault = new VaultUtility(vaultDir);

  // Create initial profile files
  await vault.createNote('profile/student-profile.md', {
    data: { title: 'Student Profile', type: 'profile', program: 'Digital Transformation' },
    content: '## Active Courses\n\n## Completed Courses\n',
  });
  await vault.createNote('profile/study-log.md', {
    data: { title: 'Study Log', type: 'profile' },
    content: '',
  });
  await vault.createNote('profile/knowledge-map.md', {
    data: { title: 'Knowledge Map', type: 'profile' },
    content: '',
  });

  profile = new StudentProfile(vault);
});

afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('logStudySession', () => {
  it('appends an entry to the study log', async () => {
    await profile.logStudySession({
      type: 'quiz',
      course: 'BI-2081',
      topic: 'Sustainability frameworks',
      duration: '15 min',
      result: '7/10 correct',
    });

    const log = await vault.readNote('profile/study-log.md');
    expect(log!.content).toContain('quiz');
    expect(log!.content).toContain('BI-2081');
    expect(log!.content).toContain('Sustainability frameworks');
  });
});

describe('updateKnowledgeMap', () => {
  it('adds a topic with confidence level', async () => {
    await profile.updateKnowledgeMap('Sustainability', 'BI-2081', 0.7);

    const map = await vault.readNote('profile/knowledge-map.md');
    expect(map!.content).toContain('Sustainability');
    expect(map!.content).toContain('0.7');
  });
});

describe('addCourse', () => {
  it('adds a course to the active courses list', async () => {
    await profile.addCourse('BI-2081', 'Natur, miljø og bærekraft', 6);

    const prof = await vault.readNote('profile/student-profile.md');
    expect(prof!.content).toContain('BI-2081');
    expect(prof!.content).toContain('Natur, miljø og bærekraft');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/profile/student-profile.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement StudentProfile**

Create `src/profile/student-profile.ts`:

```typescript
import { VaultUtility } from '../vault/vault-utility.js';

interface StudySessionEntry {
  type: 'quiz' | 'qa' | 'summary' | 'writing' | 'study';
  course?: string;
  topic: string;
  duration?: string;
  result?: string;
}

export class StudentProfile {
  constructor(private readonly vault: VaultUtility) {}

  async logStudySession(entry: StudySessionEntry): Promise<void> {
    const log = await this.vault.readNote('profile/study-log.md');
    if (!log) return;

    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const line = `\n### ${date} ${time} — ${entry.type}${entry.course ? ` (${entry.course})` : ''}\n- **Topic:** ${entry.topic}${entry.duration ? `\n- **Duration:** ${entry.duration}` : ''}${entry.result ? `\n- **Result:** ${entry.result}` : ''}\n`;

    await this.vault.createNote('profile/study-log.md', {
      data: log.data,
      content: log.content + line,
    });
  }

  async updateKnowledgeMap(
    topic: string,
    course: string,
    confidence: number,
  ): Promise<void> {
    const map = await this.vault.readNote('profile/knowledge-map.md');
    if (!map) return;

    const date = new Date().toISOString().split('T')[0];
    // Check if topic already exists and update, or add new
    const topicPattern = new RegExp(`^- \\*\\*${escapeRegex(topic)}\\*\\*.*$`, 'm');

    const entry = `- **${topic}** (${course}) — confidence: ${confidence} — updated: ${date}`;

    let newContent: string;
    if (topicPattern.test(map.content)) {
      newContent = map.content.replace(topicPattern, entry);
    } else {
      newContent = map.content + `\n${entry}`;
    }

    await this.vault.createNote('profile/knowledge-map.md', {
      data: map.data,
      content: newContent.trim(),
    });
  }

  async addCourse(
    courseCode: string,
    courseName: string,
    semester: number,
  ): Promise<void> {
    const prof = await this.vault.readNote('profile/student-profile.md');
    if (!prof) return;

    const courseEntry = `- **${courseCode}** — ${courseName} (Semester ${semester})`;

    // Add under Active Courses heading
    const updated = prof.content.replace(
      '## Active Courses\n',
      `## Active Courses\n${courseEntry}\n`,
    );

    await this.vault.createNote('profile/student-profile.md', {
      data: prof.data,
      content: updated,
    });
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/profile/student-profile.test.ts
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/profile/student-profile.ts src/profile/student-profile.test.ts
git commit -m "feat: add student profile module for learning progress tracking"
```

---

## Task 18: RAG Layer — LightRAG Integration

**Files:**
- Create: `src/rag/rag-client.ts`
- Create: `src/rag/rag-client.test.ts`
- Create: `src/rag/indexer.ts`
- Create: `src/rag/indexer.test.ts`

> **Note:** LightRAG is a Python project. We integrate it as a subprocess/API similar to Docling. The detailed RAG configuration (embedding model selection, graph parameters, query tuning) will require experimentation once real course data is loaded. This task sets up the integration scaffolding.

- [ ] **Step 1: Write tests for RAG client interface**

Create `src/rag/rag-client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RagClient } from './rag-client.js';

describe('RagClient', () => {
  it('constructs with config', () => {
    const client = new RagClient({
      workingDir: '/tmp/rag-test',
      vaultDir: '/tmp/vault-test',
    });
    expect(client).toBeDefined();
  });

  describe('buildQuery', () => {
    it('adds metadata filter to query', () => {
      const client = new RagClient({
        workingDir: '/tmp/rag-test',
        vaultDir: '/tmp/vault-test',
      });
      const query = client.buildQuery('What is digital strategy?', {
        course: 'BI-2081',
      });
      expect(query).toContain('digital strategy');
      expect(query).toContain('BI-2081');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/rag/rag-client.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement RagClient**

Create `src/rag/rag-client.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RagConfig {
  workingDir: string;
  vaultDir: string;
  pythonBin?: string;
}

export interface RagResult {
  answer: string;
  sources: string[];
}

export class RagClient {
  private config: RagConfig;

  constructor(config: RagConfig) {
    this.config = config;
  }

  buildQuery(query: string, filters?: Record<string, string>): string {
    let enriched = query;
    if (filters) {
      const filterStr = Object.entries(filters)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      enriched = `[Context: ${filterStr}] ${query}`;
    }
    return enriched;
  }

  async query(
    question: string,
    mode: 'naive' | 'local' | 'global' | 'hybrid' = 'hybrid',
    filters?: Record<string, string>,
  ): Promise<RagResult> {
    const enrichedQuery = this.buildQuery(question, filters);

    try {
      const { stdout } = await execFileAsync(
        this.config.pythonBin || 'python3',
        [
          '-c',
          `
import json
from lightrag import LightRAG, QueryParam
rag = LightRAG(working_dir="${this.config.workingDir}")
result = rag.query("${enrichedQuery.replace(/"/g, '\\"')}", param=QueryParam(mode="${mode}"))
print(json.dumps({"answer": result, "sources": []}))
`,
        ],
        { timeout: 60_000 },
      );

      return JSON.parse(stdout.trim());
    } catch (err) {
      // LightRAG not installed or index not built yet
      return {
        answer: `RAG query failed. Falling back to general knowledge. Original question: ${question}`,
        sources: [],
      };
    }
  }

  async index(text: string): Promise<void> {
    await execFileAsync(
      this.config.pythonBin || 'python3',
      [
        '-c',
        `
from lightrag import LightRAG
rag = LightRAG(working_dir="${this.config.workingDir}")
rag.insert("""${text.replace(/"/g, '\\"').replace(/\n/g, '\\n')}""")
print("indexed")
`,
      ],
      { timeout: 120_000 },
    );
  }
}
```

- [ ] **Step 4: Create indexer that watches vault changes**

Create `src/rag/indexer.ts`:

```typescript
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import chokidar from 'chokidar';
import { RagClient } from './rag-client.js';
import { parseFrontmatter } from '../vault/frontmatter.js';
import { log } from '../logger.js';

export class RagIndexer {
  private watcher: chokidar.FSWatcher | null = null;

  constructor(
    private readonly vaultDir: string,
    private readonly ragClient: RagClient,
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.vaultDir, {
      ignored: [
        '**/drafts/**',       // Don't index drafts
        '**/attachments/**',  // Don't index binary attachments
        '**/.*',              // Ignore hidden files
      ],
      ignoreInitial: false,   // Index existing files on startup
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    this.watcher.on('add', (filePath) => this.indexFile(filePath));
    this.watcher.on('change', (filePath) => this.indexFile(filePath));

    log('rag', `Indexer watching ${this.vaultDir}`);
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async indexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith('.md')) return;

    try {
      const raw = await readFile(filePath, 'utf-8');
      const { data, content } = parseFrontmatter(raw);

      // Only index approved notes
      if (data.status === 'draft') return;

      const relPath = relative(this.vaultDir, filePath);

      // Build indexable text with metadata prefix
      const metaPrefix = [
        data.title && `Title: ${data.title}`,
        data.course && `Course: ${data.course}`,
        data.type && `Type: ${data.type}`,
        data.semester && `Semester: ${data.semester}`,
      ]
        .filter(Boolean)
        .join(' | ');

      const indexText = `[${metaPrefix}]\nSource: ${relPath}\n\n${content}`;

      await this.ragClient.index(indexText);
      log('rag', `Indexed: ${relPath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log('rag', `Index failed for ${filePath}: ${message}`);
    }
  }
}
```

Create `src/rag/indexer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RagIndexer } from './indexer.js';
import { RagClient } from './rag-client.js';

describe('RagIndexer', () => {
  it('constructs with vault dir and rag client', () => {
    const client = new RagClient({
      workingDir: '/tmp/rag',
      vaultDir: '/tmp/vault',
    });
    const indexer = new RagIndexer('/tmp/vault', client);
    expect(indexer).toBeDefined();
  });
});
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run src/rag/rag-client.test.ts src/rag/indexer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rag/rag-client.ts src/rag/rag-client.test.ts \
  src/rag/indexer.ts src/rag/indexer.test.ts
git commit -m "feat: add LightRAG client and vault indexer scaffolding"
```

---

## Task 19: Final Integration & Full Test Suite

**Files:**
- Modify: `src/index.ts` (add RAG indexer startup)
- Create: `.env.example` (update with all config)

- [ ] **Step 1: Update .env.example with all config variables**

Append to `.env.example`:

```bash
# universityClaw config
VAULT_DIR=./vault
UPLOAD_DIR=./upload
DASHBOARD_PORT=3100
# LIGHTRAG_WORKING_DIR=./store/rag  # Optional: LightRAG index location
```

- [ ] **Step 2: Add RAG indexer to main startup**

In `src/index.ts`, add alongside the ingestion pipeline startup:

```typescript
import { RagClient } from './rag/rag-client.js';
import { RagIndexer } from './rag/indexer.js';

// ... inside main(), after pipeline start:

// Start RAG indexer
const ragClient = new RagClient({
  workingDir: join(STORE_DIR, 'rag'),
  vaultDir: VAULT_DIR,
});
const ragIndexer = new RagIndexer(VAULT_DIR, ragClient);
await ragIndexer.start();

// ... add to graceful shutdown:
await ragIndexer.stop();
```

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 4: Build everything**

```bash
npm run build
cd dashboard && npm run build && cd ..
```

Expected: Both builds succeed with no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: complete universityClaw v1 — all components wired and tested"
```

---

## Summary

| Task | Component | Estimated Complexity |
|------|-----------|---------------------|
| 1 | Fork + project setup | Low |
| 2 | Telegram channel | Low (skill-driven) |
| 3 | Frontmatter module | Low |
| 4 | Wikilinks module | Low |
| 5 | VaultUtility class | Medium |
| 6 | Path parser + type mappings | Medium |
| 7 | Docling client | Medium |
| 8 | Database schema | Low |
| 9 | Review queue | Medium |
| 10 | File watcher | Low |
| 11 | Pipeline orchestrator | Medium |
| 12 | Wire pipeline to startup | Low |
| 13 | Agent CLAUDE.md | Low |
| 14 | Dashboard setup | Low |
| 15 | Dashboard review UI | Medium |
| 16 | Dashboard upload + vault | Medium |
| 17 | Student profile | Medium |
| 18 | RAG layer | Medium |
| 19 | Final integration | Low |
