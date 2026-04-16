import { describe, it, expect } from 'vitest';
import { normalizeConfidenceMarkers, addConfidenceMarkers } from './router.js';

describe('normalizeConfidenceMarkers', () => {
  it('passes markers through unchanged in rich-text mode', () => {
    const text =
      '✓ Verified: your refill is ready (source: browser)\n~ Unverified: Thursday appointment (source: memory)';
    expect(normalizeConfidenceMarkers(text, false)).toBe(text);
  });

  it('maps markers to text labels in plain-text mode', () => {
    const input = '✓ Verified: done\n~ Unverified: maybe\n? Unknown: unclear';
    const output = normalizeConfidenceMarkers(input, true);
    expect(output).toContain('[confirmed]');
    expect(output).toContain('[from memory]');
    expect(output).toContain('[uncertain]');
  });

  it('defaults to rich-text mode when plainText is omitted', () => {
    const text = '✓ Verified: fact (source: tool)';
    expect(normalizeConfidenceMarkers(text)).toBe(text);
  });

  it('leaves text without markers unchanged', () => {
    const text = 'Hello, how are you?';
    expect(normalizeConfidenceMarkers(text, true)).toBe(text);
    expect(normalizeConfidenceMarkers(text, false)).toBe(text);
  });
});

describe('confidence markers', () => {
  it('annotates verified claims with source', () => {
    const formatted = addConfidenceMarkers('Your refill is ready.', [
      {
        claim: 'refill is ready',
        confidence: 'verified',
        source: 'alto.com check, 2min ago',
      },
    ]);
    expect(formatted).toContain('✓');
    expect(formatted).toContain('alto.com');
  });

  it('passes through text with no claims to annotate', () => {
    const formatted = addConfidenceMarkers('Hello, how can I help?', []);
    expect(formatted).toBe('Hello, how can I help?');
  });
});
