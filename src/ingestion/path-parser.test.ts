import { describe, it, expect } from 'vitest';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';

describe('parseUploadPath', () => {
  describe('full path extraction', () => {
    it('extracts all fields from the canonical example path', () => {
      const result = parseUploadPath(
        '01 - Digital Forretningsutvikling/6. Semester/BI 2081 - Natur, miljø og bærekraft/Forelesninger/lecture-w12.pdf',
      );

      expect(result).toEqual({
        semester: 6,
        year: 3,
        courseCode: 'BI-2081',
        courseName: 'Natur, miljø og bærekraft',
        type: 'lecture',
        fileName: 'lecture-w12.pdf',
      });
    });

    it('extracts all fields from an assignment path', () => {
      const result = parseUploadPath(
        'Studies/3. Semester/CS 1101 - Introduction to Programming/Oppgaver/exercise-01.pdf',
      );

      expect(result).toEqual({
        semester: 3,
        year: 2,
        courseCode: 'CS-1101',
        courseName: 'Introduction to Programming',
        type: 'assignment',
        fileName: 'exercise-01.pdf',
      });
    });
  });

  describe('semester and year calculation', () => {
    it.each([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [6, 3],
    ])('semester %i → year %i', (sem, expectedYear) => {
      const result = parseUploadPath(
        `Studies/${sem}. Semester/AB 1234 - Course/note.pdf`,
      );
      expect(result.semester).toBe(sem);
      expect(result.year).toBe(expectedYear);
    });

    it('handles semester with no space before dot', () => {
      const result = parseUploadPath(
        'Studies/4.Semester/AB 1234 - Course/note.pdf',
      );
      expect(result.semester).toBe(4);
      expect(result.year).toBe(2);
    });

    it('handles semester with extra spaces', () => {
      const result = parseUploadPath(
        'Studies/2.  Semester/AB 1234 - Course/note.pdf',
      );
      expect(result.semester).toBe(2);
      expect(result.year).toBe(1);
    });
  });

  describe('course code formatting', () => {
    it('formats 2-letter course codes correctly', () => {
      const result = parseUploadPath('AB 1234 - Course Name/note.pdf');
      expect(result.courseCode).toBe('AB-1234');
    });

    it('formats 3-letter course codes correctly', () => {
      const result = parseUploadPath('BIS 3400 - Strategy/note.pdf');
      expect(result.courseCode).toBe('BIS-3400');
    });

    it('formats 4-letter course codes correctly', () => {
      const result = parseUploadPath('MATH 1001 - Calculus/note.pdf');
      expect(result.courseCode).toBe('MATH-1001');
    });

    it('trims course name whitespace', () => {
      const result = parseUploadPath('AB 1234 -   Padded Name   /note.pdf');
      expect(result.courseName).toBe('Padded Name');
    });
  });

  describe('type classification', () => {
    it('classifies Forelesninger → lecture', () => {
      const result = parseUploadPath('Course/Forelesninger/note.pdf');
      expect(result.type).toBe('lecture');
    });

    it('classifies Pensum → reading', () => {
      const result = parseUploadPath('Course/Pensum/book.pdf');
      expect(result.type).toBe('reading');
    });

    it('classifies Eksamen → exam-prep', () => {
      const result = parseUploadPath('Course/Eksamen/paper.pdf');
      expect(result.type).toBe('exam-prep');
    });

    it('classifies Kompendium → compendium', () => {
      const result = parseUploadPath('Course/Kompendium/notes.pdf');
      expect(result.type).toBe('compendium');
    });

    it('returns null type for unknown folder names', () => {
      const result = parseUploadPath('Studies/Unknown/note.pdf');
      expect(result.type).toBeNull();
    });

    it('uses provided TypeMappings instance', async () => {
      const tm = new TypeMappings('');
      await tm.learn('anteckningar', 'lecture');
      const result = parseUploadPath('Course/Anteckningar/note.pdf', tm);
      expect(result.type).toBe('lecture');
    });
  });

  describe('files directly in course folder', () => {
    it('handles file with no type folder', () => {
      const result = parseUploadPath(
        '2. Semester/CS 1234 - Programming/syllabus.pdf',
      );

      expect(result.semester).toBe(2);
      expect(result.year).toBe(1);
      expect(result.courseCode).toBe('CS-1234');
      expect(result.courseName).toBe('Programming');
      expect(result.type).toBeNull();
      expect(result.fileName).toBe('syllabus.pdf');
    });
  });

  describe('partial and minimal paths', () => {
    it('returns all nulls except fileName for a bare file name', () => {
      const result = parseUploadPath('note.pdf');
      expect(result).toEqual({
        semester: null,
        year: null,
        courseCode: null,
        courseName: null,
        type: null,
        fileName: 'note.pdf',
      });
    });

    it('extracts only semester when no course segment present', () => {
      const result = parseUploadPath('3. Semester/note.pdf');
      expect(result.semester).toBe(3);
      expect(result.year).toBe(2);
      expect(result.courseCode).toBeNull();
      expect(result.courseName).toBeNull();
      expect(result.type).toBeNull();
      expect(result.fileName).toBe('note.pdf');
    });

    it('extracts only course when no semester segment present', () => {
      const result = parseUploadPath('BI 2081 - Some Course/Slides/note.pdf');
      expect(result.semester).toBeNull();
      expect(result.year).toBeNull();
      expect(result.courseCode).toBe('BI-2081');
      expect(result.courseName).toBe('Some Course');
      expect(result.type).toBe('lecture');
    });

    it('extracts only type when no semester or course present', () => {
      const result = parseUploadPath('Forelesninger/note.pdf');
      expect(result.semester).toBeNull();
      expect(result.year).toBeNull();
      expect(result.courseCode).toBeNull();
      expect(result.type).toBe('lecture');
      expect(result.fileName).toBe('note.pdf');
    });
  });
});
