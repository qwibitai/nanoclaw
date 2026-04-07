import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _setReportsDir,
  createReport,
  getReport,
  isValidReportId,
  listReports,
  setReportsChangeCallback,
} from './reports.js';

describe('reports', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join('/tmp', 'reports-test-'));
    _setReportsDir(testDir);
    setReportsChangeCallback(null);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    setReportsChangeCallback(null);
  });

  // --- isValidReportId ---

  describe('isValidReportId', () => {
    it('accepts valid IDs', () => {
      expect(isValidReportId('2026-04-06-foo-a3f9k2')).toBe(true);
      expect(isValidReportId('report')).toBe(true);
      expect(isValidReportId('a-b-c-1-2-3')).toBe(true);
    });

    it('rejects empty', () => {
      expect(isValidReportId('')).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      expect(isValidReportId('../etc/passwd')).toBe(false);
      expect(isValidReportId('foo/bar')).toBe(false);
      expect(isValidReportId('foo\\bar')).toBe(false);
    });

    it('rejects uppercase, spaces, and special chars', () => {
      expect(isValidReportId('Foo')).toBe(false);
      expect(isValidReportId('foo bar')).toBe(false);
      expect(isValidReportId('foo.md')).toBe(false);
      expect(isValidReportId('foo_bar')).toBe(false);
    });

    it('rejects IDs over 80 chars', () => {
      expect(isValidReportId('a'.repeat(80))).toBe(true);
      expect(isValidReportId('a'.repeat(81))).toBe(false);
    });
  });

  // --- createReport ---

  describe('createReport', () => {
    it('writes a file whose round-tripped frontmatter matches the input', () => {
      const created = createReport({
        id: '2026-04-06-test-abc123',
        title: 'Test Report',
        summary: 'A short summary.',
        body_markdown: '# Hello\n\nSome body text.',
        created_by: 'telegram_pip_family',
      });

      expect(created.id).toBe('2026-04-06-test-abc123');
      expect(created.title).toBe('Test Report');
      expect(created.summary).toBe('A short summary.');
      expect(created.body_markdown).toBe('# Hello\n\nSome body text.');
      expect(created.created_by).toBe('telegram_pip_family');
      expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const fetched = getReport('2026-04-06-test-abc123');
      expect(fetched).not.toBeNull();
      expect(fetched).toEqual(created);
    });

    it('invokes the registered onChange callback exactly once', () => {
      const cb = vi.fn();
      setReportsChangeCallback(cb);

      createReport({
        id: '2026-04-06-cb-test-1',
        title: 'CB Test',
        summary: '',
        body_markdown: 'body',
        created_by: 'ios_boris',
      });

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does not throw if the callback throws — only logs', () => {
      setReportsChangeCallback(() => {
        throw new Error('callback boom');
      });

      expect(() =>
        createReport({
          id: '2026-04-06-cb-test-2',
          title: 'CB Test',
          summary: '',
          body_markdown: 'body',
          created_by: 'ios_boris',
        }),
      ).not.toThrow();
    });

    it('rejects invalid IDs', () => {
      expect(() =>
        createReport({
          id: '../etc/passwd',
          title: 'Bad',
          summary: '',
          body_markdown: 'body',
          created_by: 'ios_boris',
        }),
      ).toThrow(/Invalid report id/);
    });

    it('preserves titles containing characters that would break naive YAML', () => {
      createReport({
        id: '2026-04-06-yaml-edge',
        title: 'Quotes "inside" and: colons',
        summary: 'Summary with --- separators inside',
        body_markdown: 'Plain body.',
        created_by: 'ios_boris',
      });

      const fetched = getReport('2026-04-06-yaml-edge');
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('Quotes "inside" and: colons');
      expect(fetched!.summary).toBe('Summary with --- separators inside');
    });

    it('preserves bodies containing their own --- separators (e.g. in code blocks)', () => {
      const body = [
        '# Heading',
        '',
        '```',
        '---',
        'this is in a code block',
        '---',
        '```',
        '',
        'Trailing prose.',
      ].join('\n');

      createReport({
        id: '2026-04-06-body-fences',
        title: 'Body with fences',
        summary: '',
        body_markdown: body,
        created_by: 'ios_boris',
      });

      const fetched = getReport('2026-04-06-body-fences');
      expect(fetched).not.toBeNull();
      expect(fetched!.body_markdown).toBe(body);
    });
  });

  // --- listReports ---

  describe('listReports', () => {
    it('returns an empty list when the directory is empty', () => {
      expect(listReports()).toEqual([]);
    });

    it('returns reports sorted newest first by created_at', async () => {
      createReport({
        id: 'a-old',
        title: 'Old',
        summary: '',
        body_markdown: 'body',
        created_by: 'ios_boris',
      });
      // Force a different timestamp
      await new Promise((r) => setTimeout(r, 5));
      createReport({
        id: 'b-newer',
        title: 'Newer',
        summary: '',
        body_markdown: 'body',
        created_by: 'ios_boris',
      });
      await new Promise((r) => setTimeout(r, 5));
      createReport({
        id: 'c-newest',
        title: 'Newest',
        summary: '',
        body_markdown: 'body',
        created_by: 'ios_boris',
      });

      const list = listReports();
      expect(list.map((r) => r.id)).toEqual(['c-newest', 'b-newer', 'a-old']);
    });

    it('returns metadata only — no body in list entries', () => {
      createReport({
        id: 'meta-only',
        title: 'Meta',
        summary: 'sum',
        body_markdown: 'this body should not appear in the list',
        created_by: 'ios_boris',
      });

      const list = listReports();
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('body_markdown');
      expect(list[0].id).toBe('meta-only');
    });

    it('skips files with missing required frontmatter without crashing', () => {
      // Drop a malformed file alongside a good one
      fs.writeFileSync(
        path.join(testDir, 'broken.md'),
        '# Just markdown, no frontmatter',
      );
      createReport({
        id: 'good',
        title: 'Good',
        summary: '',
        body_markdown: 'body',
        created_by: 'ios_boris',
      });

      const list = listReports();
      expect(list.map((r) => r.id)).toEqual(['good']);
    });

    it('skips symlinks (defense in depth)', () => {
      createReport({
        id: 'real',
        title: 'Real',
        summary: '',
        body_markdown: 'body',
        created_by: 'ios_boris',
      });

      // Symlink an arbitrary file in as if Boris dropped one in by accident
      const target = fs.mkdtempSync(
        path.join('/tmp', 'reports-symlink-target-'),
      );
      const targetFile = path.join(target, 'evil.md');
      fs.writeFileSync(
        targetFile,
        '---\nid: evil\ntitle: Evil\ncreated_at: 2026-01-01\n---\nshould not appear',
      );
      try {
        fs.symlinkSync(targetFile, path.join(testDir, 'symlinked.md'));
        const list = listReports();
        expect(list.map((r) => r.id)).toEqual(['real']);
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    });
  });

  // --- getReport ---

  describe('getReport', () => {
    it('returns null for an unknown ID', () => {
      expect(getReport('does-not-exist')).toBeNull();
    });

    it('returns null for an invalid ID rather than throwing', () => {
      expect(getReport('../etc/passwd')).toBeNull();
      expect(getReport('foo/bar')).toBeNull();
    });

    it('returns null for a malformed file', () => {
      fs.writeFileSync(
        path.join(testDir, 'malformed.md'),
        'no frontmatter here',
      );
      expect(getReport('malformed')).toBeNull();
    });
  });
});
