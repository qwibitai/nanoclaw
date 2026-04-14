import { describe, it, expect } from 'vitest';
import { normalizeConfidenceMarkers } from './router.js';

describe('normalizeConfidenceMarkers', () => {
  it('passes markers through unchanged in rich-text mode', () => {
    const text = '✓ Verified: your refill is ready (source: browser)\n~ Unverified: Thursday appointment (source: memory)';
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
