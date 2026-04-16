import { describe, it, expect } from 'vitest';
import {
  normalizeConfidenceMarkers,
  addConfidenceMarkers,
  classifyAndFormat,
} from './router.js';

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

describe('classifyAndFormat', () => {
  it('classifies and formats a financial message', () => {
    const result = classifyAndFormat(
      'Chase — 2 incoming wires. Total: $54,900. Were both expected?',
    );
    expect(result.meta.category).toBe('financial');
    expect(result.text).toContain('💰');
    expect(result.meta.actions.length).toBeGreaterThan(0); // question detected
    expect(result.meta.questionType).toBe('financial-confirm');
  });

  it('classifies and formats an auto-handled message', () => {
    const result = classifyAndFormat(
      'Motley Fool newsletter — AUTO, no action.',
    );
    expect(result.meta.category).toBe('auto-handled');
    expect(result.meta.batchable).toBe(true);
    expect(result.text).toContain('Auto-handled');
  });

  it('attaches yes/no buttons to questions', () => {
    const result = classifyAndFormat(
      "Want me to reply yes to Florian's exception?",
    );
    expect(result.meta.questionType).toBe('yes-no');
    expect(result.meta.actions).toHaveLength(3);
  });

  it('passes through non-question messages without buttons', () => {
    const result = classifyAndFormat(
      'Dmitrii acknowledged request #WANF-864. No action needed.',
    );
    expect(result.meta.questionType).toBeUndefined();
    expect(result.meta.actions).toHaveLength(0);
  });
});
