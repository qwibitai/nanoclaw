// src/memory/shared/__tests__/verifier.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { runVerifierSweep } from '../verifier.js';
import {
  ensureMemoryDirs,
  candidateDir,
  rejectedDir,
  factPath,
} from '../paths.js';
import { writeFact } from '../store.js';
import type { CandidateFrontmatter } from '../types.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

function writeCandFile(
  filename: string,
  fm: CandidateFrontmatter,
  body: string,
): void {
  const front = yaml.dump(fm).trimEnd();
  fs.writeFileSync(
    path.join(candidateDir(), filename),
    `---\n${front}\n---\n\n${body}\n`,
  );
}

describe('verifier sweep', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-verify-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('promotes a passing candidate to a typed fact file', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ verdict: 'pass', reason: 'durable preference' }),
    });
    writeCandFile(
      '2026-04-17-tg-prefers_terse-abc.md',
      {
        candidate: true,
        type: 'feedback',
        name: 'Prefers terse',
        description: 'd',
        extracted_from: 'telegram_main',
        extracted_at: '2026-04-17T15:00:00Z',
        turn_excerpt: 'x',
        proposed_action: 'create',
        confidence: 0.9,
      },
      'User prefers terse.',
    );

    await runVerifierSweep();

    expect(fs.existsSync(factPath('feedback_prefers_terse'))).toBe(true);
    expect(
      fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')),
    ).toHaveLength(0);
  });

  it('merges into existing fact, incrementing count and source', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ verdict: 'pass', reason: 'reinforcement' }),
    });
    writeFact({
      slug: 'feedback_prefers_terse',
      frontmatter: {
        name: 'Prefers terse',
        description: 'd',
        type: 'feedback',
        count: 3,
        first_seen: '2026-04-01',
        last_seen: '2026-04-10',
        sources: { telegram_main: 3 },
      },
      body: 'old body',
    });
    writeCandFile(
      '2026-04-17-wa-prefers_terse-def.md',
      {
        candidate: true,
        type: 'feedback',
        name: 'Prefers terse',
        description: 'd',
        extracted_from: 'whatsapp_personal',
        extracted_at: '2026-04-17T15:00:00Z',
        turn_excerpt: 'x',
        proposed_action: 'merge:feedback_prefers_terse',
        confidence: 0.8,
      },
      'User prefers terse responses, reinforced.',
    );

    await runVerifierSweep();

    const raw = fs.readFileSync(factPath('feedback_prefers_terse'), 'utf8');
    expect(raw).toContain('count: 4');
    expect(raw).toContain('whatsapp_personal: 1');
    expect(raw).toContain('telegram_main: 3');
    // Body replaced; old body in history
    expect(raw).toContain('User prefers terse responses, reinforced.');
    expect(raw).toContain('old body');
  });

  it('rejects a failing candidate', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ verdict: 'fail', reason: 'transient' }),
    });
    writeCandFile(
      '2026-04-17-tg-noise-xyz.md',
      {
        candidate: true,
        type: 'project',
        name: 'noise',
        description: 'd',
        extracted_from: 'tg',
        extracted_at: '2026-04-17T15:00:00Z',
        turn_excerpt: 'x',
        proposed_action: 'create',
        confidence: 0.4,
      },
      'b',
    );

    await runVerifierSweep();

    expect(
      fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')),
    ).toHaveLength(0);
    expect(
      fs.readdirSync(rejectedDir()).filter((f) => f.endsWith('.md')),
    ).toHaveLength(1);
  });
});
