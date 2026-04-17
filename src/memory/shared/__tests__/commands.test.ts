// src/memory/shared/__tests__/commands.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleMemoryCommand } from '../commands.js';
import { writeFact } from '../store.js';
import { ensureMemoryDirs, factPath } from '../paths.js';

describe('memory commands', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cmd-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('lists facts', () => {
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse',
        description: 'd',
        type: 'feedback',
        count: 3,
        first_seen: '2026-04-01',
        last_seen: '2026-04-15',
        sources: { tg: 3 },
      },
      body: 'b',
    });
    const out = handleMemoryCommand({ action: 'list' });
    expect(out).toContain('Prefers terse');
    expect(out).toContain('feedback_terse');
  });

  it('shows a specific fact body', () => {
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { tg: 1 },
      },
      body: 'Body of the fact.',
    });
    const out = handleMemoryCommand({ action: 'show', slug: 'feedback_terse' });
    expect(out).toContain('Body of the fact.');
    expect(out).toContain('count: 1');
  });

  it('returns helpful message when fact does not exist for show', () => {
    const out = handleMemoryCommand({ action: 'show', slug: 'nope' });
    expect(out).toMatch(/not found/i);
  });

  it('forgets (archives) a fact', () => {
    writeFact({
      slug: 'feedback_x',
      frontmatter: {
        name: 'x',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { tg: 1 },
      },
      body: 'b',
    });
    const out = handleMemoryCommand({ action: 'forget', slug: 'feedback_x' });
    expect(out).toMatch(/archived/i);
    expect(fs.existsSync(factPath('feedback_x'))).toBe(false);
  });
});
