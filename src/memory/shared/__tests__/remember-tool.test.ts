// src/memory/shared/__tests__/remember-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rememberTool } from '../remember-tool.js';
import { ensureMemoryDirs, candidateDir } from '../paths.js';

describe('remember tool', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-rem-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('writes a candidate with confidence 1.0 and proposed_action create', async () => {
    await rememberTool({
      groupName: 'telegram_main',
      type: 'feedback',
      name: 'No auto-archive',
      body: 'Never auto-archive emails.',
      scopes: ['personal'],
    });
    const files = fs
      .readdirSync(candidateDir())
      .filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(candidateDir(), files[0]), 'utf8');
    expect(raw).toContain('confidence: 1');
    expect(raw).toContain('proposed_action: create');
    expect(raw).toContain('extracted_from: telegram_main');
    expect(raw).toContain('No auto-archive');
  });

  it('rejects unknown type', async () => {
    await expect(
      rememberTool({
        groupName: 'tg',
        type: 'invalid' as never,
        name: 'x',
        body: 'y',
      }),
    ).rejects.toThrow(/type/);
  });
});
