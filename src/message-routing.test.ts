import { describe, expect, it } from 'vitest';

import {
  MessageRoutingConfig,
  resolveMessageRoutingModel,
} from './message-routing.js';

const config: MessageRoutingConfig = {
  rules: [
    { match: ['code review', 'PR', 'diff', 'refactor'], model: 'model-a' },
    { match: ['research', 'search', 'find'], model: 'model-b' },
  ],
  default: 'model-default',
};

describe('resolveMessageRoutingModel', () => {
  it('matches first rule on keyword hit', () => {
    expect(resolveMessageRoutingModel(config, 'Please do a code review')).toBe(
      'model-a',
    );
  });

  it('matches second rule when first does not match', () => {
    expect(
      resolveMessageRoutingModel(config, 'Can you research this topic?'),
    ).toBe('model-b');
  });

  it('is case-insensitive', () => {
    expect(resolveMessageRoutingModel(config, 'DIFF this file')).toBe(
      'model-a',
    );
  });

  it('returns default when no rule matches', () => {
    expect(
      resolveMessageRoutingModel(config, 'Hello, how are you?'),
    ).toBe('model-default');
  });

  it('returns undefined when no rule matches and no default', () => {
    const cfg: MessageRoutingConfig = { rules: config.rules };
    expect(resolveMessageRoutingModel(cfg, 'Hello!')).toBeUndefined();
  });

  it('first-match-wins on overlapping keywords', () => {
    // "PR" could overlap with many topics; first rule should win
    expect(resolveMessageRoutingModel(config, 'search for a PR')).toBe(
      'model-a',
    );
  });
});
