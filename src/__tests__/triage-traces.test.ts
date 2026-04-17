import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { emitTrace, setTraceDir } from '../triage/traces.js';

describe('triage traces', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-traces-'));
    setTraceDir(dir);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
  });

  it('appends one JSON line per call to the day file', () => {
    emitTrace({
      trackedItemId: 'i1',
      tier: 1,
      latencyMs: 120,
      queue: 'attention',
      confidence: 0.9,
      cacheReadTokens: 80,
      inputTokens: 100,
      outputTokens: 50,
    });
    emitTrace({
      trackedItemId: 'i2',
      tier: 2,
      latencyMs: 300,
      queue: 'archive_candidate',
      confidence: 0.8,
      cacheReadTokens: 80,
      inputTokens: 120,
      outputTokens: 40,
    });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const lines = fs
      .readFileSync(path.join(dir, files[0]), 'utf8')
      .trim()
      .split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.trackedItemId).toBe('i1');
    expect(first.tier).toBe(1);
  });
});
