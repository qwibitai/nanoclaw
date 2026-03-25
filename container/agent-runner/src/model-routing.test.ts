import { describe, it, expect } from 'vitest';
import { routeModel } from './model-routing.js';

describe('Model Routing', () => {
  it('returns Opus model when [OPUS] flag is present', () => {
    const result = routeModel('[OPUS] Analyze this complex problem');
    expect(result.model).toBe('claude-opus-4-6-20260301');
    expect(result.prompt).toBe('Analyze this complex problem');
  });

  it('returns undefined model for normal prompts (uses default Sonnet)', () => {
    const result = routeModel('Hello, what time is it?');
    expect(result.model).toBeUndefined();
    expect(result.prompt).toBe('Hello, what time is it?');
  });

  it('strips the flag from the prompt text', () => {
    const result = routeModel('[OPUS] Do something');
    expect(result.prompt).not.toContain('[OPUS]');
  });

  it('handles [OPUS] with leading whitespace', () => {
    const result = routeModel('  [OPUS] Think deeply');
    expect(result.model).toBe('claude-opus-4-6-20260301');
    expect(result.prompt).toBe('Think deeply');
  });

  it('does not match [OPUS] in the middle of text', () => {
    const result = routeModel('Please use [OPUS] for this');
    expect(result.model).toBeUndefined();
    expect(result.prompt).toBe('Please use [OPUS] for this');
  });

  it('preserves original prompt when no flag', () => {
    const original = 'Tell me about the weather\nwith multiple lines';
    const result = routeModel(original);
    expect(result.prompt).toBe(original);
  });

  it('handles empty prompt', () => {
    const result = routeModel('');
    expect(result.model).toBeUndefined();
    expect(result.prompt).toBe('');
  });

  it('handles [OPUS] with no subsequent text', () => {
    const result = routeModel('[OPUS]');
    expect(result.model).toBe('claude-opus-4-6-20260301');
    expect(result.prompt).toBe('');
  });
});
