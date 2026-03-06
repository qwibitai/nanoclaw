import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  parseFrontmatter,
  serializeFrontmatter,
  readNoteFiles,
  syncToVault,
  generateDailyNotes,
  generateDashboard,
  enhanceProjectOverviews,
  VAULT_LAYOUT,
  PROJECT_VAULT_MAP,
  type SyncStats,
} from './obsidian-sync.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-sync-test-'));
}

function freshStats(): SyncStats {
  return { written: 0, unchanged: 0, removed: 0 };
}

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter from markdown', () => {
    const content = `---
type: fleeting
status: active
project: nanoclaw
tags: [idea, sync]
created: 2026-03-05
---
This is the body content.
`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.type).toBe('fleeting');
    expect(result!.frontmatter.status).toBe('active');
    expect(result!.frontmatter.project).toBe('nanoclaw');
    expect(result!.frontmatter.tags).toEqual(['idea', 'sync']);
    expect(result!.frontmatter.created).toBe('2026-03-05');
    expect(result!.body.trim()).toBe('This is the body content.');
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('Just plain text')).toBeNull();
    expect(parseFrontmatter('# Heading\nSome content')).toBeNull();
  });

  it('handles empty tags array', () => {
    const content = `---
type: fleeting
tags: []
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result!.frontmatter.tags).toEqual([]);
  });

  it('handles quoted values with colons', () => {
    const content = `---
type: fleeting
source: "telegram:173091851"
---
Body.
`;
    const result = parseFrontmatter(content);
    expect(result!.frontmatter.source).toBe('telegram:173091851');
  });
});

describe('serializeFrontmatter', () => {
  it('serializes frontmatter and body to markdown', () => {
    const fm = { type: 'fleeting', status: 'active', project: 'nanoclaw' };
    const body = '\nThis is the body.\n';
    const result = serializeFrontmatter(fm, body);

    expect(result).toContain('---\ntype: fleeting');
    expect(result).toContain('status: active');
    expect(result).toContain('project: nanoclaw');
    expect(result).toContain('---\n\nThis is the body.\n');
  });

  it('serializes tags as arrays', () => {
    const fm = { type: 'fleeting', tags: ['idea', 'sync'] };
    const result = serializeFrontmatter(fm, '\n');
    expect(result).toContain('tags: [idea, sync]');
  });

  it('quotes values containing colons', () => {
    const fm = { type: 'fleeting', source: 'telegram:173091851' };
    const result = serializeFrontmatter(fm, '\n');
    expect(result).toContain('source: "telegram:173091851"');
  });

  it('skips null/undefined values', () => {
    const fm = { type: 'fleeting', status: undefined, project: null } as any;
    const result = serializeFrontmatter(fm, '\n');
    expect(result).not.toContain('status');
    expect(result).not.toContain('project');
  });
});

describe('readNoteFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads all .md files with frontmatter from a directory', () => {
    fs.writeFileSync(
      path.join(tmpDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\n---\nTest note.\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '2026-03-05-002-another.md'),
      '---\ntype: fleeting\nstatus: active\n---\nAnother note.\n',
    );

    const notes = readNoteFiles(tmpDir);
    expect(notes).toHaveLength(2);
    expect(notes[0].filename).toBe('2026-03-05-001-test.md');
    expect(notes[1].filename).toBe('2026-03-05-002-another.md');
  });

  it('skips files without frontmatter', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'valid.md'),
      '---\ntype: fleeting\n---\nContent.\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'plain.md'),
      '# Just a heading\nNo frontmatter.\n',
    );

    const notes = readNoteFiles(tmpDir);
    expect(notes).toHaveLength(1);
    expect(notes[0].filename).toBe('valid.md');
  });

  it('returns empty array for nonexistent directory', () => {
    expect(readNoteFiles('/nonexistent/path')).toEqual([]);
  });
});

describe('syncToVault', () => {
  let exoDir: string;
  let vaultDir: string;

  beforeEach(() => {
    exoDir = createTempDir();
    vaultDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(exoDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('syncs fleeting notes to vault Resources/Exocortex/Fleeting/', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nFix the duplicate ingestion bug.\n',
    );

    const stats = syncToVault(exoDir, vaultDir);

    expect(stats.written).toBeGreaterThan(0);
    const vaultFile = path.join(vaultDir, VAULT_LAYOUT.fleeting, '2026-03-05-001-test.md');
    expect(fs.existsSync(vaultFile)).toBe(true);
    const content = fs.readFileSync(vaultFile, 'utf-8');
    expect(content).toContain('type: fleeting');
    expect(content).toContain('Fix the duplicate ingestion bug.');
  });

  it('syncs permanent notes to vault Resources/Exocortex/Notes/', () => {
    const notesDir = path.join(exoDir, 'notes');
    fs.mkdirSync(notesDir);
    fs.writeFileSync(
      path.join(notesDir, 'agent-goal-context.md'),
      '---\ntype: permanent\ntags: [architecture, agents]\n---\nAgents need goal awareness.\n',
    );

    syncToVault(exoDir, vaultDir);

    const vaultFile = path.join(vaultDir, VAULT_LAYOUT.notes, 'agent-goal-context.md');
    expect(fs.existsSync(vaultFile)).toBe(true);
    const content = fs.readFileSync(vaultFile, 'utf-8');
    expect(content).toContain('type: permanent');
  });

  it('syncs nanoclaw project files to 1. Projects/AI Assistant/', () => {
    const ncDir = path.join(exoDir, 'nanoclaw');
    fs.mkdirSync(ncDir, { recursive: true });
    fs.writeFileSync(path.join(ncDir, 'goals.md'), '# Goals\n- H1: Automation\n');
    fs.writeFileSync(path.join(ncDir, 'todo.md'), '# Todo\n- Fix sync\n');

    syncToVault(exoDir, vaultDir);

    const aiAssistantDir = path.join(vaultDir, PROJECT_VAULT_MAP.nanoclaw);
    expect(fs.existsSync(path.join(aiAssistantDir, 'goals.md'))).toBe(true);
    expect(fs.existsSync(path.join(aiAssistantDir, 'todo.md'))).toBe(true);
  });

  it('syncs onto project to 1. Projects/AI Finance/', () => {
    const ontoDir = path.join(exoDir, 'projects', 'onto');
    fs.mkdirSync(ontoDir, { recursive: true });
    fs.writeFileSync(path.join(ontoDir, 'goals.md'), '# Goals\n- Research\n');

    syncToVault(exoDir, vaultDir);

    const aiFinanceDir = path.join(vaultDir, PROJECT_VAULT_MAP.onto);
    expect(fs.existsSync(path.join(aiFinanceDir, 'goals.md'))).toBe(true);
  });

  it('syncs unmapped projects to 1. Projects/{name}/', () => {
    const newProjDir = path.join(exoDir, 'projects', 'newproject');
    fs.mkdirSync(newProjDir, { recursive: true });
    fs.writeFileSync(path.join(newProjDir, 'goals.md'), '# Goals\n');

    syncToVault(exoDir, vaultDir);

    expect(fs.existsSync(path.join(vaultDir, '1. Projects', 'newproject', 'goals.md'))).toBe(true);
  });

  it('skips _template directory', () => {
    const templateDir = path.join(exoDir, 'projects', '_template');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(path.join(templateDir, 'goals.md'), '# Goals\n');

    syncToVault(exoDir, vaultDir);

    expect(fs.existsSync(path.join(vaultDir, '1. Projects', '_template'))).toBe(false);
  });

  it('removes orphaned files from vault', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, 'keep.md'),
      '---\ntype: fleeting\n---\nKeep this.\n',
    );
    fs.writeFileSync(
      path.join(fleetingDir, 'remove.md'),
      '---\ntype: fleeting\n---\nRemove this.\n',
    );

    syncToVault(exoDir, vaultDir);
    expect(fs.existsSync(path.join(vaultDir, VAULT_LAYOUT.fleeting, 'remove.md'))).toBe(true);

    fs.unlinkSync(path.join(fleetingDir, 'remove.md'));

    const stats = syncToVault(exoDir, vaultDir);
    expect(stats.removed).toBe(1);
    expect(fs.existsSync(path.join(vaultDir, VAULT_LAYOUT.fleeting, 'remove.md'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, VAULT_LAYOUT.fleeting, 'keep.md'))).toBe(true);
  });

  it('syncs soul.md to vault root', () => {
    fs.writeFileSync(path.join(exoDir, 'soul.md'), '# Soul\nFounding philosophy.\n');

    syncToVault(exoDir, vaultDir);

    expect(fs.existsSync(path.join(vaultDir, 'soul.md'))).toBe(true);
    expect(fs.readFileSync(path.join(vaultDir, 'soul.md'), 'utf-8')).toContain('Founding philosophy.');
  });

  it('handles empty exocortex gracefully', () => {
    const stats = syncToVault(exoDir, vaultDir);
    expect(stats.removed).toBe(0);
  });

  it('syncs tags.md to vault Tags.md', () => {
    fs.writeFileSync(
      path.join(exoDir, 'tags.md'),
      '# Tag Registry\n\n## Domain Tags\n- `architecture` — System design\n',
    );

    syncToVault(exoDir, vaultDir);

    expect(fs.existsSync(path.join(vaultDir, 'Tags.md'))).toBe(true);
    const content = fs.readFileSync(path.join(vaultDir, 'Tags.md'), 'utf-8');
    expect(content).toContain('Tag Registry');
    expect(content).toContain('architecture');
  });

  it('syncs plans directory to vault Resources/Exocortex/Plans/', () => {
    const plansDir = path.join(exoDir, 'plans');
    fs.mkdirSync(plansDir);
    fs.writeFileSync(
      path.join(plansDir, 'zettelkasten-obsidian-integration.md'),
      '---\ntype: plan\nstatus: in-progress\nproject: nanoclaw\n---\n# Zettelkasten + Obsidian\n',
    );

    syncToVault(exoDir, vaultDir);

    const vaultFile = path.join(vaultDir, VAULT_LAYOUT.plans, 'zettelkasten-obsidian-integration.md');
    expect(fs.existsSync(vaultFile)).toBe(true);
    const content = fs.readFileSync(vaultFile, 'utf-8');
    expect(content).toContain('Zettelkasten + Obsidian');
  });

  it('removes orphaned plan files from vault', () => {
    const plansDir = path.join(exoDir, 'plans');
    fs.mkdirSync(plansDir);
    fs.writeFileSync(path.join(plansDir, 'keep.md'), '# Keep\n');
    fs.writeFileSync(path.join(plansDir, 'remove.md'), '# Remove\n');

    syncToVault(exoDir, vaultDir);
    expect(fs.existsSync(path.join(vaultDir, VAULT_LAYOUT.plans, 'remove.md'))).toBe(true);

    fs.unlinkSync(path.join(plansDir, 'remove.md'));
    const stats = syncToVault(exoDir, vaultDir);
    expect(stats.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(vaultDir, VAULT_LAYOUT.plans, 'remove.md'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, VAULT_LAYOUT.plans, 'keep.md'))).toBe(true);
  });
});

describe('generateDailyNotes', () => {
  let exoDir: string;
  let vaultDir: string;

  beforeEach(() => {
    exoDir = createTempDir();
    vaultDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(exoDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function createDailyNote(vault: string, date: string, content: string): string {
    const [year, monthNum, day] = date.split('-');
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const monthName = monthNames[parseInt(monthNum, 10) - 1];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[new Date(`${date}T12:00:00`).getDay()];
    const dir = path.join(vault, VAULT_LAYOUT.dailyNotes, year, `${monthNum}-${monthName}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${date}-${dayName}.md`);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('appends exocortex section to existing daily note', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: general\nsource: things\n---\nTest.\n',
    );

    const dailyPath = createDailyNote(vaultDir, '2026-03-05', '# Thursday\n\nJournal entry.\n');

    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('# Thursday');
    expect(content).toContain('Journal entry.');
    expect(content).toContain('<!-- exocortex-start -->');
    expect(content).toContain('## Exocortex');
    expect(content).toContain('[[2026-03-05-001-test]]');
    expect(content).toContain('<!-- exocortex-end -->');
  });

  it('uses filename-only wiki-links (no path prefix)', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nTest.\n',
    );

    createDailyNote(vaultDir, '2026-03-05', '# Thursday\n');

    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    const dailyPath = path.join(
      vaultDir,
      VAULT_LAYOUT.dailyNotes,
      '2026',
      '03-March',
      '2026-03-05-Thursday.md',
    );
    const content = fs.readFileSync(dailyPath, 'utf-8');
    // Should NOT contain path-prefixed links
    expect(content).not.toContain('[[Fleeting/');
    expect(content).toContain('[[2026-03-05-001-test]]');
  });

  it('skips dates with no existing daily note file', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-03-001-idea.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nAn idea.\n',
    );

    // No daily note exists for 2026-03-03
    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    expect(stats.written).toBe(0);
  });

  it('replaces existing exocortex section on re-sync', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: general\n---\nTest.\n',
    );

    const dailyPath = createDailyNote(vaultDir, '2026-03-05', '# Thursday\n');

    // First sync
    const stats1 = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats1);
    expect(stats1.written).toBe(1);

    // Add another note
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-002-new.md'),
      '---\ntype: fleeting\nstatus: active\nproject: general\n---\nNew.\n',
    );

    // Second sync — should replace section
    const stats2 = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats2);
    expect(stats2.written).toBe(1);

    const content = fs.readFileSync(dailyPath, 'utf-8');
    // Should have both notes
    expect(content).toContain('[[2026-03-05-001-test]]');
    expect(content).toContain('[[2026-03-05-002-new]]');
    // Should only have one exocortex section
    const startCount = (content.match(/<!-- exocortex-start -->/g) || []).length;
    expect(startCount).toBe(1);
  });

  it('preserves existing daily note content when appending', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: general\n---\nTest.\n',
    );

    const existingContent = '---\ndate: 2026-03-05\n---\n# Thursday\n\n## Journal\n\nHad a great day.\n\n## Tasks\n\n- [x] Did something\n';
    const dailyPath = createDailyNote(vaultDir, '2026-03-05', existingContent);

    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('Had a great day.');
    expect(content).toContain('Did something');
    expect(content).toContain('## Exocortex');
  });

  it('includes triaged notes', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-triaged.md'),
      '---\ntype: fleeting\nstatus: incorporated\nproject: nanoclaw\n---\nTriaged note.\n',
    );

    createDailyNote(vaultDir, '2026-03-05', '# Thursday\n');

    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    const dailyPath = path.join(
      vaultDir,
      VAULT_LAYOUT.dailyNotes,
      '2026',
      '03-March',
      '2026-03-05-Thursday.md',
    );
    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('### Triaged');
  });

  it('includes permanent notes created on that date', () => {
    const notesDir = path.join(exoDir, 'notes');
    fs.mkdirSync(notesDir);
    fs.writeFileSync(
      path.join(notesDir, 'zero-touch-email.md'),
      '---\ntype: permanent\nproject: nanoclaw\ncreated: 2026-03-05\n---\nEmail processing.\n',
    );

    createDailyNote(vaultDir, '2026-03-05', '# Thursday\n');

    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    const dailyPath = path.join(
      vaultDir,
      VAULT_LAYOUT.dailyNotes,
      '2026',
      '03-March',
      '2026-03-05-Thursday.md',
    );
    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('### Notes Created');
    expect(content).toContain('[[zero-touch-email]]');
  });

  it('does not generate daily notes for empty exocortex', () => {
    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);
    expect(stats.written).toBe(0);
  });

  it('includes project activity section', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-nc.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nNC note.\n',
    );
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-002-nc2.md'),
      '---\ntype: fleeting\nstatus: incorporated\nproject: nanoclaw\n---\nNC triaged.\n',
    );

    createDailyNote(vaultDir, '2026-03-05', '# Thursday\n');

    const stats = freshStats();
    generateDailyNotes(exoDir, vaultDir, stats);

    const dailyPath = path.join(
      vaultDir,
      VAULT_LAYOUT.dailyNotes,
      '2026',
      '03-March',
      '2026-03-05-Thursday.md',
    );
    const content = fs.readFileSync(dailyPath, 'utf-8');
    expect(content).toContain('### Project Activity');
    expect(content).toContain('**nanoclaw**');
    expect(content).toContain('2 captures');
    expect(content).toContain('1 triaged');
  });
});

describe('generateDashboard', () => {
  let exoDir: string;
  let vaultDir: string;

  beforeEach(() => {
    exoDir = createTempDir();
    vaultDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(exoDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('generates dashboard with project counts and inbox pressure', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nTest.\n',
    );
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-002-retired.md'),
      '---\ntype: fleeting\nstatus: retired\nproject: general\n---\nRetired.\n',
    );

    const ncDir = path.join(exoDir, 'nanoclaw');
    fs.mkdirSync(ncDir, { recursive: true });
    fs.writeFileSync(path.join(ncDir, 'overview.md'), '# NanoClaw Overview\n');

    const stats = freshStats();
    generateDashboard(exoDir, vaultDir, stats);

    expect(fs.existsSync(path.join(vaultDir, 'Home.md'))).toBe(true);
    const content = fs.readFileSync(path.join(vaultDir, 'Home.md'), 'utf-8');
    expect(content).toContain('# Exocortex Dashboard');
    expect(content).toContain('## Inbox Pressure');
    expect(content).toContain('**Active fleeting notes:** 1');
    expect(content).toContain('**Retired:** 1');
    expect(content).toContain('## Active Projects');
    // Uses filename-only link with display alias
    expect(content).toContain('[[overview|nanoclaw overview]]');
  });

  it('dashboard uses filename-only links for recent notes', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nTest.\n',
    );
    const notesDir = path.join(exoDir, 'notes');
    fs.mkdirSync(notesDir);
    fs.writeFileSync(
      path.join(notesDir, 'some-insight.md'),
      '---\ntype: permanent\nproject: nanoclaw\n---\nInsight.\n',
    );

    fs.mkdirSync(path.join(exoDir, 'nanoclaw'), { recursive: true });

    const stats = freshStats();
    generateDashboard(exoDir, vaultDir, stats);

    const content = fs.readFileSync(path.join(vaultDir, 'Home.md'), 'utf-8');
    expect(content).toContain('## Recent Notes');
    // Filename-only links
    expect(content).toContain('[[2026-03-05-001-test]]');
    expect(content).toContain('[[some-insight]]');
    // Should NOT contain path-prefixed links
    expect(content).not.toContain('[[Fleeting/');
    expect(content).not.toContain('[[Notes/');
  });

  it('dashboard shows tag cloud from all notes', () => {
    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\ntags: [email, sync]\n---\nTest.\n',
    );
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-002-test2.md'),
      '---\ntype: fleeting\nstatus: active\ntags: [email, idea]\n---\nTest2.\n',
    );

    fs.mkdirSync(path.join(exoDir, 'nanoclaw'), { recursive: true });

    const stats = freshStats();
    generateDashboard(exoDir, vaultDir, stats);

    const content = fs.readFileSync(path.join(vaultDir, 'Home.md'), 'utf-8');
    expect(content).toContain('## Tag Cloud');
    expect(content).toContain('email (2)');
    expect(content).toContain('sync (1)');
    expect(content).toContain('idea (1)');
  });

  it('handles empty exocortex (still generates dashboard)', () => {
    fs.mkdirSync(path.join(exoDir, 'nanoclaw'), { recursive: true });

    const stats = freshStats();
    generateDashboard(exoDir, vaultDir, stats);

    expect(fs.existsSync(path.join(vaultDir, 'Home.md'))).toBe(true);
    const content = fs.readFileSync(path.join(vaultDir, 'Home.md'), 'utf-8');
    expect(content).toContain('**Active fleeting notes:** 0');
  });

  it('dashboard includes soul and Tags links', () => {
    fs.mkdirSync(path.join(exoDir, 'nanoclaw'), { recursive: true });

    const stats = freshStats();
    generateDashboard(exoDir, vaultDir, stats);

    const content = fs.readFileSync(path.join(vaultDir, 'Home.md'), 'utf-8');
    expect(content).toContain('[[soul]]');
    expect(content).toContain('[[Tags]]');
  });
});

describe('enhanceProjectOverviews', () => {
  let exoDir: string;
  let vaultDir: string;

  beforeEach(() => {
    exoDir = createTempDir();
    vaultDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(exoDir, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('enhances project overview with filename-only wiki-links', () => {
    const ncDir = path.join(exoDir, 'nanoclaw');
    fs.mkdirSync(ncDir, { recursive: true });
    fs.writeFileSync(path.join(ncDir, 'overview.md'), '# NanoClaw Overview\n\nMain project.\n');
    fs.writeFileSync(path.join(ncDir, 'goals.md'), '# Goals\n');
    fs.writeFileSync(path.join(ncDir, 'todo.md'), '# Todo\n');

    const fleetingDir = path.join(exoDir, 'fleeting');
    fs.mkdirSync(fleetingDir);
    fs.writeFileSync(
      path.join(fleetingDir, '2026-03-05-001-test.md'),
      '---\ntype: fleeting\nstatus: active\nproject: nanoclaw\n---\nTest.\n',
    );

    const notesDir = path.join(exoDir, 'notes');
    fs.mkdirSync(notesDir);
    fs.writeFileSync(
      path.join(notesDir, 'some-insight.md'),
      '---\ntype: permanent\nproject: nanoclaw\n---\nInsight.\n',
    );

    const plansDir = path.join(exoDir, 'plans');
    fs.mkdirSync(plansDir);
    fs.writeFileSync(
      path.join(plansDir, 'zettelkasten.md'),
      '---\ntype: plan\nproject: nanoclaw\n---\n# Plan\n',
    );

    // Vault project dir uses PARA mapping
    const vaultProjectDir = path.join(vaultDir, PROJECT_VAULT_MAP.nanoclaw);
    fs.mkdirSync(vaultProjectDir, { recursive: true });

    const stats = freshStats();
    enhanceProjectOverviews(exoDir, vaultDir, stats);

    const overview = fs.readFileSync(
      path.join(vaultProjectDir, 'overview.md'),
      'utf-8',
    );
    expect(overview).toContain('# NanoClaw Overview');
    expect(overview).toContain('## Vault Links (computed)');
    // Filename-only links
    expect(overview).toContain('[[2026-03-05-001-test]]');
    expect(overview).toContain('[[some-insight]]');
    expect(overview).toContain('[[zettelkasten]]');
    // Related files use display aliases
    expect(overview).toContain('[[goals|nanoclaw goals]]');
    expect(overview).toContain('[[todo|nanoclaw todo]]');
    // Should NOT contain path-prefixed links
    expect(overview).not.toContain('[[Fleeting/');
    expect(overview).not.toContain('[[Notes/');
    expect(overview).not.toContain('[[Plans/');
    expect(overview).not.toContain('[[Projects/');
  });

  it('writes enhanced overview to PARA-mapped project dir', () => {
    const ncDir = path.join(exoDir, 'nanoclaw');
    fs.mkdirSync(ncDir, { recursive: true });
    fs.writeFileSync(path.join(ncDir, 'overview.md'), '# Overview\n');

    const stats = freshStats();
    enhanceProjectOverviews(exoDir, vaultDir, stats);

    // Should be in 1. Projects/AI Assistant/, not Projects/nanoclaw/
    expect(fs.existsSync(path.join(vaultDir, PROJECT_VAULT_MAP.nanoclaw, 'overview.md'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'Projects', 'nanoclaw', 'overview.md'))).toBe(false);
  });

  it('handles projects with no notes gracefully', () => {
    const ncDir = path.join(exoDir, 'nanoclaw');
    fs.mkdirSync(ncDir, { recursive: true });
    fs.writeFileSync(path.join(ncDir, 'overview.md'), '# Overview\n');

    const stats = freshStats();
    enhanceProjectOverviews(exoDir, vaultDir, stats);

    const overview = fs.readFileSync(
      path.join(vaultDir, PROJECT_VAULT_MAP.nanoclaw, 'overview.md'),
      'utf-8',
    );
    expect(overview).toContain('# Overview');
    expect(overview).toContain('## Vault Links (computed)');
  });
});
