// src/memory/shared/__tests__/extractor.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractCandidates, isTrivialTurn } from '../extractor.js';
import { ensureMemoryDirs, candidateDir } from '../paths.js';

vi.mock('../../../llm/utility.js', () => ({
  resolveUtilityModel: vi.fn(() => ({ id: 'mock' })),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

describe('extractor', () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-ext-'));
    process.env.NANOCLAW_MEMORY_DIR = dir;
    ensureMemoryDirs();
    vi.clearAllMocks();
  });

  it('skips trivial turns', () => {
    expect(isTrivialTurn('hi', 'hello!')).toBe(true);
    expect(isTrivialTurn('thanks', 'np')).toBe(true);
  });

  it('does not skip substantive turns', () => {
    expect(
      isTrivialTurn(
        'I prefer short answers, please be terse from now on',
        'Got it, I will be terse.',
      ),
    ).toBe(false);
  });

  it('writes candidate files when LLM returns candidates', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          {
            type: 'feedback',
            name: 'Prefers terse',
            description: 'd',
            body: 'User prefers terse.',
            scopes: ['chat'],
            proposed_action: 'create',
            confidence: 0.9,
          },
        ],
      }),
    });
    await extractCandidates({
      groupName: 'telegram_main',
      userMessage:
        'Please be terse and concise from now on in all your replies to me',
      agentReply:
        'Understood, I will keep all my replies short and to the point going forward.',
    });
    const files = fs
      .readdirSync(candidateDir())
      .filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/telegram_main/);
    const raw = fs.readFileSync(path.join(candidateDir(), files[0]), 'utf8');
    expect(raw).toContain('Prefers terse');
    expect(raw).toContain('candidate: true');
  });

  it('writes nothing when LLM returns empty candidates', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
    });
    await extractCandidates({
      groupName: 'tg',
      userMessage: 'random question',
      agentReply: 'random answer',
    });
    expect(
      fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')),
    ).toHaveLength(0);
  });

  it('skips malformed candidate objects without throwing', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        candidates: [
          { name: null, body: null }, // malformed
          {
            type: 'feedback',
            name: 'Valid one',
            description: 'd',
            body: 'b',
            proposed_action: 'create',
            confidence: 0.8,
          },
        ],
      }),
    });
    await extractCandidates({
      groupName: 'tg',
      userMessage:
        'this is a substantive turn that exceeds the trivial threshold easily',
      agentReply:
        'OK substantive reply also long enough to skip trivial filtering rules',
    });
    const files = fs
      .readdirSync(candidateDir())
      .filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1); // only the valid one
  });

  it('does not throw on malformed LLM output (fail closed)', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: 'not json at all',
    });
    await expect(
      extractCandidates({
        groupName: 'tg',
        userMessage:
          'I have a substantive question that exceeds trivial thresholds',
        agentReply:
          'Here is a detailed and substantive reply that also exceeds the threshold',
      }),
    ).resolves.toBeUndefined();
  });

  it('respects NANOCLAW_MEMORY_EXTRACT_GROUPS allowlist (group not in list → skip)', async () => {
    const { generateText } = await import('ai');
    const mock = generateText as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();
    process.env.NANOCLAW_MEMORY_EXTRACT_GROUPS = 'telegram_main, test-group';
    try {
      await extractCandidates({
        groupName: 'whatsapp_main',
        userMessage:
          'A substantial message that easily clears the trivial-turn skip threshold.',
        agentReply: 'A substantial reply that also clears the threshold easily here.',
      });
      expect(mock).not.toHaveBeenCalled();
      expect(fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md'))).toHaveLength(0);
    } finally {
      delete process.env.NANOCLAW_MEMORY_EXTRACT_GROUPS;
    }
  });

  it('respects NANOCLAW_MEMORY_EXTRACT_GROUPS allowlist (group in list → proceed)', async () => {
    const { generateText } = await import('ai');
    (generateText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({ candidates: [] }),
    });
    process.env.NANOCLAW_MEMORY_EXTRACT_GROUPS = 'telegram_main, test-group';
    try {
      await extractCandidates({
        groupName: 'telegram_main',
        userMessage:
          'A substantial message that easily clears the trivial-turn skip threshold.',
        agentReply: 'A substantial reply that also clears the threshold easily here.',
      });
      const { generateText: g } = await import('ai');
      expect(g).toHaveBeenCalled();
    } finally {
      delete process.env.NANOCLAW_MEMORY_EXTRACT_GROUPS;
    }
  });

  it('extractCandidates skips trivial turns without calling the LLM', async () => {
    const { generateText } = await import('ai');
    const mock = generateText as unknown as ReturnType<typeof vi.fn>;
    mock.mockClear();
    await extractCandidates({
      groupName: 'tg',
      userMessage: 'hi',
      agentReply: 'hello!',
    });
    expect(mock).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(candidateDir()).filter((f) => f.endsWith('.md')),
    ).toHaveLength(0);
  });
});
