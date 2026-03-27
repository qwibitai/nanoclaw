import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VaultUtility } from '../vault/vault-utility.js';
import { StudentProfile } from './student-profile.js';

let tmpDir: string;
let vault: VaultUtility;
let profile: StudentProfile;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'profile-test-'));
  mkdirSync(join(tmpDir, 'profile'), { recursive: true });
  vault = new VaultUtility(tmpDir);
  profile = new StudentProfile(vault);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('StudentProfile', () => {
  describe('logStudySession', () => {
    it('creates study-log.md if it does not exist and appends the entry', async () => {
      await profile.logStudySession({
        type: 'quiz',
        topic: 'Calculus derivatives',
        course: 'MATH101',
        result: '8/10',
      });

      const content = await readFile(
        join(tmpDir, 'profile', 'study-log.md'),
        'utf-8',
      );
      expect(content).toContain('quiz');
      expect(content).toContain('Calculus derivatives');
      expect(content).toContain('MATH101');
      expect(content).toContain('8/10');
    });

    it('appends a second entry without overwriting the first', async () => {
      await profile.logStudySession({ type: 'study', topic: 'First topic' });
      await profile.logStudySession({ type: 'qa', topic: 'Second topic' });

      const content = await readFile(
        join(tmpDir, 'profile', 'study-log.md'),
        'utf-8',
      );
      expect(content).toContain('First topic');
      expect(content).toContain('Second topic');
    });

    it('includes date in the entry line', async () => {
      await profile.logStudySession({ type: 'summary', topic: 'Chapter 3' });

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(
        join(tmpDir, 'profile', 'study-log.md'),
        'utf-8',
      );
      expect(content).toContain(today);
    });

    it('appends to pre-existing study log content', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'study-log.md'),
        '# Study Log\n- **study** — Old entry — 2026-01-01 10:00\n',
      );

      await profile.logStudySession({ type: 'writing', topic: 'New entry' });

      const content = await readFile(
        join(tmpDir, 'profile', 'study-log.md'),
        'utf-8',
      );
      expect(content).toContain('Old entry');
      expect(content).toContain('New entry');
    });
  });

  describe('updateKnowledgeMap', () => {
    it('adds a new topic when the map is empty', async () => {
      await profile.updateKnowledgeMap('Fourier Transform', 'PHYS202', 0.8);

      const content = await readFile(
        join(tmpDir, 'profile', 'knowledge-map.md'),
        'utf-8',
      );
      expect(content).toContain('**Fourier Transform**');
      expect(content).toContain('PHYS202');
      expect(content).toContain('confidence: 0.8');
    });

    it("includes today's date in the new entry", async () => {
      await profile.updateKnowledgeMap('Recursion', 'CS101', 0.6);

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(
        join(tmpDir, 'profile', 'knowledge-map.md'),
        'utf-8',
      );
      expect(content).toContain(`updated: ${today}`);
    });

    it('updates an existing topic line in place', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'knowledge-map.md'),
        '# Knowledge Map\n- **Recursion** (CS101) — confidence: 0.4 — updated: 2026-01-01\n',
      );

      await profile.updateKnowledgeMap('Recursion', 'CS101', 0.9);

      const content = await readFile(
        join(tmpDir, 'profile', 'knowledge-map.md'),
        'utf-8',
      );
      const lines = content.split('\n').filter((l) => l.includes('Recursion'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('confidence: 0.9');
      expect(lines[0]).not.toContain('0.4');
    });

    it('does not duplicate when topic already exists', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'knowledge-map.md'),
        '# Knowledge Map\n- **Integration** (MATH201) — confidence: 0.5 — updated: 2026-01-01\n',
      );

      await profile.updateKnowledgeMap('Integration', 'MATH201', 0.7);

      const content = await readFile(
        join(tmpDir, 'profile', 'knowledge-map.md'),
        'utf-8',
      );
      const matches = (content.match(/\*\*Integration\*\*/g) ?? []).length;
      expect(matches).toBe(1);
    });
  });

  describe('addCourse', () => {
    it('adds a course under ## Active Courses heading', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'student-profile.md'),
        '# Student Profile\n\n## Active Courses\n',
      );

      await profile.addCourse('CS101', 'Introduction to Computer Science', 1);

      const content = await readFile(
        join(tmpDir, 'profile', 'student-profile.md'),
        'utf-8',
      );
      expect(content).toContain('**CS101**');
      expect(content).toContain('Introduction to Computer Science');
      expect(content).toContain('Semester 1');
    });

    it('creates the ## Active Courses section if it does not exist', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'student-profile.md'),
        '# Student Profile\n\nSome intro text.\n',
      );

      await profile.addCourse('MATH201', 'Linear Algebra', 2);

      const content = await readFile(
        join(tmpDir, 'profile', 'student-profile.md'),
        'utf-8',
      );
      expect(content).toContain('## Active Courses');
      expect(content).toContain('**MATH201**');
    });

    it('formats the course entry correctly', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'student-profile.md'),
        '# Student Profile\n\n## Active Courses\n',
      );

      await profile.addCourse('PHYS301', 'Quantum Mechanics', 3);

      const content = await readFile(
        join(tmpDir, 'profile', 'student-profile.md'),
        'utf-8',
      );
      expect(content).toContain(
        '- **PHYS301** — Quantum Mechanics (Semester 3)',
      );
    });

    it('can add multiple courses without overwriting previous ones', async () => {
      writeFileSync(
        join(tmpDir, 'profile', 'student-profile.md'),
        '# Student Profile\n\n## Active Courses\n',
      );

      await profile.addCourse('CS101', 'Intro CS', 1);
      await profile.addCourse('MATH101', 'Calculus I', 1);

      const content = await readFile(
        join(tmpDir, 'profile', 'student-profile.md'),
        'utf-8',
      );
      expect(content).toContain('**CS101**');
      expect(content).toContain('**MATH101**');
    });
  });
});
