// src/memory/shared/__tests__/audit.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logAudit, readAudit } from '../audit.js';
import { ensureMemoryDirs } from '../paths.js';

describe('audit log', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-audit-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('appends entries and reads them back in order', () => {
    logAudit({ action: 'create', slug: 'feedback_a', source: 'main', reason: 'x' });
    logAudit({ action: 'merge', slug: 'feedback_a', source: 'tg', reason: 'reinforced' });
    const lines = readAudit();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ action: 'create', slug: 'feedback_a' });
    expect(lines[1]).toMatchObject({ action: 'merge', slug: 'feedback_a' });
  });

  it('returns empty array if log does not exist', () => {
    expect(readAudit()).toEqual([]);
  });
});
