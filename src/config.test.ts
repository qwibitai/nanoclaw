import { describe, it, expect } from 'vitest';

import { COALESCE_MS, MAX_DOWNLOAD_WAIT_MS } from './config.js';

describe('coalescing config', () => {
  it('COALESCE_MS defaults to 500', () => {
    expect(COALESCE_MS).toBe(500);
  });

  it('MAX_DOWNLOAD_WAIT_MS defaults to 60000', () => {
    expect(MAX_DOWNLOAD_WAIT_MS).toBe(60000);
  });
});
