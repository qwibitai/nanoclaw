import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VaultUtility } from '../vault/vault-utility.js';
import { ReviewQueue, DraftInput } from './review-queue.js';

let tmpDir: string;
let vault: VaultUtility;
let queue: ReviewQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'review-queue-test-'));
  vault = new VaultUtility(tmpDir);
  queue = new ReviewQueue(vault);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ReviewQueue', () => {
  describe('addDraft', () => {
    it('creates a note in drafts/ with correct frontmatter', async () => {
      const draft: DraftInput = {
        id: 'abc123',
        data: { title: 'My Note', subject: 'math' },
        content: 'Note body here.',
        targetPath: 'courses/math/my-note.md',
      };

      await queue.addDraft(draft);

      const note = await vault.readNote('drafts/abc123.md');
      expect(note).not.toBeNull();
      expect(note!.data.title).toBe('My Note');
      expect(note!.data.subject).toBe('math');
      expect(note!.data.status).toBe('draft');
      expect(note!.data._targetPath).toBe('courses/math/my-note.md');
      expect(note!.content).toBe('Note body here.');
    });

    it('creates the drafts/ directory automatically', async () => {
      await queue.addDraft({
        id: 'new-id',
        data: {},
        content: '',
        targetPath: 'some/path.md',
      });

      const note = await vault.readNote('drafts/new-id.md');
      expect(note).not.toBeNull();
    });
  });

  describe('approveDraft', () => {
    it('moves draft to target path, sets status approved, removes _targetPath', async () => {
      await queue.addDraft({
        id: 'draft1',
        data: { title: 'Lecture 1' },
        content: 'Lecture content.',
        targetPath: 'courses/math/lecture-1.md',
      });

      await queue.approveDraft('draft1');

      const draftNote = await vault.readNote('drafts/draft1.md');
      expect(draftNote).toBeNull();

      const approvedNote = await vault.readNote('courses/math/lecture-1.md');
      expect(approvedNote).not.toBeNull();
      expect(approvedNote!.data.status).toBe('approved');
      expect(approvedNote!.data._targetPath).toBeUndefined();
      expect(approvedNote!.data.title).toBe('Lecture 1');
      expect(approvedNote!.content).toBe('Lecture content.');
    });

    it('throws if draft does not exist', async () => {
      await expect(queue.approveDraft('nonexistent')).rejects.toThrow(
        'Draft not found: nonexistent',
      );
    });
  });

  describe('rejectDraft', () => {
    it('deletes the draft note', async () => {
      await queue.addDraft({
        id: 'reject-me',
        data: { title: 'Bad Draft' },
        content: 'Bad content.',
        targetPath: 'somewhere/note.md',
      });

      await queue.rejectDraft('reject-me');

      const note = await vault.readNote('drafts/reject-me.md');
      expect(note).toBeNull();
    });
  });

  describe('removeFigure', () => {
    it('removes embed and Figure description from content', async () => {
      await queue.addDraft({
        id: 'fig-draft',
        data: { figures: ['fig1.png', 'fig2.png'] },
        content:
          'Some text.\n![[fig1.png]]\n**Figure:** A diagram of something\nMore text.',
        targetPath: 'notes/fig-note.md',
      });

      await queue.removeFigure('fig-draft', 'fig1.png');

      const note = await vault.readNote('drafts/fig-draft.md');
      expect(note).not.toBeNull();
      expect(note!.content).not.toContain('![[fig1.png]]');
      expect(note!.content).not.toContain('**Figure:** A diagram of something');
      expect(note!.content).toContain('More text.');
    });

    it('removes the figure from the figures array in frontmatter', async () => {
      await queue.addDraft({
        id: 'fig-draft2',
        data: { figures: ['fig1.png', 'fig2.png', 'fig3.png'] },
        content: '![[fig2.png]]\n**Figure:** Second figure\n',
        targetPath: 'notes/fig-note2.md',
      });

      await queue.removeFigure('fig-draft2', 'fig2.png');

      const note = await vault.readNote('drafts/fig-draft2.md');
      expect(note!.data.figures).toEqual(['fig1.png', 'fig3.png']);
    });

    it('handles embed without a Figure description', async () => {
      await queue.addDraft({
        id: 'fig-draft3',
        data: { figures: ['fig1.png'] },
        content: 'Text before.\n![[fig1.png]]\nText after.',
        targetPath: 'notes/no-caption.md',
      });

      await queue.removeFigure('fig-draft3', 'fig1.png');

      const note = await vault.readNote('drafts/fig-draft3.md');
      expect(note!.content).not.toContain('![[fig1.png]]');
      expect(note!.content).toContain('Text before.');
      expect(note!.content).toContain('Text after.');
    });

    it('throws if draft does not exist', async () => {
      await expect(
        queue.removeFigure('no-such-draft', 'fig.png'),
      ).rejects.toThrow('Draft not found: no-such-draft');
    });
  });

  describe('listDrafts', () => {
    it('lists all drafts in the drafts/ folder', async () => {
      await queue.addDraft({
        id: 'draft-a',
        data: { title: 'A' },
        content: 'Content A',
        targetPath: 'path/a.md',
      });
      await queue.addDraft({
        id: 'draft-b',
        data: { title: 'B' },
        content: 'Content B',
        targetPath: 'path/b.md',
      });

      const drafts = await queue.listDrafts();
      expect(drafts).toHaveLength(2);
      const titles = drafts.map((d) => d.data.title);
      expect(titles).toContain('A');
      expect(titles).toContain('B');
    });

    it('returns empty array when no drafts exist', async () => {
      const drafts = await queue.listDrafts();
      expect(drafts).toEqual([]);
    });
  });
});
