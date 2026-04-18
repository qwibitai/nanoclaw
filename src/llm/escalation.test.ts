import { describe, it, expect } from 'vitest';
import { scoreComplexity } from './escalation.js';

describe('scoreComplexity', () => {
  it('returns low score for simple messages', () => {
    const result = scoreComplexity('hello');
    expect(result.shouldEscalate).toBe(false);
    expect(result.score).toBeLessThan(5);
  });

  it('returns low score for short questions', () => {
    const result = scoreComplexity('what time is it?');
    expect(result.shouldEscalate).toBe(false);
  });

  it('escalates messages with code blocks and technical keywords', () => {
    const msg = `Can you debug this function?
\`\`\`typescript
function broken() {
  return undefined;
}
\`\`\`
It should return a string but it returns undefined. Fix the security vulnerability too.`;
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(5);
    expect(result.reason).toBeDefined();
  });

  it('escalates very long messages', () => {
    const msg = 'a'.repeat(2100);
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
  });

  it('escalates multi-question messages', () => {
    const msg = 'What is X? How does Y work? Can you explain Z? What about W?';
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
  });

  it('does not escalate single code block without other signals', () => {
    const msg = '```\nconst x = 1;\n```';
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(false);
    expect(result.score).toBe(3);
  });

  it('escalates messages with multiple file references and code keywords', () => {
    const msg =
      'Refactor src/index.ts, src/config.ts, src/types.ts to use the new import pattern';
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
  });

  it('includes reasons when escalating', () => {
    const msg = `\`\`\`typescript
function debug() {}
\`\`\`
Can you debug this? And fix the security issue? Also analyze the trade-off?`;
    const result = scoreComplexity(msg);
    expect(result.shouldEscalate).toBe(true);
    expect(result.reason).toContain('code block');
  });
});
