import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VaultUtility } from './vault-utility.js';

let tmpDir: string;
let vault: VaultUtility;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vault-test-'));
  vault = new VaultUtility(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('VaultUtility', () => {
  describe('createNote', () => {
    it('creates a note with frontmatter and content', async () => {
      await vault.createNote('notes/hello.md', {
        data: { title: 'Hello', tags: ['a', 'b'] },
        content: 'This is the body.',
      });

      const note = await vault.readNote('notes/hello.md');
      expect(note).not.toBeNull();
      expect(note!.data.title).toBe('Hello');
      expect(note!.data.tags).toEqual(['a', 'b']);
      expect(note!.content).toBe('This is the body.');
    });

    it('auto-creates intermediate directories', async () => {
      await vault.createNote('a/b/c/deep.md', {
        data: { x: 1 },
        content: 'deep',
      });
      const note = await vault.readNote('a/b/c/deep.md');
      expect(note).not.toBeNull();
      expect(note!.data.x).toBe(1);
    });
  });

  describe('readNote', () => {
    it('returns null for a non-existent note', async () => {
      const result = await vault.readNote('does-not-exist.md');
      expect(result).toBeNull();
    });

    it('reads and parses an existing note', async () => {
      await vault.createNote('test.md', {
        data: { status: 'active' },
        content: 'Hello world',
      });
      const note = await vault.readNote('test.md');
      expect(note!.path).toBe('test.md');
      expect(note!.data.status).toBe('active');
      expect(note!.content).toBe('Hello world');
    });
  });

  describe('updateNote', () => {
    it('merges new fields into existing frontmatter', async () => {
      await vault.createNote('update-me.md', {
        data: { title: 'Old', keep: true },
        content: 'Body',
      });
      await vault.updateNote('update-me.md', { title: 'New', added: 42 });
      const note = await vault.readNote('update-me.md');
      expect(note!.data.title).toBe('New');
      expect(note!.data.keep).toBe(true);
      expect(note!.data.added).toBe(42);
      expect(note!.content).toBe('Body');
    });
  });

  describe('moveNote', () => {
    it('moves a file to a new path and creates target directories', async () => {
      await vault.createNote('source.md', {
        data: { v: 1 },
        content: 'move me',
      });
      await vault.moveNote('source.md', 'subdir/dest.md');

      const original = await vault.readNote('source.md');
      expect(original).toBeNull();

      const moved = await vault.readNote('subdir/dest.md');
      expect(moved).not.toBeNull();
      expect(moved!.data.v).toBe(1);
    });
  });

  describe('deleteNote', () => {
    it('deletes an existing note', async () => {
      await vault.createNote('bye.md', { data: {}, content: 'delete me' });
      await vault.deleteNote('bye.md');
      const result = await vault.readNote('bye.md');
      expect(result).toBeNull();
    });
  });

  describe('listNotes', () => {
    it('lists only .md files in a directory', async () => {
      await vault.createNote('folder/a.md', { data: {}, content: '' });
      await vault.createNote('folder/b.md', { data: {}, content: '' });
      // write a non-md file
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(tmpDir, 'folder', 'ignore.txt'), '');

      const notes = await vault.listNotes('folder');
      expect(notes).toHaveLength(2);
      expect(notes).toContain(join('folder', 'a.md'));
      expect(notes).toContain(join('folder', 'b.md'));
    });

    it('returns empty array for non-existent directory', async () => {
      const notes = await vault.listNotes('no-such-dir');
      expect(notes).toEqual([]);
    });
  });

  describe('searchNotes', () => {
    it('finds notes whose frontmatter matches the query', async () => {
      await vault.createNote('n1.md', {
        data: { type: 'lecture', subject: 'math' },
        content: 'Math lecture',
      });
      await vault.createNote('n2.md', {
        data: { type: 'lecture', subject: 'physics' },
        content: 'Physics lecture',
      });
      await vault.createNote('n3.md', {
        data: { type: 'exercise' },
        content: 'Exercise',
      });

      const results = await vault.searchNotes({ type: 'lecture' });
      expect(results).toHaveLength(2);
      const subjects = results.map((r) => r.data.subject);
      expect(subjects).toContain('math');
      expect(subjects).toContain('physics');
    });

    it('returns empty array when no notes match', async () => {
      await vault.createNote('x.md', { data: { type: 'a' }, content: '' });
      const results = await vault.searchNotes({ type: 'z' });
      expect(results).toEqual([]);
    });

    it('searches within a subdirectory when searchDir is provided', async () => {
      await vault.createNote('dir1/note.md', {
        data: { tag: 'yes' },
        content: '',
      });
      await vault.createNote('dir2/note.md', {
        data: { tag: 'yes' },
        content: '',
      });

      const results = await vault.searchNotes({ tag: 'yes' }, 'dir1');
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe(join('dir1', 'note.md'));
    });
  });

  describe('getBacklinks', () => {
    it('finds notes that wikilink to the given title', async () => {
      await vault.createNote('linker1.md', {
        data: {},
        content: 'See [[TargetNote]] for details.',
      });
      await vault.createNote('linker2.md', {
        data: {},
        content: 'Also [[TargetNote#section|alias]] here.',
      });
      await vault.createNote('unrelated.md', {
        data: {},
        content: 'This links to [[OtherNote]].',
      });

      const backlinks = await vault.getBacklinks('TargetNote');
      expect(backlinks).toHaveLength(2);
      expect(backlinks).toContain('linker1.md');
      expect(backlinks).toContain('linker2.md');
      expect(backlinks).not.toContain('unrelated.md');
    });

    it('returns empty array when no notes link to the title', async () => {
      await vault.createNote('solo.md', {
        data: {},
        content: 'No links here.',
      });
      const backlinks = await vault.getBacklinks('Ghost');
      expect(backlinks).toEqual([]);
    });
  });
});
