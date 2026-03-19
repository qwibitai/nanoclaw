import { describe, it, expect } from 'vitest';

import { buildPrFeedbackPrompt, parsePrUrl } from './pr-watcher.js';

describe('parsePrUrl', () => {
  it('parses a GitHub PR URL', () => {
    const result = parsePrUrl('https://github.com/owner/repo/pull/42');
    expect(result).toEqual({ repo: 'owner/repo', pr_number: 42 });
  });

  it('returns null for non-PR URLs', () => {
    expect(parsePrUrl('https://github.com/owner/repo')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });

  it('handles trailing slashes and fragments', () => {
    const result = parsePrUrl(
      'https://github.com/owner/repo/pull/42/files#diff',
    );
    expect(result).toEqual({ repo: 'owner/repo', pr_number: 42 });
  });
});

describe('buildPrFeedbackPrompt', () => {
  it('builds XML prompt with review comments', () => {
    const prompt = buildPrFeedbackPrompt({
      repo: 'owner/repo',
      pr_number: 42,
      branch: 'feature-x',
      url: 'https://github.com/owner/repo/pull/42',
      comments: [
        {
          id: 123,
          file: 'src/foo.ts',
          line: 10,
          author: 'reviewer',
          body: 'Fix this',
        },
      ],
      timezone: 'UTC',
    });

    expect(prompt).toContain('<pr repo="owner/repo"');
    expect(prompt).toContain('number="42"');
    expect(prompt).toContain('Fix this');
    expect(prompt).toContain('reviewer');
  });
});
