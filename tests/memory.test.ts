import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_BASE = '/tmp/nanoclaw-test-memory';
const TEST_GROUPS_DIR = path.join(TEST_BASE, 'groups');

vi.mock('../src/config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-memory/groups',
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { MemoryStore } from '../src/memory.js';

/** Helper: today's date string in YYYY-MM-DD format */
function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

/** Helper: date string N days ago */
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Wipe the entire test tree before every test so state never leaks.
  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_BASE)) {
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Constructor
// ---------------------------------------------------------------------------

describe('MemoryStore constructor', () => {
  it('creates the memory directory on construction', () => {
    const store = new MemoryStore('test-group');
    const expected = path.join(TEST_GROUPS_DIR, 'test-group', 'memory');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });

  it('does not throw if the directory already exists', () => {
    const memDir = path.join(TEST_GROUPS_DIR, 'existing-group', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    expect(() => new MemoryStore('existing-group')).not.toThrow();
  });

  it('creates nested path when group folder has no parent yet', () => {
    const store = new MemoryStore('brand-new');
    const expected = path.join(TEST_GROUPS_DIR, 'brand-new', 'memory');
    expect(fs.existsSync(expected)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. readLongTerm / writeLongTerm
// ---------------------------------------------------------------------------

describe('readLongTerm / writeLongTerm', () => {
  it('returns empty string when MEMORY.md does not exist', () => {
    const store = new MemoryStore('lt-read');
    expect(store.readLongTerm()).toBe('');
  });

  it('writes and reads back long-term memory', () => {
    const store = new MemoryStore('lt-roundtrip');
    store.writeLongTerm('User prefers dark mode.');
    expect(store.readLongTerm()).toBe('User prefers dark mode.');
  });

  it('overwrites previous long-term memory on second write', () => {
    const store = new MemoryStore('lt-overwrite');
    store.writeLongTerm('first');
    store.writeLongTerm('second');
    expect(store.readLongTerm()).toBe('second');
  });

  it('handles multi-line content', () => {
    const store = new MemoryStore('lt-multiline');
    const content = '# Preferences\n- Dark mode\n- Vim keybindings\n';
    store.writeLongTerm(content);
    expect(store.readLongTerm()).toBe(content);
  });

  it('handles empty string write', () => {
    const store = new MemoryStore('lt-empty');
    store.writeLongTerm('');
    // File exists but content is empty string
    expect(store.readLongTerm()).toBe('');
  });

  it('persists to MEMORY.md on disk', () => {
    const store = new MemoryStore('lt-disk');
    store.writeLongTerm('persistent');
    const filePath = path.join(
      TEST_GROUPS_DIR,
      'lt-disk',
      'memory',
      'MEMORY.md',
    );
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('persistent');
  });
});

// ---------------------------------------------------------------------------
// 3. readToday / appendToday
// ---------------------------------------------------------------------------

describe('readToday / appendToday', () => {
  it('returns empty string when today file does not exist', () => {
    const store = new MemoryStore('daily-empty');
    expect(store.readToday()).toBe('');
  });

  it('appends and reads back today note', () => {
    const store = new MemoryStore('daily-append');
    store.appendToday('Morning standup completed.');
    expect(store.readToday()).toBe('Morning standup completed.');
  });

  it('joins multiple appends with newlines', () => {
    const store = new MemoryStore('daily-multi');
    store.appendToday('Line one');
    store.appendToday('Line two');
    store.appendToday('Line three');
    expect(store.readToday()).toBe('Line one\nLine two\nLine three');
  });

  it('writes to a file named after today date', () => {
    const store = new MemoryStore('daily-filename');
    store.appendToday('check filename');
    const expectedFile = path.join(
      TEST_GROUPS_DIR,
      'daily-filename',
      'memory',
      `${todayStr()}.md`,
    );
    expect(fs.existsSync(expectedFile)).toBe(true);
  });

  it('handles empty string append gracefully', () => {
    const store = new MemoryStore('daily-empty-append');
    store.appendToday('');
    // Empty string is still written as the first entry
    expect(store.readToday()).toBe('');
  });

  it('appending to existing empty note produces just the new content', () => {
    const store = new MemoryStore('daily-empty-then-add');
    store.appendToday('');
    store.appendToday('real note');
    // First append wrote '', second sees existing '' (truthy is false for empty string)
    // empty string is falsy, so `existing ? ...` path won't prepend
    // Result: 'real note'
    expect(store.readToday()).toBe('real note');
  });
});

// ---------------------------------------------------------------------------
// 4. getRecentMemories
// ---------------------------------------------------------------------------

describe('getRecentMemories', () => {
  it('returns empty string when there is no memory at all', () => {
    const store = new MemoryStore('recent-none');
    expect(store.getRecentMemories()).toBe('');
  });

  it('includes long-term memory when present', () => {
    const store = new MemoryStore('recent-lt');
    store.writeLongTerm('Long-term fact');
    const result = store.getRecentMemories();
    expect(result).toContain('## Long-term Memory');
    expect(result).toContain('Long-term fact');
  });

  it('includes today daily note', () => {
    const store = new MemoryStore('recent-today');
    store.appendToday('Did something today');
    const result = store.getRecentMemories();
    expect(result).toContain(`## Notes from ${todayStr()}`);
    expect(result).toContain('Did something today');
  });

  it('combines long-term and daily notes with separator', () => {
    const store = new MemoryStore('recent-combined');
    store.writeLongTerm('Important fact');
    store.appendToday('Daily observation');

    const result = store.getRecentMemories();
    expect(result).toContain('## Long-term Memory');
    expect(result).toContain('Important fact');
    expect(result).toContain('---');
    expect(result).toContain(`## Notes from ${todayStr()}`);
    expect(result).toContain('Daily observation');
  });

  it('picks up daily notes from past days within range', () => {
    const store = new MemoryStore('recent-past');
    // Manually create a file for 2 days ago
    const twoDaysAgo = daysAgoStr(2);
    const memDir = path.join(TEST_GROUPS_DIR, 'recent-past', 'memory');
    fs.writeFileSync(
      path.join(memDir, `${twoDaysAgo}.md`),
      'Note from two days ago',
      'utf-8',
    );

    const result = store.getRecentMemories(7);
    expect(result).toContain(`## Notes from ${twoDaysAgo}`);
    expect(result).toContain('Note from two days ago');
  });

  it('excludes daily notes outside the requested range', () => {
    const store = new MemoryStore('recent-range');
    // Create a note 10 days ago
    const tenDaysAgo = daysAgoStr(10);
    const memDir = path.join(TEST_GROUPS_DIR, 'recent-range', 'memory');
    fs.writeFileSync(
      path.join(memDir, `${tenDaysAgo}.md`),
      'Old note',
      'utf-8',
    );

    const result = store.getRecentMemories(3);
    expect(result).not.toContain('Old note');
  });

  it('skips daily note files that are empty or whitespace-only', () => {
    const store = new MemoryStore('recent-whitespace');
    const yesterday = daysAgoStr(1);
    const memDir = path.join(TEST_GROUPS_DIR, 'recent-whitespace', 'memory');
    fs.writeFileSync(path.join(memDir, `${yesterday}.md`), '   \n  ', 'utf-8');

    const result = store.getRecentMemories(7);
    expect(result).not.toContain(`## Notes from ${yesterday}`);
  });

  it('defaults to 7 days when no argument is passed', () => {
    const store = new MemoryStore('recent-default');
    // Create notes for days 0 through 8
    const memDir = path.join(TEST_GROUPS_DIR, 'recent-default', 'memory');
    for (let i = 0; i <= 8; i++) {
      const dateStr = daysAgoStr(i);
      fs.writeFileSync(
        path.join(memDir, `${dateStr}.md`),
        `Note day -${i}`,
        'utf-8',
      );
    }

    const result = store.getRecentMemories();
    // Days 0-6 should be included (7 total), day 7 and 8 excluded
    expect(result).toContain(`Note day -0`);
    expect(result).toContain(`Note day -6`);
    expect(result).not.toContain(`Note day -7`);
    expect(result).not.toContain(`Note day -8`);
  });

  it('returns only long-term memory when no daily notes exist', () => {
    const store = new MemoryStore('recent-lt-only');
    store.writeLongTerm('Only fact');
    const result = store.getRecentMemories();
    expect(result).toBe('## Long-term Memory\nOnly fact');
    // No separator because there is only one part
    expect(result).not.toContain('---');
  });
});

// ---------------------------------------------------------------------------
// 5. getGroupContext
// ---------------------------------------------------------------------------

describe('getGroupContext', () => {
  it('returns empty string when CLAUDE.md does not exist', () => {
    const store = new MemoryStore('ctx-none');
    expect(store.getGroupContext()).toBe('');
  });

  it('reads CLAUDE.md from the group folder', () => {
    const groupDir = path.join(TEST_GROUPS_DIR, 'ctx-exists');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'CLAUDE.md'),
      '# Group Rules\nBe polite.',
      'utf-8',
    );

    const store = new MemoryStore('ctx-exists');
    expect(store.getGroupContext()).toBe('# Group Rules\nBe polite.');
  });

  it('returns empty string when CLAUDE.md is empty', () => {
    const groupDir = path.join(TEST_GROUPS_DIR, 'ctx-empty');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '', 'utf-8');

    const store = new MemoryStore('ctx-empty');
    expect(store.getGroupContext()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. MemoryStore.getGlobalContext (static)
// ---------------------------------------------------------------------------

describe('MemoryStore.getGlobalContext', () => {
  it('returns empty string when global CLAUDE.md does not exist', () => {
    expect(MemoryStore.getGlobalContext()).toBe('');
  });

  it('reads global CLAUDE.md from GROUPS_DIR/global/', () => {
    const globalDir = path.join(TEST_GROUPS_DIR, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'CLAUDE.md'),
      '# Global Context\nAll groups see this.',
      'utf-8',
    );

    expect(MemoryStore.getGlobalContext()).toBe(
      '# Global Context\nAll groups see this.',
    );
  });

  it('returns empty string when global CLAUDE.md is empty', () => {
    const globalDir = path.join(TEST_GROUPS_DIR, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'CLAUDE.md'), '', 'utf-8');

    expect(MemoryStore.getGlobalContext()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('separate MemoryStore instances for different groups are isolated', () => {
    const storeA = new MemoryStore('group-a');
    const storeB = new MemoryStore('group-b');

    storeA.writeLongTerm('Secret A');
    storeB.writeLongTerm('Secret B');

    expect(storeA.readLongTerm()).toBe('Secret A');
    expect(storeB.readLongTerm()).toBe('Secret B');
  });

  it('two instances for the same group share the same underlying files', () => {
    const store1 = new MemoryStore('shared');
    const store2 = new MemoryStore('shared');

    store1.writeLongTerm('Written by store1');
    expect(store2.readLongTerm()).toBe('Written by store1');
  });

  it('handles unicode content correctly', () => {
    const store = new MemoryStore('unicode');
    const content = 'Emoji test: \u{1F680}\u{1F30D}\u{2728} | CJK: \u4F60\u597D | Arabic: \u0645\u0631\u062D\u0628\u0627';
    store.writeLongTerm(content);
    expect(store.readLongTerm()).toBe(content);
  });

  it('handles very large content', () => {
    const store = new MemoryStore('large');
    const largeContent = 'x'.repeat(100_000);
    store.writeLongTerm(largeContent);
    expect(store.readLongTerm()).toBe(largeContent);
    expect(store.readLongTerm().length).toBe(100_000);
  });

  it('appendToday with many sequential appends builds correct content', () => {
    const store = new MemoryStore('many-appends');
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) {
      const line = `Entry ${i}`;
      store.appendToday(line);
      lines.push(line);
    }
    expect(store.readToday()).toBe(lines.join('\n'));
  });

  it('getRecentMemories with days=0 returns only long-term memory', () => {
    const store = new MemoryStore('zero-days');
    store.writeLongTerm('LT only');
    store.appendToday('Should not appear');

    const result = store.getRecentMemories(0);
    expect(result).toContain('LT only');
    expect(result).not.toContain('Should not appear');
  });

  it('getRecentMemories with days=1 returns only today', () => {
    const store = new MemoryStore('one-day');
    store.appendToday('Today only');

    // Create yesterday note
    const memDir = path.join(TEST_GROUPS_DIR, 'one-day', 'memory');
    const yesterday = daysAgoStr(1);
    fs.writeFileSync(
      path.join(memDir, `${yesterday}.md`),
      'Yesterday note',
      'utf-8',
    );

    const result = store.getRecentMemories(1);
    expect(result).toContain('Today only');
    expect(result).not.toContain('Yesterday note');
  });

  it('readLongTerm returns empty string when file is removed after construction', () => {
    const store = new MemoryStore('removed');
    store.writeLongTerm('temporary');
    // Remove the file externally
    const filePath = path.join(
      TEST_GROUPS_DIR,
      'removed',
      'memory',
      'MEMORY.md',
    );
    fs.unlinkSync(filePath);
    expect(store.readLongTerm()).toBe('');
  });

  it('writeLongTerm with special markdown characters', () => {
    const store = new MemoryStore('special-chars');
    const content = '# Heading\n\n- List item\n- `code`\n\n> Blockquote\n\n---\n\n**bold** _italic_';
    store.writeLongTerm(content);
    expect(store.readLongTerm()).toBe(content);
  });
});
