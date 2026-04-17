// src/memory/shared/__tests__/store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  writeFact,
  readFact,
  listFacts,
  regenerateIndex,
  archiveFact,
} from '../store.js';
import { ensureMemoryDirs, indexPath, factPath } from '../paths.js';
import type { Fact } from '../types.js';

describe('shared memory store', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
  });

  it('round-trips a fact through write and read', () => {
    const fact: Fact = {
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse responses',
        description: 'short answers',
        type: 'feedback',
        count: 3,
        first_seen: '2026-04-01',
        last_seen: '2026-04-15',
        sources: { telegram_main: 3 },
      },
      body: 'User prefers terse responses.',
    };
    writeFact(fact);
    const round = readFact('feedback_terse');
    expect(round).not.toBeNull();
    expect(round!.frontmatter.name).toBe('Prefers terse responses');
    expect(round!.frontmatter.count).toBe(3);
    expect(round!.body.trim()).toBe('User prefers terse responses.');
  });

  it('lists facts by type from disk', () => {
    writeFact({
      slug: 'user_role',
      frontmatter: {
        name: 'role',
        description: 'd',
        type: 'user',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { main: 1 },
      },
      body: 'b',
    });
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'terse',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { main: 1 },
      },
      body: 'b',
    });
    const all = listFacts();
    expect(all.map((f) => f.slug).sort()).toEqual([
      'feedback_terse',
      'user_role',
    ]);
  });

  it('regenerates a deterministic MEMORY.md index', () => {
    writeFact({
      slug: 'feedback_terse',
      frontmatter: {
        name: 'Prefers terse responses',
        description: 'short answers',
        type: 'feedback',
        count: 12,
        first_seen: '2026-04-01',
        last_seen: '2026-04-15',
        sources: { telegram_main: 8, whatsapp_personal: 4 },
      },
      body: 'b',
    });
    regenerateIndex();
    const indexA = fs.readFileSync(indexPath(), 'utf8');
    regenerateIndex();
    const indexB = fs.readFileSync(indexPath(), 'utf8');
    expect(indexA).toBe(indexB); // idempotent
    expect(indexA).toContain('Prefers terse responses');
    expect(indexA).toContain('feedback_terse.md');
    expect(indexA).toContain('# Shared user memory');
  });

  it('skips corrupt fact files without crashing listFacts', () => {
    const bogusPath = path.join(process.env.NANOCLAW_MEMORY_DIR!, 'bogus.md');
    fs.writeFileSync(
      bogusPath,
      '---\nthis is: not: valid: yaml: {[\n---\n\nbody',
    );
    // Should not throw; readFact returns null; listFacts excludes it.
    expect(() => listFacts()).not.toThrow();
    expect(listFacts()).toEqual([]);
  });

  it('archives a fact (soft-delete)', () => {
    writeFact({
      slug: 'feedback_x',
      frontmatter: {
        name: 'x',
        description: 'd',
        type: 'feedback',
        count: 1,
        first_seen: '2026-04-01',
        last_seen: '2026-04-01',
        sources: { main: 1 },
      },
      body: 'b',
    });
    expect(fs.existsSync(factPath('feedback_x'))).toBe(true);
    archiveFact('feedback_x');
    expect(fs.existsSync(factPath('feedback_x'))).toBe(false);
    expect(readFact('feedback_x')).toBeNull();
  });
});
