import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createIngestionJob,
  updateIngestionJobStatus,
  getIngestionJobs,
  createReviewItem,
  updateReviewItemStatus,
  getPendingReviewItems,
  setFolderTypeOverride,
  getFolderTypeOverride,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// --- ingestion_jobs ---

describe('createIngestionJob', () => {
  it('creates an ingestion job with default pending status', () => {
    createIngestionJob(
      'job-1',
      '/uploads/file.pdf',
      'file.pdf',
      'CS101',
      'Intro to CS',
      1,
      2025,
      'lecture',
    );

    const jobs = getIngestionJobs() as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('job-1');
    expect(jobs[0].source_path).toBe('/uploads/file.pdf');
    expect(jobs[0].source_filename).toBe('file.pdf');
    expect(jobs[0].course_code).toBe('CS101');
    expect(jobs[0].course_name).toBe('Intro to CS');
    expect(jobs[0].semester).toBe(1);
    expect(jobs[0].year).toBe(2025);
    expect(jobs[0].type).toBe('lecture');
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].error).toBeNull();
    expect(jobs[0].completed_at).toBeNull();
  });

  it('creates a job with null optional fields', () => {
    createIngestionJob(
      'job-2',
      '/path/doc.pdf',
      'doc.pdf',
      null,
      null,
      null,
      null,
      null,
    );

    const jobs = getIngestionJobs() as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].course_code).toBeNull();
    expect(jobs[0].course_name).toBeNull();
    expect(jobs[0].semester).toBeNull();
    expect(jobs[0].year).toBeNull();
    expect(jobs[0].type).toBeNull();
  });
});

describe('updateIngestionJobStatus', () => {
  beforeEach(() => {
    createIngestionJob(
      'job-3',
      '/path/f.pdf',
      'f.pdf',
      null,
      null,
      null,
      null,
      null,
    );
  });

  it('updates job status to completed and sets completed_at', () => {
    updateIngestionJobStatus('job-3', 'completed');

    const jobs = getIngestionJobs() as Array<Record<string, unknown>>;
    expect(jobs[0].status).toBe('completed');
    expect(jobs[0].completed_at).not.toBeNull();
    expect(jobs[0].error).toBeNull();
  });

  it('updates job status to failed with an error message', () => {
    updateIngestionJobStatus('job-3', 'failed', 'Conversion error');

    const jobs = getIngestionJobs() as Array<Record<string, unknown>>;
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].error).toBe('Conversion error');
  });

  it('does not overwrite completed_at on a second update', () => {
    updateIngestionJobStatus('job-3', 'completed');
    const jobs1 = getIngestionJobs() as Array<Record<string, unknown>>;
    const completedAt1 = jobs1[0].completed_at;

    updateIngestionJobStatus('job-3', 'reviewed');
    const jobs2 = getIngestionJobs() as Array<Record<string, unknown>>;
    expect(jobs2[0].completed_at).toBe(completedAt1);
  });
});

describe('getIngestionJobs', () => {
  beforeEach(() => {
    createIngestionJob(
      'job-a',
      '/a.pdf',
      'a.pdf',
      null,
      null,
      null,
      null,
      null,
    );
    createIngestionJob(
      'job-b',
      '/b.pdf',
      'b.pdf',
      null,
      null,
      null,
      null,
      null,
    );
    updateIngestionJobStatus('job-b', 'completed');
  });

  it('returns all jobs when called without status filter', () => {
    const jobs = getIngestionJobs();
    expect(jobs).toHaveLength(2);
  });

  it('filters jobs by status', () => {
    const pending = getIngestionJobs('pending') as Array<
      Record<string, unknown>
    >;
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('job-a');

    const completed = getIngestionJobs('completed') as Array<
      Record<string, unknown>
    >;
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe('job-b');
  });

  it('returns empty array when no jobs match filter', () => {
    const failed = getIngestionJobs('failed');
    expect(failed).toHaveLength(0);
  });
});

// --- review_items ---

describe('createReviewItem', () => {
  beforeEach(() => {
    createIngestionJob(
      'job-r',
      '/source.pdf',
      'source.pdf',
      'MAT201',
      null,
      null,
      null,
      null,
    );
  });

  it('creates a review item linked to a job with default pending status', () => {
    createReviewItem(
      'review-1',
      'job-r',
      '/drafts/note.md',
      '/source.pdf',
      'lecture',
      'MAT201',
      ['fig1.png', 'fig2.png'],
    );

    const items = getPendingReviewItems() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('review-1');
    expect(items[0].job_id).toBe('job-r');
    expect(items[0].draft_path).toBe('/drafts/note.md');
    expect(items[0].original_source).toBe('/source.pdf');
    expect(items[0].suggested_type).toBe('lecture');
    expect(items[0].suggested_course).toBe('MAT201');
    expect(items[0].figures).toBe('["fig1.png","fig2.png"]');
    expect(items[0].status).toBe('pending');
    expect(items[0].reviewed_at).toBeNull();
  });

  it('stores an empty figures array as JSON', () => {
    createReviewItem(
      'review-2',
      'job-r',
      '/drafts/note2.md',
      null,
      null,
      null,
      [],
    );

    const items = getPendingReviewItems() as Array<Record<string, unknown>>;
    expect(items[0].figures).toBe('[]');
  });
});

describe('updateReviewItemStatus', () => {
  beforeEach(() => {
    createIngestionJob(
      'job-s',
      '/s.pdf',
      's.pdf',
      null,
      null,
      null,
      null,
      null,
    );
    createReviewItem('review-3', 'job-s', '/drafts/n.md', null, null, null, []);
  });

  it('updates review item status to approved and sets reviewed_at', () => {
    updateReviewItemStatus('review-3', 'approved');

    // approved items should not appear in pending list
    const pending = getPendingReviewItems();
    expect(pending).toHaveLength(0);
  });

  it('updates review item status to rejected', () => {
    updateReviewItemStatus('review-3', 'rejected');

    const pending = getPendingReviewItems();
    expect(pending).toHaveLength(0);
  });
});

describe('getPendingReviewItems', () => {
  beforeEach(() => {
    createIngestionJob(
      'job-p',
      '/p.pdf',
      'p.pdf',
      null,
      null,
      null,
      null,
      null,
    );
    createReviewItem('rev-p1', 'job-p', '/drafts/p1.md', null, null, null, []);
    createReviewItem('rev-p2', 'job-p', '/drafts/p2.md', null, null, null, []);
    createReviewItem('rev-p3', 'job-p', '/drafts/p3.md', null, null, null, []);
    updateReviewItemStatus('rev-p3', 'approved');
  });

  it('returns only pending items', () => {
    const pending = getPendingReviewItems() as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(2);
    const ids = pending.map((r) => r.id);
    expect(ids).toContain('rev-p1');
    expect(ids).toContain('rev-p2');
    expect(ids).not.toContain('rev-p3');
  });
});

// --- folder_type_overrides ---

describe('setFolderTypeOverride / getFolderTypeOverride', () => {
  it('creates a folder type override', () => {
    setFolderTypeOverride('CS101_lectures', 'lecture', 'CS101');

    const override = getFolderTypeOverride('CS101_lectures');
    expect(override).toBeDefined();
    expect(override!.folder_name).toBe('CS101_lectures');
    expect(override!.note_type).toBe('lecture');
    expect(override!.course_code).toBe('CS101');
  });

  it('creates a folder type override without course code', () => {
    setFolderTypeOverride('misc_notes', 'note');

    const override = getFolderTypeOverride('misc_notes');
    expect(override).toBeDefined();
    expect(override!.note_type).toBe('note');
    expect(override!.course_code).toBeNull();
  });

  it('returns undefined for unknown folder', () => {
    const override = getFolderTypeOverride('nonexistent');
    expect(override).toBeUndefined();
  });

  it('upserts when the same folder is set again', () => {
    setFolderTypeOverride('shared_folder', 'lecture', 'CS101');
    setFolderTypeOverride('shared_folder', 'exam', 'CS202');

    const override = getFolderTypeOverride('shared_folder');
    expect(override!.note_type).toBe('exam');
    expect(override!.course_code).toBe('CS202');
  });
});
