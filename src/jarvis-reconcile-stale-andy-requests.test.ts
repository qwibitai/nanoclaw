import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scriptPath = path.join(
  repoRoot,
  'scripts',
  'jarvis-reconcile-stale-andy-requests.sh',
);

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andy-request-reconcile-'));
  tempDirs.push(dir);
  return dir;
}

function createTestDb(dir: string): string {
  const dbPath = path.join(dir, 'messages.db');
  execFileSync(
    'sqlite3',
    [
      dbPath,
      `
CREATE TABLE andy_requests (
  request_id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  source_group_folder TEXT,
  source_lane_id TEXT,
  user_message_id TEXT,
  user_prompt TEXT,
  intent TEXT,
  state TEXT NOT NULL,
  worker_run_id TEXT,
  worker_group_folder TEXT,
  coordinator_session_id TEXT,
  last_status_text TEXT,
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT
);
      `,
    ],
    { cwd: repoRoot },
  );
  return dbPath;
}

function insertRequest(
  dbPath: string,
  input: {
    requestId: string;
    chatJid?: string;
    state: string;
    updatedAt: string;
    createdAt?: string;
    workerRunId?: string | null;
    workerGroupFolder?: string | null;
    prompt?: string;
  },
): void {
  const sql = `
INSERT INTO andy_requests (
  request_id, chat_jid, source_group_folder, source_lane_id, user_message_id,
  user_prompt, intent, state, worker_run_id, worker_group_folder,
  coordinator_session_id, last_status_text, created_at, updated_at, closed_at
) VALUES (
  '${input.requestId}',
  '${input.chatJid ?? 'chat@g.us'}',
  'andy-developer',
  'andy-developer',
  'msg-${input.requestId}',
  '${(input.prompt ?? 'test prompt').replace(/'/g, "''")}',
  'work_intake',
  '${input.state}',
  ${input.workerRunId ? `'${input.workerRunId}'` : 'NULL'},
  ${input.workerGroupFolder ? `'${input.workerGroupFolder}'` : 'NULL'},
  NULL,
  NULL,
  '${input.createdAt ?? input.updatedAt}',
  '${input.updatedAt}',
  NULL
);
  `;
  execFileSync('sqlite3', [dbPath, sql], { cwd: repoRoot });
}

function queryOne(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('jarvis-reconcile-stale-andy-requests.sh', () => {
  it('reports stale requests in dry-run mode without mutating them', () => {
    const dir = createTempDir();
    const dbPath = createTestDb(dir);
    insertRequest(dbPath, {
      requestId: 'req-stale-1',
      state: 'worker_review_requested',
      workerRunId: 'run-stale-1',
      workerGroupFolder: 'jarvis-worker-1',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    const output = execFileSync(
      'bash',
      [scriptPath, '--db', dbPath, '--stale-minutes', '60'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toContain('req-stale-1');
    expect(output).toContain('Dry-run only');
    expect(
      queryOne(
        dbPath,
        "SELECT state || '|' || COALESCE(closed_at, '') FROM andy_requests WHERE request_id = 'req-stale-1';",
      ),
    ).toBe('worker_review_requested|');
  });

  it('closes only stale matching requests when apply mode is used', () => {
    const dir = createTempDir();
    const dbPath = createTestDb(dir);
    insertRequest(dbPath, {
      requestId: 'req-stale-2',
      state: 'worker_review_requested',
      workerRunId: 'run-stale-2',
      workerGroupFolder: 'jarvis-worker-1',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
    insertRequest(dbPath, {
      requestId: 'req-fresh-2',
      state: 'worker_review_requested',
      workerRunId: 'run-fresh-2',
      workerGroupFolder: 'jarvis-worker-1',
      updatedAt: '2026-03-08T00:00:00.000Z',
    });

    const output = execFileSync(
      'bash',
      [
        scriptPath,
        '--db',
        dbPath,
        '--stale-minutes',
        '60',
        '--close-state',
        'cancelled',
        '--reason',
        'Archived stale test backlog',
        '--apply',
        '--backup-dir',
        dir,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toContain('Backup created');
    expect(output).toContain('req-stale-2 | cancelled');
    expect(
      queryOne(
        dbPath,
        "SELECT state || '|' || last_status_text || '|' || (closed_at IS NOT NULL) FROM andy_requests WHERE request_id = 'req-stale-2';",
      ),
    ).toBe('cancelled|Archived stale test backlog|1');
    expect(
      queryOne(
        dbPath,
        "SELECT state || '|' || COALESCE(closed_at, '') FROM andy_requests WHERE request_id = 'req-fresh-2';",
      ),
    ).toBe('worker_review_requested|');
  });

  it('supports targeted request cleanup regardless of age', () => {
    const dir = createTempDir();
    const dbPath = createTestDb(dir);
    insertRequest(dbPath, {
      requestId: 'req-target-3',
      state: 'queued_for_coordinator',
      updatedAt: '2026-03-08T00:00:00.000Z',
    });

    const output = execFileSync(
      'bash',
      [
        scriptPath,
        '--db',
        dbPath,
        '--request-id',
        'req-target-3',
        '--close-state',
        'failed',
        '--reason',
        'Manually closed during test cleanup',
        '--apply',
        '--backup-dir',
        dir,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(output).toContain('mode: targeted');
    expect(
      queryOne(
        dbPath,
        "SELECT state || '|' || last_status_text FROM andy_requests WHERE request_id = 'req-target-3';",
      ),
    ).toBe('failed|Manually closed during test cleanup');
  });
});
