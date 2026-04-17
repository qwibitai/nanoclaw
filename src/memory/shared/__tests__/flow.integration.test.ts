// src/memory/shared/__tests__/flow.integration.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractCandidates } from '../extractor.js';
import { runVerifierSweep } from '../verifier.js';
import { listFacts } from '../store.js';
import {
  ensureMemoryDirs,
  candidateDir,
  indexPath,
} from '../paths.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => {
  const generateText = vi.fn();
  return { generateText };
});

describe('memory flow integration', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-flow-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('end-to-end: turn → extractor → candidate → verifier → promoted fact → indexed', async () => {
    const { generateText } = await import('ai');
    const mock = generateText as unknown as ReturnType<typeof vi.fn>;

    // First call: extractor returns one candidate
    mock.mockResolvedValueOnce({
      text: JSON.stringify({
        candidates: [
          {
            type: 'feedback',
            name: 'Prefers terse responses',
            description: 'short answers without preamble',
            body: 'User prefers terse responses with no preamble.',
            scopes: ['chat'],
            proposed_action: 'create',
            confidence: 0.9,
          },
        ],
      }),
    });

    // Second call: verifier passes it
    mock.mockResolvedValueOnce({
      text: JSON.stringify({ verdict: 'pass', reason: 'durable preference' }),
    });

    await extractCandidates({
      groupName: 'telegram_main',
      userMessage: 'Be terse from now on, please skip the preamble.',
      agentReply: 'Got it, I will keep replies short.',
    });

    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'))).toHaveLength(1);

    await runVerifierSweep();

    const facts = listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].slug).toBe('feedback_prefers_terse_responses');
    expect(facts[0].frontmatter.count).toBe(1);
    expect(facts[0].frontmatter.sources).toEqual({ telegram_main: 1 });

    const index = fs.readFileSync(indexPath(), 'utf8');
    expect(index).toContain('Prefers terse responses');
    expect(index).toContain('feedback_prefers_terse_responses.md');

    expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'))).toHaveLength(0);
  });

  it('reinforcement from a second group merges and updates count + sources', async () => {
    const { generateText } = await import('ai');
    const mock = generateText as unknown as ReturnType<typeof vi.fn>;

    // Round 1
    mock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          candidates: [
            {
              type: 'feedback',
              name: 'Prefers terse responses',
              description: 'd',
              body: 'User prefers terse.',
              proposed_action: 'create',
              confidence: 0.9,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ verdict: 'pass', reason: 'r' }),
      });

    await extractCandidates({
      groupName: 'telegram_main',
      userMessage: 'be terse from now on',
      agentReply: 'OK',
    });
    await runVerifierSweep();

    // Round 2: same fact name, different group, propose merge by name collision
    mock
      .mockResolvedValueOnce({
        text: JSON.stringify({
          candidates: [
            {
              type: 'feedback',
              name: 'Prefers terse responses',
              description: 'd',
              body: 'Reinforced — short answers preferred.',
              proposed_action: 'create',
              confidence: 0.85,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ verdict: 'pass', reason: 'r' }),
      });

    await extractCandidates({
      groupName: 'whatsapp_personal',
      userMessage: 'please keep it short going forward',
      agentReply: 'Will do.',
    });
    await runVerifierSweep();

    const facts = listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].frontmatter.count).toBe(2);
    expect(facts[0].frontmatter.sources).toEqual({
      telegram_main: 1,
      whatsapp_personal: 1,
    });
    expect(facts[0].body).toContain('Reinforced');
    expect(facts[0].frontmatter.history?.[0]).toContain('User prefers terse.');
  });
});
