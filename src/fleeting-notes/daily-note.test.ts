import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildDailyNoteSection,
  collectUnprocessedNotes,
  findDailyNoteFile,
  formatDailyNoteEntry,
  generateProposal,
  parseFrontmatter,
  updateDailyNote,
} from './daily-note.js';
import { clearRegistryCache } from './registry.js';
import type { FleetingNote, ProjectRegistryEntry } from './types.js';

let tmpDir: string;
let vaultPath: string;

function createRegistry(vaultDir: string): void {
  const registryDir = path.join(vaultDir, '1. Projects');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'registry.md'),
    `# Project Registry

## Chores
- **aliases:** chores, personal
- **vault:** \`1. Projects/Chores/\`
- **status:** active
- **routing:** @chores, @personal, insurance, pills

## NanoClaw
- **aliases:** nanoclaw, claw
- **vault:** \`1. Projects/AI Assistant/\`
- **status:** active
- **routing:** @nanoclaw, @claw
`,
  );
}

function makeNote(overrides: Partial<FleetingNote> = {}): FleetingNote {
  return {
    path: 'Fleeting/2026/03/07/test-note.md',
    slug: 'test-note',
    title: 'Test Note',
    body: '',
    source: 'things',
    thingsUuid: 'uuid-1',
    created: '2026-03-07',
    status: 'raw',
    ...overrides,
  };
}

function makeRegistry(): ProjectRegistryEntry[] {
  return [
    {
      name: 'Chores',
      aliases: ['chores', 'personal'],
      vault: '1. Projects/Chores/',
      status: 'active',
      routing: ['@chores', '@personal', 'insurance', 'pills'],
    },
    {
      name: 'NanoClaw',
      aliases: ['nanoclaw', 'claw'],
      vault: '1. Projects/AI Assistant/',
      status: 'active',
      routing: ['@nanoclaw', '@claw'],
    },
  ];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-note-test-'));
  vaultPath = path.join(tmpDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  createRegistry(vaultPath);
  clearRegistryCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('parses simple key: value pairs', () => {
    const content = '---\nstatus: raw\ncreated: 2026-03-07\n---\n# Title\n';
    const fm = parseFrontmatter(content);
    expect(fm).toEqual({ status: 'raw', created: '2026-03-07' });
  });

  it('returns null when no frontmatter', () => {
    expect(parseFrontmatter('# Just a heading\n')).toBeNull();
  });

  it('handles quoted values', () => {
    const content = '---\ntitle: "Hello World"\n---\n';
    const fm = parseFrontmatter(content);
    expect(fm?.title).toBe('Hello World');
  });

  it('handles underscored keys', () => {
    const content = '---\nthings_uuid: abc-123\n---\n';
    const fm = parseFrontmatter(content);
    expect(fm?.things_uuid).toBe('abc-123');
  });
});

describe('collectUnprocessedNotes', () => {
  it('collects notes with status: raw', () => {
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, 'test-note.md'),
      '---\nsource: things\ncreated: 2026-03-07\nthings_uuid: u1\nstatus: raw\n---\n\n# Test Note\n\nSome body text.\n',
    );

    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Test Note');
    expect(notes[0].body).toBe('Some body text.');
    expect(notes[0].status).toBe('raw');
    expect(notes[0].source).toBe('things');
  });

  it('skips notes with status: completed', () => {
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, 'done.md'),
      '---\nstatus: completed\ncreated: 2026-03-07\n---\n\n# Done\n',
    );

    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes).toHaveLength(0);
  });

  it('skips underscore-prefixed files', () => {
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, '_routing-session.md'),
      '---\nstatus: raw\n---\n\n# Session\n',
    );

    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes).toHaveLength(0);
  });

  it('returns empty array when no Fleeting directory', () => {
    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes).toHaveLength(0);
  });

  it('sorts by created date (oldest first)', () => {
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, 'newer.md'),
      '---\nstatus: raw\ncreated: 2026-03-07\n---\n\n# Newer\n',
    );
    fs.writeFileSync(
      path.join(noteDir, 'older.md'),
      '---\nstatus: raw\ncreated: 2026-03-01\n---\n\n# Older\n',
    );

    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe('Older');
    expect(notes[1].title).toBe('Newer');
  });

  it('extracts title from filename when no heading', () => {
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, 'no-heading.md'),
      '---\nstatus: raw\ncreated: 2026-03-07\n---\n\nJust some text.\n',
    );

    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes[0].title).toBe('no-heading');
  });

  it('detects project from frontmatter', () => {
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, 'with-project.md'),
      '---\nstatus: raw\ncreated: 2026-03-07\nproject: NanoClaw\n---\n\n# With Project\n',
    );

    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes[0].project).toBe('NanoClaw');
  });
});

describe('generateProposal', () => {
  const registry = makeRegistry();

  it('proposes literature note for URLs', () => {
    const note = makeNote({
      title: 'Check this article',
      body: 'https://example.com/article',
    });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('Literature note');
  });

  it('proposes #task for action items with project', () => {
    const note = makeNote({
      title: 'Reply to Pedro',
      project: 'Chores',
    });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('#task');
    expect(proposal.text).toContain('Chores');
  });

  it('proposes #task for action items without project', () => {
    const note = makeNote({ title: 'Send the invoice' });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('#task');
  });

  it('proposes permanent note for non-action with project', () => {
    const note = makeNote({
      title: 'Interesting observation about AI',
      body: 'The model seems to generalize well across domains.',
      project: 'NanoClaw',
    });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('Permanent note');
    expect(proposal.text).toContain('NanoClaw');
  });

  it('proposes idea log for unmatched notes', () => {
    const note = makeNote({
      title: 'Random thought',
      body: 'Something interesting.',
    });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('Idea log');
  });

  it('proposes retire for stale short items', () => {
    const note = makeNote({
      title: 'Old thing',
      body: '',
      created: '2020-01-01',
    });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('Retire');
  });

  it('proposes retire for test items', () => {
    const note = makeNote({ title: 'test', body: '' });
    const proposal = generateProposal(note, registry);
    expect(proposal.text).toContain('Retire');
    expect(proposal.text).toContain('test item');
  });

  it('includes project line in proposal', () => {
    const note = makeNote({ project: 'NanoClaw' });
    const proposal = generateProposal(note, registry);
    expect(proposal.projectLine).toContain('NanoClaw');
  });

  it('shows no project match when none found', () => {
    const note = makeNote({ title: 'Random', body: 'no match' });
    const proposal = generateProposal(note, registry);
    expect(proposal.projectLine).toBe('No project match.');
  });
});

describe('formatDailyNoteEntry', () => {
  const registry = makeRegistry();

  it('formats entry with title, date, and wiki link', () => {
    const note = makeNote({ title: 'Reply to Pedro', created: '2026-03-07' });
    const proposal = generateProposal(note, registry);
    const entry = formatDailyNoteEntry(1, note, proposal);

    expect(entry).toContain('1. **Reply to Pedro** (2026-03-07)');
    expect(entry).toContain('[[Fleeting/2026/03/07/test-note|f-note]]');
  });

  it('uses Notes label for short body (<=2 lines)', () => {
    const note = makeNote({ body: 'Short note body' });
    const proposal = generateProposal(note, registry);
    const entry = formatDailyNoteEntry(1, note, proposal);

    expect(entry).toContain('**Notes:**');
    expect(entry).not.toContain('**Summary:**');
  });

  it('uses Summary label for long body (>2 lines)', () => {
    const note = makeNote({
      body: 'Line one\nLine two\nLine three\nLine four',
    });
    const proposal = generateProposal(note, registry);
    const entry = formatDailyNoteEntry(1, note, proposal);

    expect(entry).toContain('**Summary:**');
    expect(entry).not.toContain('**Notes:**');
  });

  it('includes action controls', () => {
    const note = makeNote();
    const proposal = generateProposal(note, registry);
    const entry = formatDailyNoteEntry(1, note, proposal);

    expect(entry).toContain('- [ ] Accept');
    expect(entry).toContain('- [ ] Retire');
    expect(entry).toContain('**Chat:**');
    expect(entry).toContain('**Response:**');
  });

  it('includes proposed routing', () => {
    const note = makeNote({ title: 'Reply to someone', project: 'Chores' });
    const proposal = generateProposal(note, registry);
    const entry = formatDailyNoteEntry(1, note, proposal);

    expect(entry).toContain('**Proposed:**');
  });

  it('uses 4-space indentation for sub-items', () => {
    const note = makeNote({ body: 'Some notes' });
    const proposal = generateProposal(note, registry);
    const entry = formatDailyNoteEntry(1, note, proposal);

    const lines = entry.split('\n');
    // Lines after the first should start with 4 spaces
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^ {4}/);
    }
  });
});

describe('buildDailyNoteSection', () => {
  const registry = makeRegistry();

  it('includes fleeting-start and fleeting-end markers', () => {
    const section = buildDailyNoteSection([], registry);
    expect(section).toContain('<!-- fleeting-start -->');
    expect(section).toContain('<!-- fleeting-end -->');
  });

  it('shows "all processed" when no notes', () => {
    const section = buildDailyNoteSection([], registry);
    expect(section).toContain('all processed');
  });

  it('shows note count and source', () => {
    const notes = [
      makeNote({ source: 'things' }),
      makeNote({
        slug: 'note-2',
        path: 'Fleeting/2026/03/07/note-2.md',
        source: 'things',
      }),
    ];
    const section = buildDailyNoteSection(notes, registry);
    expect(section).toContain('Unprocessed (2 from things)');
  });

  it('lists multiple sources', () => {
    const notes = [
      makeNote({ source: 'things' }),
      makeNote({
        slug: 'tg-note',
        path: 'Fleeting/2026/03/07/tg-note.md',
        source: 'telegram',
      }),
    ];
    const section = buildDailyNoteSection(notes, registry);
    expect(section).toMatch(/from things, telegram|from telegram, things/);
  });

  it('includes Bulk Response line when notes exist', () => {
    const notes = [makeNote()];
    const section = buildDailyNoteSection(notes, registry);
    expect(section).toContain('**Bulk Response:**');
  });

  it('includes Routed section', () => {
    const section = buildDailyNoteSection([], registry);
    expect(section).toContain('### Routed');
  });

  it('includes date and time in heading', () => {
    const section = buildDailyNoteSection([], registry);
    expect(section).toMatch(/## Fleeting Notes \(appended \d{4}-\d{2}-\d{2}/);
  });
});

describe('findDailyNoteFile', () => {
  it('finds daily note by date prefix', () => {
    const date = new Date(2026, 2, 7); // March 7, 2026 (Saturday)
    const monthDir = path.join(
      vaultPath,
      '0a. Daily Notes',
      '2026',
      '03-March',
    );
    fs.mkdirSync(monthDir, { recursive: true });
    fs.writeFileSync(
      path.join(monthDir, '2026-03-07-Saturday.md'),
      '# Daily Note\n',
    );

    const result = findDailyNoteFile(vaultPath, date);
    expect(result).not.toBeNull();
    expect(result).toContain('2026-03-07-Saturday.md');
  });

  it('returns null when no matching file', () => {
    const date = new Date(2026, 2, 7);
    const monthDir = path.join(
      vaultPath,
      '0a. Daily Notes',
      '2026',
      '03-March',
    );
    fs.mkdirSync(monthDir, { recursive: true });

    const result = findDailyNoteFile(vaultPath, date);
    expect(result).toBeNull();
  });

  it('returns null when month directory missing', () => {
    const date = new Date(2026, 2, 7);
    const result = findDailyNoteFile(vaultPath, date);
    expect(result).toBeNull();
  });

  it('matches any day suffix in filename', () => {
    const date = new Date(2026, 0, 5); // January 5, 2026 (Monday)
    const monthDir = path.join(
      vaultPath,
      '0a. Daily Notes',
      '2026',
      '01-January',
    );
    fs.mkdirSync(monthDir, { recursive: true });
    fs.writeFileSync(
      path.join(monthDir, '2026-01-05-Monday.md'),
      '# Daily Note\n',
    );

    const result = findDailyNoteFile(vaultPath, date);
    expect(result).toContain('2026-01-05-Monday.md');
  });
});

describe('updateDailyNote', () => {
  function setupDailyNote(content: string): string {
    const now = new Date();
    const year = String(now.getFullYear());
    const monthNum = String(now.getMonth() + 1).padStart(2, '0');
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const monthName = months[now.getMonth()];
    const dayNum = String(now.getDate()).padStart(2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[now.getDay()];

    const monthDir = path.join(
      vaultPath,
      '0a. Daily Notes',
      year,
      `${monthNum}-${monthName}`,
    );
    fs.mkdirSync(monthDir, { recursive: true });
    const filePath = path.join(
      monthDir,
      `${year}-${monthNum}-${dayNum}-${dayName}.md`,
    );
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('appends section to daily note without markers', () => {
    const filePath = setupDailyNote('# Daily Note\n\nSome content here.');
    const section = '<!-- fleeting-start -->\n## Fleeting Notes\n<!-- fleeting-end -->';

    const result = updateDailyNote(vaultPath, section);
    expect(result).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('<!-- fleeting-start -->');
    expect(content).toContain('---\n\n<!-- fleeting-start -->');
  });

  it('replaces existing section between markers', () => {
    const filePath = setupDailyNote(
      '# Daily Note\n\n<!-- fleeting-start -->\nOLD CONTENT\n<!-- fleeting-end -->\n\nAfter section.',
    );
    const section = '<!-- fleeting-start -->\nNEW CONTENT\n<!-- fleeting-end -->';

    const result = updateDailyNote(vaultPath, section);
    expect(result).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('NEW CONTENT');
    expect(content).not.toContain('OLD CONTENT');
    expect(content).toContain('After section.');
  });

  it('returns false when no daily note exists', () => {
    const result = updateDailyNote(vaultPath, 'some section');
    expect(result).toBe(false);
  });

  it('preserves content before and after markers', () => {
    const filePath = setupDailyNote(
      'BEFORE\n<!-- fleeting-start -->\nMIDDLE\n<!-- fleeting-end -->\nAFTER',
    );
    const section = '<!-- fleeting-start -->\nREPLACED\n<!-- fleeting-end -->';

    updateDailyNote(vaultPath, section);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toBe('BEFORE\n<!-- fleeting-start -->\nREPLACED\n<!-- fleeting-end -->\nAFTER');
  });
});
