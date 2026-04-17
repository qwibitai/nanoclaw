import { describe, expect, it } from 'vitest';

import { buildLocationPrefix } from './live-location.js';

describe('buildLocationPrefix', () => {
  it('includes all fields when provided', () => {
    const result = buildLocationPrefix(
      '[Live location sharing start]',
      35.6762,
      139.6503,
      '/path/to/log.log',
      10.5,
      180,
    );
    expect(result).toBe(
      '[Live location sharing start] lat: 35.6762, long: 139.6503, horizontal_accuracy: 10.5, heading: 180. check `tail /path/to/log.log`',
    );
  });

  it('omits optional fields when absent', () => {
    const result = buildLocationPrefix(
      '[Live location sharing enabled]',
      35.6762,
      139.6503,
      '/path/to/log.log',
    );
    expect(result).toBe(
      '[Live location sharing enabled] lat: 35.6762, long: 139.6503. check `tail /path/to/log.log`',
    );
  });

  it('includes only horizontal_accuracy when heading is absent', () => {
    const result = buildLocationPrefix(
      '[Live location sharing enabled]',
      1,
      2,
      '/log',
      50,
      undefined,
    );
    expect(result).toContain('horizontal_accuracy: 50');
    expect(result).not.toContain('heading');
  });

  it('includes only heading when horizontal_accuracy is absent', () => {
    const result = buildLocationPrefix(
      '[Live location sharing enabled]',
      1,
      2,
      '/log',
      undefined,
      90,
    );
    expect(result).toContain('heading: 90');
    expect(result).not.toContain('horizontal_accuracy');
  });
});
