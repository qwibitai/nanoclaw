import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../triage/examples.js', () => ({
  getRecentExamples: vi.fn(() => []),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

import { buildPrompt } from '../triage/prompt-builder.js';

describe('buildPrompt', () => {
  it('returns stable + variable sections with cache breakpoints', () => {
    const out = buildPrompt({
      emailBody: 'Hello, please review PR #42',
      sender: 'alice@example.com',
      subject: 'PR review',
      superpilotLabel: 'needs-attention',
      threadId: 't1',
      account: 'me@gmail.com',
    });

    expect(out.system).toMatch(/output schema/i);
    expect(out.systemBlocks.length).toBeGreaterThanOrEqual(2);
    const cacheable = out.systemBlocks.filter(
      (b) => b.cache_control !== undefined,
    );
    expect(cacheable.length).toBeGreaterThanOrEqual(1);

    expect(out.userMessage).toContain('alice@example.com');
    expect(out.userMessage).toContain('Hello, please review PR #42');
  });

  it('includes the triage rules file when it exists', () => {
    const out = buildPrompt({
      emailBody: 'x',
      sender: 's',
      subject: 'y',
      superpilotLabel: null,
      threadId: 't',
      account: 'a',
    });
    const combined = out.systemBlocks.map((b) => b.text).join('\n');
    expect(combined).toMatch(/Never auto-archive|triage_rules/i);
  });
});
