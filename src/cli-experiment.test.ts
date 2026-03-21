import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  handleCreate,
  handleList,
  handleStart,
  handleRecord,
  handleView,
  parseFrontmatter,
  serializeFrontmatter,
  getNextExpId,
} from './cli-experiment.js';
import type {
  ExperimentDeps,
  ExperimentFrontmatter,
} from './cli-experiment.js';

const exec = promisify(execFile);
const CLI_SOURCE = path.resolve(__dirname, 'cli-experiment.ts');

// INVARIANT: Experiment CLI manages markdown files with YAML frontmatter lifecycle.
// SUT: cli-experiment.ts
// VERIFICATION: DI for file operations, subprocess for argument parsing.

function makeTmpDeps(): { deps: ExperimentDeps; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-test-'));
  return {
    deps: { resolveExperimentsDir: () => dir },
    dir,
  };
}

describe('cli-experiment argument parsing', () => {
  test('shows usage on --help', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, '--help']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Usage:');
      expect(error.stderr).toContain('create');
      expect(error.stderr).toContain('list');
      expect(error.stderr).toContain('record');
    }
  });

  test('rejects unknown command', async () => {
    try {
      await exec('npx', ['tsx', CLI_SOURCE, 'bogus']);
      expect.fail('should have exited with non-zero');
    } catch (err: unknown) {
      const error = err as { stderr: string };
      expect(error.stderr).toContain('Unknown command: bogus');
    }
  });
});

describe('parseFrontmatter', () => {
  test('parses experiment file with measurements', () => {
    const content = `---
id: EXP-001
title: "test title"
hypothesis: "test hypothesis"
falsification: "test falsification"
pattern: probe-and-observe
status: pending
issue: 388
created: 2026-03-21
completed: null
result: null
measurements:
  - name: "count"
    method: "manual"
    expected: "5"
    actual: null
---

## Context

Some body text.
`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.id).toBe('EXP-001');
    expect(frontmatter.title).toBe('test title');
    expect(frontmatter.hypothesis).toBe('test hypothesis');
    expect(frontmatter.pattern).toBe('probe-and-observe');
    expect(frontmatter.status).toBe('pending');
    expect(frontmatter.issue).toBe(388);
    expect(frontmatter.completed).toBeNull();
    expect(frontmatter.result).toBeNull();
    expect(frontmatter.measurements).toHaveLength(1);
    expect(frontmatter.measurements[0].name).toBe('count');
    expect(frontmatter.measurements[0].actual).toBeNull();
    expect(body).toContain('## Context');
  });

  test('roundtrips through serialize → parse', () => {
    const fm: ExperimentFrontmatter = {
      id: 'EXP-042',
      title: 'roundtrip test',
      hypothesis: 'serialization is lossless',
      falsification: 'parse fails or data changes',
      pattern: 'a-b-compare',
      status: 'running',
      issue: 334,
      created: '2026-03-21',
      completed: null,
      result: null,
      measurements: [
        { name: 'metric_a', method: 'count', expected: '10', actual: null },
        { name: 'metric_b', method: 'grep', expected: '0', actual: '3' },
      ],
    };

    const serialized = serializeFrontmatter(fm);
    const { frontmatter: parsed } = parseFrontmatter(serialized + '\n\nBody');

    expect(parsed.id).toBe(fm.id);
    expect(parsed.title).toBe(fm.title);
    expect(parsed.hypothesis).toBe(fm.hypothesis);
    expect(parsed.pattern).toBe(fm.pattern);
    expect(parsed.status).toBe(fm.status);
    expect(parsed.issue).toBe(fm.issue);
    expect(parsed.measurements).toHaveLength(2);
    expect(parsed.measurements[0].name).toBe('metric_a');
    expect(parsed.measurements[1].actual).toBe('3');
  });
});

describe('getNextExpId', () => {
  test('returns EXP-001 for empty directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-id-'));
    expect(getNextExpId(dir)).toBe('EXP-001');
    fs.rmSync(dir, { recursive: true });
  });

  test('returns EXP-001 for nonexistent directory', () => {
    expect(getNextExpId('/tmp/nonexistent-exp-dir-test')).toBe('EXP-001');
  });

  test('increments from existing experiments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-id-'));
    fs.writeFileSync(path.join(dir, 'EXP-001-test.md'), '');
    fs.writeFileSync(path.join(dir, 'EXP-003-another.md'), '');
    expect(getNextExpId(dir)).toBe('EXP-004');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('handleCreate', () => {
  let dir: string;
  let deps: ExperimentDeps;

  beforeEach(() => {
    ({ deps, dir } = makeTmpDeps());
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true });
  });

  test('creates experiment file with correct frontmatter', () => {
    // Capture stdout
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    handleCreate(
      [
        '--title',
        'test exp',
        '--hypothesis',
        'it works',
        '--issue',
        '388',
        '--pattern',
        'a-b-compare',
      ],
      deps,
    );

    console.log = origLog;

    const output = JSON.parse(logs[0]);
    expect(output.id).toBe('EXP-001');
    expect(output.status).toBe('pending');

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^EXP-001-test-exp\.md$/);

    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.title).toBe('test exp');
    expect(frontmatter.hypothesis).toBe('it works');
    expect(frontmatter.issue).toBe(388);
    expect(frontmatter.pattern).toBe('a-b-compare');
    expect(frontmatter.status).toBe('pending');
  });
});

describe('experiment lifecycle', () => {
  let dir: string;
  let deps: ExperimentDeps;

  beforeEach(() => {
    ({ deps, dir } = makeTmpDeps());
    // Suppress console.log for lifecycle tests
    const origLog = console.log;
    console.log = () => {};
    handleCreate(
      ['--title', 'lifecycle test', '--hypothesis', 'lifecycle works'],
      deps,
    );
    console.log = origLog;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true });
  });

  test('list returns created experiment', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    handleList([], deps);
    console.log = origLog;

    const result = JSON.parse(logs[0]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('EXP-001');
    expect(result[0].status).toBe('pending');
  });

  test('list filters by status', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    handleList(['--status', 'running'], deps);
    console.log = origLog;

    const result = JSON.parse(logs[0]);
    expect(result).toHaveLength(0);
  });

  test('start transitions pending → running', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    handleStart(['EXP-001'], deps);
    console.log = origLog;

    const output = JSON.parse(logs[0]);
    expect(output.status).toBe('running');

    // Verify file was updated
    const file = fs.readdirSync(dir).find((f) => f.startsWith('EXP-001'));
    const content = fs.readFileSync(path.join(dir, file!), 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.status).toBe('running');
  });

  test('record transitions to completed with result', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    handleStart(['EXP-001'], deps);
    logs.length = 0;

    handleRecord(['EXP-001', '--result', 'supported'], deps);
    console.log = origLog;

    const output = JSON.parse(logs[0]);
    expect(output.status).toBe('completed');
    expect(output.result).toBe('supported');
    expect(output.completed).toBeTruthy();
  });

  test('record falsified sets status to falsified', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    handleStart(['EXP-001'], deps);
    logs.length = 0;

    handleRecord(['EXP-001', '--result', 'falsified'], deps);
    console.log = origLog;

    const output = JSON.parse(logs[0]);
    expect(output.status).toBe('falsified');
  });

  test('view outputs file content', () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    handleView(['EXP-001'], deps);
    console.log = origLog;

    expect(logs[0]).toContain('EXP-001');
    expect(logs[0]).toContain('lifecycle test');
  });
});
