import { describe, it, expect } from 'vitest';
import { parseStepFromNarration, buildProcedure } from './teach-mode.js';

describe('teach-mode', () => {
  it('parses "Go to alto.com" as navigate', () => {
    const step = parseStepFromNarration('Go to alto.com');
    expect(step).not.toBeNull();
    expect(step!.action).toBe('navigate');
    expect(step!.target).toBe('alto.com');
  });

  it('parses "Click Medications tab" as click', () => {
    const step = parseStepFromNarration('Click Medications tab');
    expect(step).not.toBeNull();
    expect(step!.action).toBe('click');
    expect(step!.target).toBe('Medications tab');
  });

  it('parses "Find Lisinopril" as find', () => {
    const step = parseStepFromNarration('Find Lisinopril');
    expect(step).not.toBeNull();
    expect(step!.action).toBe('find');
    expect(step!.target).toBe('Lisinopril');
  });

  it('returns null for unrecognized narration', () => {
    const step = parseStepFromNarration('Hmm let me think');
    expect(step).toBeNull();
  });

  it('builds procedure with correct structure', () => {
    const steps = [
      { action: 'navigate' as const, target: 'alto.com', description: 'Go to alto.com' },
      { action: 'click' as const, target: 'Medications', description: 'Click Medications' },
    ];
    const proc = buildProcedure('reorder Alto refill', steps, 'telegram_main');
    expect(proc.name).toBe('reorder_alto_refill');
    expect(proc.trigger).toContain('reorder Alto refill');
    expect(proc.acquisition).toBe('teach');
    expect(proc.steps).toHaveLength(2);
  });
});
