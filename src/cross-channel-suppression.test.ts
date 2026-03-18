import { describe, it, expect } from 'vitest';
import { stripInternalTags, formatOutbound } from './router.js';
import { shouldSuppressOutput } from './task-scheduler.js';

describe('cross-channel-digest output suppression', () => {
  it('stripInternalTags removes <internal>done</internal>', () => {
    const result = stripInternalTags('<internal>done</internal>');
    expect(result).toBe('');
  });

  it('formatOutbound returns empty for internal-only output', () => {
    const result = formatOutbound('<internal>done</internal>');
    expect(result).toBe('');
  });

  it('shouldSuppressOutput suppresses the empty result', () => {
    const afterStrip = stripInternalTags('<internal>done</internal>');
    expect(shouldSuppressOutput(afterStrip)).toBe(true);
  });
});
