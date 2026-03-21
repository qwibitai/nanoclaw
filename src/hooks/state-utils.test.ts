import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isReflectionDone,
  listStateFilesAnyBranch,
  markReflectionDone,
  parseStateFile,
  prUrlToStateKey,
  serializeStateFile,
  writeStateFile,
} from './state-utils.js';

const TEST_STATE_DIR = '/tmp/.test-state-utils-ts';

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
});

describe('prUrlToStateKey', () => {
  it('converts PR URL to safe key', () => {
    expect(
      prUrlToStateKey('https://github.com/Garsson-io/nanoclaw/pull/33'),
    ).toBe('Garsson-io_nanoclaw_33');
  });

  it('handles repos with dots', () => {
    expect(prUrlToStateKey('https://github.com/org/my.repo/pull/1')).toBe(
      'org_my.repo_1',
    );
  });
});

describe('parseStateFile', () => {
  it('parses key=value format', () => {
    const content =
      'PR_URL=https://github.com/test/repo/pull/1\nSTATUS=needs_pr_kaizen\nBRANCH=main\n';
    const state = parseStateFile(content);
    expect(state.PR_URL).toBe('https://github.com/test/repo/pull/1');
    expect(state.STATUS).toBe('needs_pr_kaizen');
    expect(state.BRANCH).toBe('main');
  });

  it('handles empty content', () => {
    expect(parseStateFile('')).toEqual({});
  });
});

describe('serializeStateFile', () => {
  it('serializes state to key=value format', () => {
    const content = serializeStateFile({
      PR_URL: 'https://github.com/test/repo/pull/1',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'main',
    });
    expect(content).toContain('PR_URL=https://github.com/test/repo/pull/1');
    expect(content).toContain('STATUS=needs_pr_kaizen');
    expect(content).toContain('BRANCH=main');
  });

  it('includes ROUND when present', () => {
    const content = serializeStateFile({
      PR_URL: 'url',
      STATUS: 'needs_review',
      BRANCH: 'main',
      ROUND: '2',
    });
    expect(content).toContain('ROUND=2');
  });
});

describe('writeStateFile', () => {
  it('creates state file with correct content', () => {
    const filepath = writeStateFile(TEST_STATE_DIR, 'test-state', {
      PR_URL: 'https://github.com/test/repo/pull/1',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'feat-branch',
    });
    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toContain('PR_URL=https://github.com/test/repo/pull/1');
    expect(content).toContain('STATUS=needs_pr_kaizen');
    expect(content).toContain('BRANCH=feat-branch');
  });

  it('creates state dir if it does not exist', () => {
    const subDir = join(TEST_STATE_DIR, 'sub');
    writeStateFile(subDir, 'test', {
      PR_URL: 'url',
      STATUS: 'status',
      BRANCH: 'branch',
    });
    expect(existsSync(join(subDir, 'test'))).toBe(true);
  });
});

describe('listStateFilesAnyBranch', () => {
  it('returns empty array for empty directory', () => {
    expect(listStateFilesAnyBranch(TEST_STATE_DIR)).toEqual([]);
  });

  it('lists files with BRANCH field', () => {
    writeFileSync(
      join(TEST_STATE_DIR, 'state1'),
      'PR_URL=url1\nSTATUS=needs\nBRANCH=main\n',
    );
    const files = listStateFilesAnyBranch(TEST_STATE_DIR);
    expect(files).toHaveLength(1);
  });

  it('skips files without BRANCH field (legacy)', () => {
    writeFileSync(
      join(TEST_STATE_DIR, 'legacy'),
      'PR_URL=url1\nSTATUS=needs\n',
    );
    const files = listStateFilesAnyBranch(TEST_STATE_DIR);
    expect(files).toHaveLength(0);
  });
});

describe('markReflectionDone / isReflectionDone', () => {
  const prUrl = 'https://github.com/Garsson-io/nanoclaw/pull/42';

  it('marks and checks reflection done', () => {
    expect(isReflectionDone(prUrl, TEST_STATE_DIR)).toBe(false);
    markReflectionDone(prUrl, 'main', TEST_STATE_DIR);
    expect(isReflectionDone(prUrl, TEST_STATE_DIR)).toBe(true);
  });

  it('returns false for empty PR URL', () => {
    expect(isReflectionDone('', TEST_STATE_DIR)).toBe(false);
  });
});
